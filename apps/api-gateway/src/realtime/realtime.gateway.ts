import { Logger, OnApplicationShutdown } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { status } from '@grpc/grpc-js';
import type { Server, Socket } from 'socket.io';
import { AuthClient } from '../clients/auth.client';
import { TaskClient } from '../clients/task.client';
import { TokenResolver } from '../auth/token-resolver';
import type { AuthenticatedUser } from '../auth/auth.guard';
import { EphemeralBus, type EphemeralSignal } from './ephemeral.bus';
import { PresenceService } from './presence.service';
import {
  MAX_ROOMS_PER_SOCKET,
  Rooms,
  accessRuleFor,
  personalRooms,
  type MembershipAuthority,
} from './rooms';

/**
 * Единое WebSocket-соединение клиента. docs/architecture.md §8.1
 *
 * Клиент держит ОДНО соединение и получает через него всё: обновления
 * Kanban, сообщения чата, движение заявок, счётчик уведомлений. Доменные
 * сервисы о WebSocket не знают: они публикуют события в RabbitMQ, а
 * раскладывает их по соединениям только gateway.
 *
 * АДАПТЕР ОСТАЁТСЯ ВСТРОЕННЫМ. У Socket.IO есть адаптер поверх Redis,
 * который размножает emit между инстансами, — и подключать его здесь
 * НЕЛЬЗЯ. Размножением уже занимается RabbitMQ: очередь gateway.realtime
 * объявлена perInstance, поэтому копию события получает каждый инстанс и
 * рассылает её своим сокетам. С адаптером поверх этого каждое событие
 * прошло бы оба механизма и пришло клиенту N раз при N инстансах.
 *
 * Имя события Socket.IO совпадает с routing key: клиент подписывается на
 * `task.card.moved` и получает ровно его. Отдельная обёртка вида
 * {type, payload} потребовала бы от клиента разбирать каждое сообщение
 * вручную, теряя штатную маршрутизацию библиотеки.
 */
