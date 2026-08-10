import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { buildRedisUrl, type HealthCheckResult, type HealthIndicator } from '@crm/common';

/**
 * Redis — единственное состояние api-gateway (§2.1).
 *
 * Держит кэш решений об аутентификации, карту «пользователь → инстанс»
 * для WebSocket и эфемерные сигналы (presence, «печатает»). Собственной
 * базы у gateway нет и быть не должно: он не владеет доменными данными.
 */
@Injectable()
export class RedisService implements OnModuleDestroy, HealthIndicator {
  readonly name = 'redis';
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor() {
    this.client = new Redis(buildRedisUrl(), {
      maxRetriesPerRequest: 2,
      // Запросы не копятся в очереди, пока соединения нет: недоступный
      // кэш должен давать быструю ошибку, а не расти в памяти.
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

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      // Кэш — оптимизация, а не источник истины: при сбое Redis запрос
      // должен пройти через auth-service, а не упасть.
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      // намеренно молча: см. выше
    }
  }

  async del(pattern: string): Promise<void> {
    try {
      await this.client.del(pattern);
    } catch {
      // намеренно молча
    }
  }

  async check(): Promise<HealthCheckResult> {
    const pong = await this.client.ping();
    return { name: this.name, healthy: pong === 'PONG' };
  }
}
