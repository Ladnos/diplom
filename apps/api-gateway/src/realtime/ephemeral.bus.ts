import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { RedisChannels } from '@crm/contracts';
import { buildRedisUrl } from '@crm/common';
import { RedisService } from '../cache/redis.service';

/**
 * Третий транспорт системы: Redis Pub/Sub. docs/architecture.md §5, §8.2
 *
 * Здесь ходит то, что ОБЯЗАНО теряться при сбое. Индикатор «печатает»
 * живёт три секунды, и доставленный с опозданием он врёт: человек уже
 * отправил сообщение или закрыл окно. Присутствие — то же самое, только
 * с большим горизонтом. Проводить такие сигналы через RabbitMQ означало бы
 * гарантировать доставку тому, кому она уже не нужна, и платить за это
 * очередями и подтверждениями.
 *
 * ОТДЕЛЬНОЕ СОЕДИНЕНИЕ. Redis-клиент в режиме подписки не выполняет
 * обычных команд, поэтому подписка не может делить соединение с кэшем
 * токенов. Публикация — обычная команда и идёт через общий RedisService.
 */
@Injectable()
export class EphemeralBus implements OnApplicationShutdown {
  private readonly logger = new Logger(EphemeralBus.name);
  private readonly subscriber: Redis;
  private handler: ((signal: EphemeralSignal) => void) | null = null;

  constructor(private readonly redis: RedisService) {
    this.subscriber = new Redis(buildRedisUrl(), {
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
      lazyConnect: false,
    });

    this.subscriber.on('error', (error: Error) => {
      this.logger.warn({ message: 'ошибка подписки Redis', error: error.message });
    });

    // Подписки восстанавливаются на каждом соединении: ioredis
    // переподключается сам, но подписки при этом не переносит.
    this.subscriber.on('ready', () => void this.resubscribe());

    this.subscriber.on('pmessage', (_pattern, channel, message) => {
      const channelId = channel.slice(channel.indexOf(':') + 1);
      this.dispatch({ kind: 'typing', channelId, raw: message });
    });

    this.subscriber.on('message', (_channel, message) => {
      this.dispatch({ kind: 'presence', raw: message });
    });
  }

  /** Обработчик ставится шлюзом при инициализации; он же и единственный. */
  onSignal(handler: (signal: EphemeralSignal) => void): void {
    this.handler = handler;
  }

  /**
   * Сигнал «печатает» в канале чата.
   *
   * socketId уходит вместе с сигналом, чтобы автор не увидел собственный
   * индикатор: комната одна на всех, а отправитель в ней тоже состоит.
   * Отсеять его на приёме нельзя по userId — у человека может быть
   * открыто два окна, и во втором индикатор как раз уместен.
   */
  async publishTyping(input: {
    channelId: string;
    userId: string;
    employeeId?: string;
    socketId: string;
  }): Promise<void> {
    await this.redis.publish(
      RedisChannels.typing(input.channelId),
      JSON.stringify({
        userId: input.userId,
        employeeId: input.employeeId,
        socketId: input.socketId,
        at: Date.now(),
      }),
    );
  }

  async publishPresence(input: {
    userId: string;
    employeeId?: string;
    online: boolean;
  }): Promise<void> {
    await this.redis.publish(
      RedisChannels.PRESENCE_UPDATES,
      JSON.stringify({ ...input, at: Date.now() }),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.subscriber.quit().catch(() => undefined);
  }

  private async resubscribe(): Promise<void> {
    try {
      // typing:* вместо перечисления каналов: подписываться на каждый
      // открытый чат отдельно значило бы держать подписку на каждый канал
      // каждого подключённого пользователя и переоформлять её при каждом
      // переключении вкладки. Инстанс получает все сигналы и отбрасывает
      // те, для комнат которых у него нет сокетов, — это дешевле.
      await this.subscriber.psubscribe(RedisChannels.typing('*'));
      await this.subscriber.subscribe(RedisChannels.PRESENCE_UPDATES);
    } catch (error) {
      this.logger.warn({
        message: 'не удалось оформить подписки Redis',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private dispatch(signal: EphemeralSignal): void {
    if (!this.handler) return;
    try {
      this.handler(signal);
    } catch (error) {
      this.logger.warn({
        message: 'ошибка обработки эфемерного сигнала',
        kind: signal.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export type EphemeralSignal =
  | { kind: 'typing'; channelId: string; raw: string }
  | { kind: 'presence'; raw: string };
