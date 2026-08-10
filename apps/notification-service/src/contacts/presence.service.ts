import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { RedisKeys } from '@crm/contracts';
import { buildRedisUrl, type HealthCheckResult, type HealthIndicator } from '@crm/common';

/**
 * Кто сейчас за экраном. docs/architecture.md §8.2
 *
 * Единственное, ради чего уведомлениям нужен Redis: push об обычном
 * сообщении в чате не нужен тому, у кого это сообщение и так появилось
 * в открытом окне (§7.3). Присутствие пишет api-gateway, пока держит
 * WS-соединение; ключ живёт по TTL, поэтому упавший инстанс не оставляет
 * пользователя «вечно онлайн».
 *
 * При недоступном Redis отвечаем «офлайн», то есть push уходит. Ошибка
 * в эту сторону — лишнее уведомление; в обратную — молчание в момент,
 * когда человека пытаются дозваться.
 */
@Injectable()
export class PresenceService implements OnModuleDestroy, HealthIndicator {
  readonly name = 'redis';
  private readonly logger = new Logger(PresenceService.name);
  private readonly client: Redis;

  constructor() {
    this.client = new Redis(buildRedisUrl(), {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    this.client.on('error', (error: Error) => {
      this.logger.warn({ message: 'ошибка соединения с Redis', error: error.message });
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }

  /** Подмножество переданных пользователей, которые сейчас онлайн. */
  async filterOnline(userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();

    try {
      const values = await this.client.mget(userIds.map((id) => RedisKeys.presence(id)));
      return new Set(userIds.filter((_, index) => values[index] !== null));
    } catch {
      return new Set();
    }
  }

  async check(): Promise<HealthCheckResult> {
    const pong = await this.client.ping();
    return { name: this.name, healthy: pong === 'PONG' };
  }
}
