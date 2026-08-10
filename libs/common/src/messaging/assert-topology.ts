import { Logger } from '@nestjs/common';
import * as amqp from 'amqplib';
import {
  EXCHANGE_DEFINITIONS,
  Exchanges,
  QueueDefinition,
  dlqName,
  withDeadLetter,
} from '@crm/contracts';

/**
 * Объявление топологии RabbitMQ перед подключением потребителя.
 * docs/architecture.md §7.1
 *
 * Каждый сервис объявляет обменники и СВОЮ очередь с привязками. Операции
 * идемпотентны, поэтому порядок старта контейнеров не важен: кто первый
 * поднялся, тот и создал обменники, остальные получат их готовыми.
 *
 * Почему не доверить это транспорту NestJS: он привязывает к обменнику все
 * паттерны из @EventPattern скопом, а нам нужны разные паттерны для
 * crm.events и crm.commands в одной очереди. Поэтому топология
 * объявляется здесь явно, а транспорт подключается с noAssert: true.
 */
export async function assertTopology(
  rabbitUrl: string,
  queue?: QueueDefinition,
  instanceSuffix?: string,
): Promise<void> {
  const logger = new Logger('Topology');
  let connection: amqp.ChannelModel | undefined;

  try {
    connection = await amqp.connect(rabbitUrl);
    const channel = await connection.createChannel();

    for (const exchange of EXCHANGE_DEFINITIONS) {
      try {
        await channel.assertExchange(exchange.name, exchange.type, exchange.options);
      } catch (error) {
        // x-delayed-message требует плагина rabbitmq_delayed_message_exchange.
        // Без него отложенные повторы недоступны, но остальная система
        // работает — поэтому предупреждение, а не падение.
        if (exchange.type === 'x-delayed-message') {
          logger.warn({
            message:
              'обменник crm.retry не создан: нет плагина rabbitmq_delayed_message_exchange. ' +
              'Отложенные повторы отключены, отказы уйдут сразу в DLQ',
            error: error instanceof Error ? error.message : String(error),
          });
          // Канал после ошибки непригоден — открываем новый
          await connection.createChannel().then((ch) => Object.assign(channel, ch));
          continue;
        }
        throw error;
      }
    }

    if (queue) {
      const queueName = queue.perInstance && instanceSuffix
        ? `${queue.name}.${instanceSuffix}`
        : queue.name;

      // Эфемерным очередям на инстанс DLQ не нужна: realtime-обновление,
      // которое не удалось разложить по WebSocket-соединениям, бессмысленно
      // разбирать вручную — клиент дочитает состояние обычным запросом.
      const needsDlq = !queue.perInstance;

      await channel.assertQueue(queueName, {
        durable: true,
        ...(needsDlq ? { arguments: withDeadLetter(queueName) } : {}),
        ...queue.options,
      });

      for (const binding of queue.bindings) {
        for (const pattern of binding.patterns) {
          await channel.bindQueue(queueName, binding.exchange, pattern);
        }
      }

      if (needsDlq) {
        // Сюда попадает то, что не разобралось за MAX_RETRY_ATTEMPTS
        const dlq = dlqName(queueName);
        await channel.assertQueue(dlq, { durable: true });
        await channel.bindQueue(dlq, Exchanges.DLX, dlq);
      }

      logger.log({
        message: 'топология объявлена',
        queue: queueName,
        bindings: queue.bindings.reduce((sum, b) => sum + b.patterns.length, 0),
      });
    } else {
      logger.log({ message: 'обменники объявлены, очередь не требуется' });
    }

    await channel.close();
  } finally {
    await connection?.close().catch(() => undefined);
  }
}
