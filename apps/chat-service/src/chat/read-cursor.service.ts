import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { buildRedisUrl } from '@crm/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Курсоры прочтения: мгновенно в Redis, долговременно — в PostgreSQL.
 * docs/architecture.md §8.2
 *
 * Курсор двигается на каждую прокрутку списка сообщений. Писать строку в
 * базу на каждое движение — это запись ради значения, которое через
 * секунду сменится следующим. Поэтому отметка кладётся в Redis сразу
 * (счётчик непрочитанного обязан обновиться в тот же момент, иначе
 * прочитанный канал остаётся подсвеченным), а в базу уходит пачкой раз в
 * десять секунд.
 *
 * Цена — при потере Redis теряются последние секунды движения курсора, и
 * несколько сообщений снова окажутся непрочитанными. Ошибка в эту сторону
 * безобидна: человек увидит лишний бейдж. Обратная — пропавшее сообщение,
 * которое никто не откроет.
 */
@Injectable()
export class ReadCursorService implements OnApplicationShutdown {
  private static readonly FLUSH_INTERVAL_MS = 10_000;
  /** Сколько пользователей выгружается за один заход. */
  private static readonly FLUSH_BATCH = 200;

  private readonly logger = new Logger(ReadCursorService.name);
  private readonly redis: Redis;
  private flusher?: NodeJS.Timeout;
  private redisUsable = true;

  constructor(private readonly prisma: PrismaService) {
    this.redis = new Redis(buildRedisUrl(), {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: false,
    });

    this.redis.on('error', (error: Error) => {
      if (this.redisUsable) {
        this.logger.warn({
          message: 'Redis недоступен, курсоры пишутся напрямую в базу',
          error: error.message,
        });
      }
      this.redisUsable = false;
    });
    this.redis.on('ready', () => {
      this.redisUsable = true;
    });

    this.flusher = setInterval(() => void this.flush(), ReadCursorService.FLUSH_INTERVAL_MS);
    this.flusher.unref();
  }

