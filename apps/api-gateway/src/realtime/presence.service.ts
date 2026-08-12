import { hostname } from 'node:os';
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { RedisKeys } from '@crm/contracts';
import { RedisService } from '../cache/redis.service';
import { EphemeralBus } from './ephemeral.bus';
import type { AuthenticatedUser } from '../auth/auth.guard';

/**
 * Кто сейчас за экраном. docs/architecture.md §8.2
 *
 * Отметку ставит gateway, пока держит WS-соединение, а читает
 * notification-service: push об обычном сообщении в чате не нужен тому,
 * у кого оно и так появилось в открытом окне (§7.3). Формат ключа поэтому
 * живёт в общих контрактах — RedisKeys.presence.
 *
 * Ключ живёт по TTL и продлевается, пока соединение открыто. Так упавший
 * инстанс не оставляет пользователя «вечно онлайн»: отметка исчезнет сама
 * через полторы минуты, потому что продлевать её станет некому.
 */
@Injectable()
export class PresenceService implements OnApplicationShutdown {
  /**
   * TTL втрое длиннее периода продления: одно пропущенное обращение к
   * Redis не должно превращать работающего пользователя в офлайн.
   */
  private static readonly TTL_SECONDS = 90;
  private static readonly HEARTBEAT_MS = 30_000;

  private readonly logger = new Logger(PresenceService.name);
  /** В Docker hostname — идентификатор контейнера, то есть инстанса. */
  private readonly instanceId = hostname();
  /** Локальные соединения: userId → множество socketId на ЭТОМ инстансе. */
  private readonly sockets = new Map<string, Set<string>>();
  private heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly redis: RedisService,
    private readonly bus: EphemeralBus,
  ) {}

  /** Соединение открыто. Возвращает true, если пользователь стал онлайн. */
  async attach(user: AuthenticatedUser, socketId: string): Promise<boolean> {
    let bucket = this.sockets.get(user.userId);
    if (!bucket) {
      bucket = new Set();
      this.sockets.set(user.userId, bucket);
    }

    const wasEmpty = bucket.size === 0;
    bucket.add(socketId);
    this.ensureHeartbeat();

    if (!wasEmpty) return false;

    await this.redis.setEx(
      RedisKeys.presence(user.userId),
      this.instanceId,
      PresenceService.TTL_SECONDS,
    );
    await this.bus.publishPresence({
      userId: user.userId,
      employeeId: user.employeeId,
      online: true,
    });
    return true;
  }

  /**
   * Соединение закрыто. Возвращает true, если пользователь ушёл офлайн.
   *
   * Отметка снимается только если её ставил этот же инстанс. Иначе при двух
   * вкладках на разных инстансах закрытие одной погасило бы присутствие,
   * поставленное другим. Обратный случай — отметка наша, а на соседнем
   * инстансе соединение осталось — разрешается его же продлением в течение
   * следующих тридцати секунд. Кратковременная ошибка в сторону «офлайн»
   * означает лишний push; ошибка в другую сторону означала бы молчание в
   * момент, когда человека пытаются дозваться.
   */
  async detach(user: AuthenticatedUser, socketId: string): Promise<boolean> {
    const bucket = this.sockets.get(user.userId);
    if (!bucket) return false;

    bucket.delete(socketId);
    if (bucket.size > 0) return false;

    this.sockets.delete(user.userId);

    await this.redis.delIfEquals(RedisKeys.presence(user.userId), this.instanceId);
    await this.bus.publishPresence({
      userId: user.userId,
      employeeId: user.employeeId,
      online: false,
    });
    return true;
  }

  /** Сколько пользователей и соединений держит этот инстанс — для health. */
  stats(): { users: number; sockets: number } {
    let sockets = 0;
    for (const bucket of this.sockets.values()) sockets += bucket.size;
    return { users: this.sockets.size, sockets };
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);

    // При остановке отметки снимаются сразу, а не ждут истечения TTL:
    // выключенный инстанс точно никого не держит, и полторы минуты
    // ложного «онлайн» стоили бы стольких же непришедших уведомлений.
    await Promise.all(
      [...this.sockets.keys()].map((userId) =>
        this.redis.delIfEquals(RedisKeys.presence(userId), this.instanceId),
      ),
    );
    this.sockets.clear();
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;

    this.heartbeat = setInterval(() => {
      void this.refresh();
    }, PresenceService.HEARTBEAT_MS);
    // Таймер не должен удерживать процесс при остановке.
    this.heartbeat.unref();
  }

  private async refresh(): Promise<void> {
    const userIds = [...this.sockets.keys()];
    if (userIds.length === 0) return;

    // Переустановка, а не продление. Ключ мог исчезнуть — из-за перерыва в
    // связи с Redis или из-за того, что соседний инстанс, владевший
    // отметкой, отпустил её при отключении СВОЕГО соединения того же
    // пользователя. EXPIRE в обоих случаях промолчал бы, и человек с
    // открытым окном остался бы офлайн до переподключения.
    //
    // Побочный эффект — владение отметкой переходит к последнему
    // писавшему инстансу. Это допустимо: каждый из них продолжает
    // продлевать её, пока держит соединение.
    await this.redis.setExMany(
      userIds.map((id) => RedisKeys.presence(id)),
      this.instanceId,
      PresenceService.TTL_SECONDS,
    );

    this.logger.debug({ message: 'присутствие продлено', users: userIds.length });
  }
}
