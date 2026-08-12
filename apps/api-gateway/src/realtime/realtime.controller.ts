import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { handleEvent } from '@crm/messaging';
import type { Envelope } from '@crm/contracts';
import { RealtimeGateway } from './realtime.gateway';
import { fanoutFor } from './fanout.map';

const CONSUMER = 'api-gateway';

/**
 * Потребитель очереди gateway.realtime. docs/architecture.md §7.5, §8.1
 *
 * ОБРАБОТЧИКИ ПОВТОРЯЮТ ПАТТЕРНЫ ПРИВЯЗОК, а не перечисляют события
 * поимённо. Это не сокращение записи, а обязательное условие: NestJS
 * ищет обработчик по routing key сообщения и, не найдя, отвечает
 * nack(requeue: false). Событие, для которого нет подходящего @EventPattern,
 * не «пропускается» — оно отвергается. У обычной очереди такие сообщения
 * копятся в DLQ, а здесь, у эфемерной очереди без dead-letter, исчезают
 * бесследно, и разошедшийся с привязками список обработчиков не проявился
 * бы ничем, кроме молчащего интерфейса.
 *
 * Дедупликация не нужна. У gateway нет базы, а повторно доставленное
 * realtime-событие означает лишь повторную перерисовку уже показанного:
 * все сообщения несут идентификаторы, по которым клиент узнаёт своё
 * состояние. Хранить ради этого таблицу processed_events было бы дороже
 * последствий.
 */
@Controller()
export class RealtimeEventsController {
  private readonly logger = new Logger(RealtimeEventsController.name);

  constructor(private readonly gateway: RealtimeGateway) {}

  @EventPattern('task.#')
  async onTask(@Payload() envelope: Envelope, @Ctx() context: RmqContext): Promise<void> {
    await this.dispatch(envelope, context);
  }

  @EventPattern('approval.#')
  async onApproval(@Payload() envelope: Envelope, @Ctx() context: RmqContext): Promise<void> {
    await this.dispatch(envelope, context);
  }

  @EventPattern('hr.timesheet.#')
  async onTimesheet(@Payload() envelope: Envelope, @Ctx() context: RmqContext): Promise<void> {
    await this.dispatch(envelope, context);
  }

  @EventPattern('chat.#')
  async onChat(@Payload() envelope: Envelope, @Ctx() context: RmqContext): Promise<void> {
    await this.dispatch(envelope, context);
  }

  @EventPattern('video.#')
  async onVideo(@Payload() envelope: Envelope, @Ctx() context: RmqContext): Promise<void> {
    await this.dispatch(envelope, context);
  }

  @EventPattern('notification.created')
  async onNotification(@Payload() envelope: Envelope, @Ctx() context: RmqContext): Promise<void> {
    await this.dispatch(envelope, context);
  }

  private async dispatch(envelope: Envelope, context: RmqContext): Promise<void> {
    await handleEvent({ envelope, context, consumer: CONSUMER, logger: this.logger }, async () => {
      const fanout = fanoutFor(envelope.eventType, envelope.payload);
      if (!fanout) return;

      this.gateway.emit(fanout.rooms, envelope.eventType, {
        ...fanout.data,
        // Идентификатор события отдаётся клиенту не для красоты: при
        // переподключении Socket.IO может доставить сообщение повторно, и
        // по нему клиент отличает дубль от нового изменения.
        eventId: envelope.eventId,
        occurredAt: envelope.occurredAt,
      });
    });
  }
}