@WebSocketGateway({
  path: '/ws',
  // Раздавать клиентскую библиотеку с сервера незачем: фронтенд собирает
  // её сам, а лишний открытый маршрут — лишняя поверхность.
  serveClient: false,
  // Браузер ходит через тот же nginx, что и REST, поэтому источник
  // совпадает. Значение вынесено в переменную окружения на случай, когда
  // фронтенд поднят отдельно при разработке.
  cors: { origin: process.env.WS_CORS_ORIGIN ?? false, credentials: true },
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnApplicationShutdown
{
  /** Как часто проверять, не истёк ли токен открытого соединения. */
  private static readonly TOKEN_SWEEP_MS = 30_000;
  /** Не чаще одного сигнала «печатает» в секунду с одного соединения. */
  private static readonly TYPING_INTERVAL_MS = 1_000;

  private readonly logger = new Logger(RealtimeGateway.name);
  private sweeper?: NodeJS.Timeout;

  @WebSocketServer()
  private readonly server!: Server;

  constructor(
    private readonly tokens: TokenResolver,
    private readonly auth: AuthClient,
    private readonly tasks: TaskClient,
    private readonly presence: PresenceService,
    private readonly bus: EphemeralBus,
  ) {}

  afterInit(): void {
    this.bus.onSignal((signal) => this.relay(signal));

    this.sweeper = setInterval(() => this.disconnectExpired(), RealtimeGateway.TOKEN_SWEEP_MS);
    this.sweeper.unref();

    this.logger.log({ message: 'WebSocket-шлюз готов', path: '/ws' });
  }

  onApplicationShutdown(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  // ── Жизненный цикл соединения ───────────────────────────────────────────

  /**
   * Рукопожатие. Токен предъявляется один раз, соединение живёт часами.
   *
   * Поэтому здесь запоминается момент истечения claims: без него сокет,
   * открытый с валидным токеном, продолжал бы получать события и через
   * сутки после того, как REST для того же пользователя отвечает 401.
   */
  async handleConnection(socket: Socket): Promise<void> {
    const token = extractToken(socket);
    if (!token) {
      return this.reject(socket, 'unauthorized', 'токен не передан');
    }

    let user: AuthenticatedUser;
    let expiresAt: number;
    try {
      const claims = await this.tokens.resolve(token);
      user = {
        userId: claims.user_id,
        employeeId: claims.employee_id || undefined,
        roles: claims.roles ?? [],
        isManager: claims.is_manager ?? false,
      };
      // int64 из proto приезжает строкой, а не числом. Сравнение строки с
      // числом сработало бы за счёт неявного приведения, но молча дало бы
      // false на любом неожиданном значении — то есть соединение с
      // испорченным claims жило бы вечно. Приводим явно.
      expiresAt = Number(claims.expires_at);
      if (!Number.isFinite(expiresAt)) {
        return this.reject(socket, 'unauthorized', 'в токене нет срока действия');
      }
    } catch {
      return this.reject(socket, 'unauthorized', 'токен недействителен или истёк');
    }

    socket.data.user = user;
    socket.data.expiresAt = expiresAt;

    for (const room of personalRooms(user)) await socket.join(room);
    await this.presence.attach(user, socket.id);

    socket.emit('ready', {
      userId: user.userId,
      employeeId: user.employeeId,
      rooms: personalRooms(user),
      expiresAt,
    });

    this.logger.debug({
      message: 'соединение установлено',
      userId: user.userId,
      socketId: socket.id,
    });
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    const user = socket.data.user as AuthenticatedUser | undefined;
    if (!user) return;

    await this.presence.detach(user, socket.id);
    this.logger.debug({
      message: 'соединение закрыто',
      userId: user.userId,
      socketId: socket.id,
    });
  }

  // ── Сообщения от клиента ────────────────────────────────────────────────

  /**
   * Подписка на комнаты.
   *
   * Право проверяется на КАЖДУЮ комнату отдельно и до входа в неё: иначе
   * достаточно было бы угадать идентификатор чужой доски, чтобы читать её
   * изменения в реальном времени. Отказ по одной комнате не отменяет
   * остальные — клиент получает разбор по каждой.
   */
  @SubscribeMessage('subscribe')
  async subscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<SubscribeResult> {
    const user = socket.data.user as AuthenticatedUser | undefined;
    if (!user) return { ok: false, joined: [], denied: [], error: 'соединение без токена' };

    const requested = readRooms(body);
    if (requested.length === 0) {
      return { ok: false, joined: [], denied: [], error: 'список комнат пуст' };
    }

    const joined: string[] = [];
    const denied: DeniedRoom[] = [];

    for (const room of requested) {
      if (socket.rooms.has(room)) {
        joined.push(room);
        continue;
      }
      if (socket.rooms.size >= MAX_ROOMS_PER_SOCKET) {
        denied.push({ room, reason: 'превышен предел комнат на соединение' });
        continue;
      }

      const verdict = await this.mayJoin(room, user);
      if (verdict.allowed) {
        await socket.join(room);
        joined.push(room);
      } else {
        denied.push({ room, reason: verdict.reason });
      }
    }

    return { ok: denied.length === 0, joined, denied };
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: true; left: string[] }> {
    const user = socket.data.user as AuthenticatedUser | undefined;
    const personal = user ? new Set(personalRooms(user)) : new Set<string>();

    const left: string[] = [];
    for (const room of readRooms(body)) {
      // Из личных комнат выйти нельзя: они — сам смысл соединения, и без
      // них сокет остался бы открытым, но глухим к адресованному лично.
      //
      // Комната с именем самого сокета — служебная, Socket.IO заводит её
      // сам. На ней держится исключение автора из рассылки «печатает»,
      // поэтому выход из неё тоже запрещён.
      if (room === socket.id || personal.has(room) || !socket.rooms.has(room)) continue;
      await socket.leave(room);
      left.push(room);
    }
    return { ok: true, left };
  }

  /**
   * «Пользователь печатает».
   *
   * Единственный сигнал, который клиент отправляет НЕ в RabbitMQ, а в
   * Redis Pub/Sub: он живёт три секунды и обязан теряться при сбое (§5).
   * Подписка на комнату канала обязательна — иначе индикатор можно было бы
   * слать в чужой чат, не имея к нему доступа.
   */
  @SubscribeMessage('typing')
  async typing(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: boolean; error?: string }> {
    const user = socket.data.user as AuthenticatedUser | undefined;
    if (!user) return { ok: false, error: 'соединение без токена' };

    const channelId = readChannelId(body);
    if (!channelId) return { ok: false, error: 'channelId не передан' };
    if (!socket.rooms.has(Rooms.channel(channelId))) {
      return { ok: false, error: 'нет подписки на канал' };
    }

    const now = Date.now();
    const last = (socket.data.lastTypingAt as number | undefined) ?? 0;
    if (now - last < RealtimeGateway.TYPING_INTERVAL_MS) return { ok: true };
    socket.data.lastTypingAt = now;

    await this.bus.publishTyping({
      channelId,
      userId: user.userId,
      employeeId: user.employeeId,
      socketId: socket.id,
    });
    return { ok: true };
  }

  // ── Рассылка ────────────────────────────────────────────────────────────

  /**
   * Отправить событие в комнаты этого инстанса.
   *
   * Сокет, состоящий сразу в нескольких перечисленных комнатах, получит
   * сообщение один раз: Socket.IO считает объединение сокетов, а не сумму
   * комнат. Это и позволяет адресовать сообщение чата одновременно каналу
   * и личным комнатам получателей, не боясь дублей.
   */
  emit(rooms: string[], event: string, data: unknown): void {
    if (rooms.length === 0) return;
    this.server.to(rooms).emit(event, data);
  }

  // ── Внутреннее ──────────────────────────────────────────────────────────

  private async mayJoin(
    room: string,
    user: AuthenticatedUser,
  ): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    const rule = accessRuleFor(room, user);

    if (rule.kind === 'rejected') return { allowed: false, reason: rule.reason };
    if (rule.kind === 'own') {
      return rule.allowed
        ? { allowed: true }
        : { allowed: false, reason: 'чужая личная комната' };
    }
    if (rule.kind === 'membership') return this.mayJoinByMembership(rule, user);

    const resourceId = room.slice(room.indexOf(':') + 1);
    try {
      const decision = await this.auth.checkPermission({
        userId: user.userId,
        resource: rule.resource,
        action: rule.action,
        resourceId,
        ownerId: rule.ownerId,
      });
      return decision.allowed
        ? { allowed: true }
        : { allowed: false, reason: decision.reason || 'недостаточно прав' };
    } catch (error) {
      // Недоступный auth-service означает отказ, а не разрешение: подписка
      // на чужую доску, выданная «на всякий случай», не отзывается до
      // разрыва соединения.
      this.logger.warn({
        message: 'проверка права на комнату не удалась',
        room,
        error: error instanceof Error ? error.message : String(error),
      });
      return { allowed: false, reason: 'проверка прав недоступна' };
    }
  }

  /**
   * Доступ к объекту, состав участников которого ведёт доменный сервис.
   *
   * Вопрос задаётся тем же вызовом, которым пользуется HTTP-обработчик:
   * GetBoardMembers внутри делает assertMember и отвечает PERMISSION_DENIED
   * тому, кто в доске не состоит. Отдельной проверки «а можно ли смотреть
   * доски вообще» здесь не нужно — участник доски по определению имеет с
   * ней дело, а не участник не пройдёт и с ролью администратора отдела.
   *
   * Взят самый лёгкий из подходящих вызовов: GetBoard вернул бы заодно все
   * карточки, а нужен только ответ «да или нет».
   */
  private async mayJoinByMembership(
    rule: { authority: MembershipAuthority; id: string },
    user: AuthenticatedUser,
  ): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    // Пустой employeeId в GetBoardMembers означает «вызов от другого
    // сервиса, доступ проверен на своём уровне», и проверка участия
    // пропускается. Подставить его здесь значило бы открыть любую доску
    // пользователю без карточки сотрудника.
    if (!user.employeeId) {
      return { allowed: false, reason: 'у учётной записи нет карточки сотрудника' };
    }

    if (rule.authority === 'chat') {
      // Состав канала ведёт chat-service, которого ещё нет. Пустить в
      // комнату «пока просто так» нельзя: подписка на чужой канал не
      // отзывается до разрыва соединения, а появление сервиса молча
      // превратило бы её в утечку переписки.
      return { allowed: false, reason: 'каналы чата ещё не реализованы' };
    }

    try {
      await this.tasks.getMembers(rule.id, user.employeeId);
      return { allowed: true };
    } catch (error) {
      return { allowed: false, reason: denialReason(error) };
    }
  }

  /** Ретрансляция эфемерных сигналов из Redis в сокеты этого инстанса. */
  private relay(signal: EphemeralSignal): void {
    const parsed = parseJson(signal.raw);
    if (!parsed) return;

    if (signal.kind === 'typing') {
      const origin = typeof parsed.socketId === 'string' ? parsed.socketId : undefined;
      // Сокет по умолчанию состоит в комнате со своим идентификатором,
      // поэтому исключить автора можно тем же механизмом комнат. На
      // остальных инстансах except() просто не найдёт такой комнаты.
      const target = this.server.to(Rooms.channel(signal.channelId));
      const scoped = origin ? target.except(origin) : target;
      scoped.emit('chat.typing', {
        channelId: signal.channelId,
        userId: parsed.userId,
        employeeId: parsed.employeeId,
      });
      return;
    }

    // Присутствие адресуется по employeeId: комната названа именно так,
    // потому что подписчик спрашивал про сотрудника, а не про учётную
    // запись. У пользователя без карточки сотрудника такой комнаты нет —
    // и наблюдать за ним некому.
    const employeeId = parsed.employeeId;
    if (typeof employeeId !== 'string' || employeeId.length === 0) return;

    this.server.to(Rooms.presence(employeeId)).emit('presence.changed', {
      userId: parsed.userId,
      employeeId,
      online: parsed.online === true,
    });
  }

  /**
   * Разорвать соединения с истёкшим токеном.
   *
   * Клиент обязан переподключиться со свежим access-токеном. Причина
   * передаётся отдельным сообщением до разрыва: по коду закрытия
   * WebSocket отличить протухший токен от сетевого сбоя нельзя, а
   * переподключаться с тем же токеном бессмысленно.
   */
  private disconnectExpired(): void {
    const now = Date.now();
    let closed = 0;

    for (const socket of this.server.sockets.sockets.values()) {
      const expiresAt = socket.data.expiresAt as number | undefined;
      if (!expiresAt || expiresAt > now) continue;

      socket.emit('unauthorized', { reason: 'token_expired' });
      socket.disconnect(true);
      closed += 1;
    }

    // Заодно единственное место, где видно нагрузку на инстанс: сколько
    // соединений он держит и от скольких разных пользователей.
    this.logger.debug({
      message: 'обход соединений',
      closed,
      ...this.presence.stats(),
    });
  }

  private reject(socket: Socket, event: string, reason: string): void {
    socket.emit(event, { reason });
    socket.disconnect(true);
  }
}

interface DeniedRoom {
  room: string;
  reason: string;
}

interface SubscribeResult {
  ok: boolean;
  joined: string[];
  denied: DeniedRoom[];
  error?: string;
}

/**
 * Токен рукопожатия.
 *
 * Порядок источников не случаен. auth — штатный способ Socket.IO, он не
 * попадает в URL. Строка запроса поддержана для клиентов, которые не умеют
 * иначе, но именно она утекает в логи прокси, поэтому идёт второй. Cookie
 * последняя: браузер шлёт её сам, и полагаться на неё как на основной
 * источник значило бы открыть соединение по межсайтовому запросу.
 */
function extractToken(socket: Socket): string | null {
  const fromAuth = (socket.handshake.auth as Record<string, unknown> | undefined)?.token;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;

  const fromQuery = socket.handshake.query?.token;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;

  const cookie = socket.handshake.headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'access_token' && rest.length > 0) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/** Клиент присылает произвольный JSON — принимаем только ожидаемую форму. */
function readRooms(body: unknown): string[] {
  const raw = (body as { rooms?: unknown } | undefined)?.rooms;
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.filter((item): item is string => typeof item === 'string' && item.length <= 128),
    ),
  ].slice(0, MAX_ROOMS_PER_SOCKET);
}

function readChannelId(body: unknown): string | null {
  const raw = (body as { channelId?: unknown } | undefined)?.channelId;
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 64 ? raw : null;
}

/**
 * Причина отказа из ошибки gRPC.
 *
 * PERMISSION_DENIED и NOT_FOUND — осознанные ответы сервиса-владельца, их
 * текст объясняет клиенту, что произошло. Всё остальное — недоступность
 * или сбой, и подробности наружу не идут: клиент всё равно может только
 * повторить подписку позже.
 */
function denialReason(error: unknown): string {
  const code = (error as { code?: number }).code;
  if (code === status.PERMISSION_DENIED || code === status.NOT_FOUND) {
    const detail = (error as { details?: string; message?: string }).details;
    return detail ?? 'доступ к объекту закрыт';
  }
  return 'проверка доступа недоступна';
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
