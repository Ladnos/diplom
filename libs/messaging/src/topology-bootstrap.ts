import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import * as amqp from 'amqplib';
import {
  EXCHANGE_DEFINITIONS,
  QUEUE_DEFINITIONS,
  Exchanges,
  dlqName,
  withDeadLetter,
} from '@crm/contracts';
import { buildRabbitUrl } from '@crm/common';

/**
 * Объявление топологии RabbitMQ при старте. docs/architecture.md §7.1
 *
 * Обменники, очереди, привязки и DLQ описаны данными в @crm/contracts и
 * применяются идемпотентно: повторный запуск ничего не ломает, а стенд
 * воспроизводится из репозитория, а не из ручных кликов в management UI.
 *
 * Запускается только в одном сервисе (api-gateway) — объявлять одну и ту же
 * топологию из десяти контейнеров одновременно бессмысленно и создаёт
 * гонку при старте.
 */
@Injectable()
export class TopologyBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(TopologyBootstrap.name);

  async onApplicationBootstrap(): Promise<void> {
    const url = buildRabbitUrl();
    let connection: amqp.ChannelModel | undefined;

    try {
      connection = await amqp.connect(url);
      const channel = await connection.createChannel();

      for (const exchange of EXCHANGE_DEFINITIONS) {
        await channel.assertExchange(exchange.name, exchange.type, exchange.options);
      }

      for (const queue of QUEUE_DEFINITIONS) {
        // Очереди на инстанс объявляет сам инстанс при подключении —
        // здесь их создавать нельзя, имя зависит от id контейнера.
        if (queue.perInstance) continue;

        await channel.assertQueue(queue.name, {
          durable: true,
          arguments: withDeadLetter(queue.name),
          ...queue.options,
        });

        for (const binding of queue.bindings) {
          for (const pattern of binding.patterns) {
            await channel.bindQueue(queue.name, binding.exchange, pattern);
          }
        }

        // DLQ: сюда попадает то, что не разобралось за MAX_RETRY_ATTEMPTS
        const dlq = dlqName(queue.name);
        await channel.assertQueue(dlq, { durable: true });
        await channel.bindQueue(dlq, Exchanges.DLX, dlq);
      }

      await channel.close();
      this.logger.log({
        message: 'топология RabbitMQ объявлена',
        exchanges: EXCHANGE_DEFINITIONS.length,
        queues: QUEUE_DEFINITIONS.filter((q) => !q.perInstance).length,
      });
    } catch (error) {
      // Не валим сервис: брокер может подниматься дольше и топология
      // будет объявлена при следующем старте либо вручную.
      this.logger.error({
        message: 'не удалось объявить топологию RabbitMQ',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }
}