  /**
   * Сдвинуть курсор до указанного номера.
   *
   * Только вперёд. Клиент может прислать меньшее значение, вернувшись к
   * началу истории, и откат курсора превратил бы прочитанное в
   * непрочитанное — сравнение делает Redis внутри скрипта, потому что
   * «прочитать и записать, если больше» двумя командами оставляет окно
   * для второй вкладки того же пользователя.
   */
  async mark(channelId: string, employeeId: string, upToSeq: number): Promise<void> {
    if (upToSeq <= 0) return;

    if (this.redisUsable) {
      try {
        await this.redis.eval(
          `local cur = redis.call('hget', KEYS[1], ARGV[1])
           if cur == false or tonumber(cur) < tonumber(ARGV[2]) then
             redis.call('hset', KEYS[1], ARGV[1], ARGV[2])
             redis.call('sadd', KEYS[2], ARGV[3])
             return 1
           end
           return 0`,
          2,
          cursorKey(employeeId),
          DIRTY_KEY,
          channelId,
          String(upToSeq),
          employeeId,
        );
        return;
      } catch (error) {
        this.logger.warn({
          message: 'не удалось записать курсор в Redis, пишем в базу',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.persist(employeeId, [[channelId, upToSeq]]);
  }

  /**
   * Счётчики непрочитанного по всем каналам сотрудника.
   *
   * Считаются сообщения, а не разность номеров: удалённые и собственные
   * из подсчёта выпадают, а разность `lastMessageSeq − курсор` посчитала
   * бы и их. Один запрос на все каналы — раскладка курсоров передаётся в
   * него массивами и соединяется через unnest, иначе на человека с
   * тридцатью каналами пришлось бы тридцать запросов.
   */
  async counters(employeeId: string): Promise<{
    items: { channelId: string; unread: number; mentions: number }[];
    total: number;
  }> {
    const memberships = await this.prisma.channelMember.findMany({
      where: { employeeId, channel: { archived: false } },
      select: { channelId: true },
    });
    if (memberships.length === 0) return { items: [], total: 0 };

    const channelIds = memberships.map((item) => item.channelId);
    const cursors = await this.resolveCursors(employeeId, channelIds);

    const rows = await this.prisma.$queryRaw<
      { channelId: string; unread: number; mentions: number }[]
    >`
      SELECT m.channel_id AS "channelId",
             count(*)::int AS unread,
             count(*) FILTER (WHERE ${employeeId}::text = ANY(m.mentions))::int AS mentions
        FROM messages m
        JOIN unnest(${channelIds}::uuid[], ${channelIds.map((id) => cursors.get(id) ?? 0)}::int[])
             AS c(channel_id, cursor_seq)
          ON c.channel_id = m.channel_id
       WHERE m.seq > c.cursor_seq
         AND m.deleted = false
         AND (m.author_employee_id IS NULL OR m.author_employee_id <> ${employeeId}::uuid)
       GROUP BY m.channel_id
    `;

    const items = rows.filter((row) => row.unread > 0);
    return { items, total: items.reduce((sum, row) => sum + row.unread, 0) };
  }

  /** Курсор по одному каналу — для выдачи канала клиенту. */
  async cursorFor(employeeId: string, channelIds: string[]): Promise<Map<string, number>> {
    return this.resolveCursors(employeeId, channelIds);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.flusher) clearInterval(this.flusher);
    // Последняя выгрузка перед остановкой: иначе движение курсора за
    // последние десять секунд работы пропало бы при штатном перезапуске,
    // а это самый частый случай из всех.
    await this.flush().catch(() => undefined);
    await this.redis.quit().catch(() => undefined);
  }

  /**
   * Актуальный курсор — максимум из базы и Redis.
   *
   * База отстаёт на время между выгрузками, Redis может не содержать
   * канала вовсе (курсор выгружен и ключ пережил перезапуск не полностью).
   * Максимум из двух источников верен в обоих случаях, потому что курсор
   * движется только вперёд.
   */
  private async resolveCursors(
    employeeId: string,
    channelIds: string[],
  ): Promise<Map<string, number>> {
    const stored = await this.prisma.readCursor.findMany({
      where: { employeeId, channelId: { in: channelIds } },
      select: { channelId: true, lastReadSeq: true },
    });
    const result = new Map(stored.map((row) => [row.channelId, row.lastReadSeq]));

    if (!this.redisUsable) return result;
    try {
      const buffered = await this.redis.hgetall(cursorKey(employeeId));
      for (const [channelId, value] of Object.entries(buffered)) {
        const seq = Number(value);
        if (Number.isFinite(seq) && seq > (result.get(channelId) ?? 0)) {
          result.set(channelId, seq);
        }
      }
    } catch {
      // Отставший курсор из базы — приемлемая деградация: несколько
      // сообщений покажутся непрочитанными второй раз.
    }
    return result;
  }

  /**
   * Выгрузка накопленного в базу.
   *
   * Пользователи забираются из множества через SPOP — атомарно, вместе с
   * удалением. Если отметка придёт после чтения хэша, SADD вернёт человека
   * в множество, и следующая выгрузка заберёт новое значение. Обратный
   * порядок (прочитать, записать, очистить) терял бы отметки, пришедшие
   * между чтением и очисткой.
   */
  private async flush(): Promise<void> {
    if (!this.redisUsable) return;

    let employeeIds: string[];
    try {
      employeeIds = await this.redis.spop(DIRTY_KEY, ReadCursorService.FLUSH_BATCH);
    } catch {
      return;
    }
    if (employeeIds.length === 0) return;

    for (const employeeId of employeeIds) {
      try {
        const buffered = await this.redis.hgetall(cursorKey(employeeId));
        const pairs = Object.entries(buffered)
          .map(([channelId, value]) => [channelId, Number(value)] as [string, number])
          .filter(([, seq]) => Number.isFinite(seq) && seq > 0);
        if (pairs.length > 0) await this.persist(employeeId, pairs);
      } catch (error) {
        // Человек возвращается в очередь: потерять его значило бы навсегда
        // оставить курсор в Redis и потерять его при первом же сбое.
        await this.redis.sadd(DIRTY_KEY, employeeId).catch(() => undefined);
        this.logger.warn({
          message: 'не удалось выгрузить курсоры',
          employeeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.debug({ message: 'курсоры выгружены', employees: employeeIds.length });
  }

  /**
   * Запись пачки курсоров.
   *
   * Сырой запрос, а не upsert из Prisma, по двум причинам, каждой из
   * которых хватило бы отдельно.
   *
   * GREATEST в ON CONFLICT: курсор обязан двигаться только вперёд и в
   * базе тоже. Задержавшаяся выгрузка может прийти после следующей и
   * записать более старое значение — прочитанный канал снова стал бы
   * непрочитанным. Условие в UPDATE выражается только так: у Prisma нет
   * способа сказать «обнови, если больше».
   *
   * JOIN с channels: канал мог исчезнуть, пока отметка лежала в Redis.
   * Вставка по внешнему ключу упала бы, весь заход выгрузки откатился бы,
   * человек вернулся бы в очередь — и так до бесконечности, на каждом
   * заходе. Соединение молча отбрасывает курсоры несуществующих каналов.
   */
  private async persist(employeeId: string, pairs: [string, number][]): Promise<void> {
    const channelIds = pairs.map(([channelId]) => channelId);
    const seqs = pairs.map(([, seq]) => seq);

    await this.prisma.$executeRaw`
      INSERT INTO read_cursors (channel_id, employee_id, last_read_seq, updated_at)
      SELECT c.channel_id, ${employeeId}::uuid, c.seq, now()
        FROM unnest(${channelIds}::uuid[], ${seqs}::int[]) AS c(channel_id, seq)
        JOIN channels ch ON ch.id = c.channel_id
      ON CONFLICT (channel_id, employee_id) DO UPDATE
         SET last_read_seq = GREATEST(read_cursors.last_read_seq, EXCLUDED.last_read_seq),
             updated_at = now()
    `;
  }
}

const DIRTY_KEY = 'chat:read:dirty';

function cursorKey(employeeId: string): string {
  return `chat:read:${employeeId}`;
}
