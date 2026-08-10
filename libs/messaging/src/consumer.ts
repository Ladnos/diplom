import { Logger } from '@nestjs/common';
import { RmqContext } from '@nestjs/microservices';
import { Envelope } from '@crm/contracts';
import { ProcessedEventStore } from './idempotency';

/**
 * Обёртка обработки события с ручным ack/nack и дедупликацией.
 * docs/architecture.md §7.7, §7.8
 *
 * Три правила, которые она обеспечивает и которые легко нарушить,
 * если писать ack вручную в каждом обработчике:
 *
 *  1. Дубликат подтверждается, но не обрабатывается повторно.
 *  2. Успех подтверждается ровно один раз.
 *  3. Ошибка уходит через nack(requeue: false) в DLX, а НЕ возвращается
 *     в очередь: requeue: true на «отравленном» сообщении даёт бесконечный
 *     цикл, который забивает консьюмера и не даёт разобрать остальное.
 */
export async function handleEvent<TPayload>(
  params: {
    envelope: Envelope<TPayload>;
    context: RmqContext;
    consumer: string;
    store?: ProcessedEventStore;
    logger?: Logger;
  },
  handler: (payload: TPayload, envelope: Envelope<TPayload>) => Promise<void>,
): Promise<void> {
  const { envelope, context, consumer, store, logger = new Logger('EventConsumer') } = params;
  const channel = context.getChannelRef();
  const message = context.getMessage();

  try {
    if (store && (await store.seen(envelope.eventId, consumer))) {
      logger.debug({
        message: 'дубликат события отброшен',
        eventId: envelope.eventId,
        eventType: envelope.eventType,
      });
      channel.ack(message);
      return;
    }

    await handler(envelope.payload, envelope);
    await store?.mark(envelope.eventId, consumer, envelope.eventType);

    channel.ack(message);
    logger.debug({
      message: 'событие обработано',
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      correlationId: envelope.correlationId,
    });
  } catch (error) {
    logger.error({
      message: 'ошибка обработки события',
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      correlationId: envelope.correlationId,
      error: error instanceof Error ? error.message : String(error),
    });
    channel.nack(message, false, false);
  }
}
