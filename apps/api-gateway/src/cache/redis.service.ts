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

  /** Строковый ключ с временем жизни: присутствие, короткие метки. */
  async setEx(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } catch {
      // намеренно молча
    }
  }

  /**
   * Переустановить пачку ключей с одинаковым значением и TTL.
   *
   * Именно SET, а не EXPIRE: продление времени жизни не воскрешает ключ,
   * которого нет, и пережитый перерыв в связи с Redis оставил бы отметку
   * присутствия исчезнувшей до самого переподключения клиента.
   */
  async setExMany(keys: string[], value: string, ttlSeconds: number): Promise<void> {
    if (keys.length === 0) return;
    try {
      const pipeline = this.client.pipeline();
      for (const key of keys) pipeline.set(key, value, 'EX', ttlSeconds);
      await pipeline.exec();
    } catch {
      // намеренно молча
    }
  }

  /**
   * Удалить ключ, только если его значение совпадает с ожидаемым.
   *
   * Нужно для присутствия при нескольких инстансах gateway: пользователь
   * может держать вкладки на разных, и уходящий инстанс не должен стирать
   * отметку, поставленную соседом. Проверка и удаление обязаны быть одной
   * операцией — между GET и DEL сосед успел бы записать своё значение.
   */
  async delIfEquals(key: string, expected: string): Promise<void> {
    try {
      await this.client.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        key,
        expected,
      );
    } catch {
      // намеренно молча
    }
  }

  /** Публикация в Redis Pub/Sub — транспорт эфемерных сигналов (§5). */
  async publish(channel: string, message: string): Promise<void> {
    try {
      await this.client.publish(channel, message);
    } catch {
      // намеренно молча: «печатает» и присутствие обязаны теряться при сбое
    }
  }

  async check(): Promise<HealthCheckResult> {
    const pong = await this.client.ping();
    return { name: this.name, healthy: pong === 'PONG' };
  }
}
