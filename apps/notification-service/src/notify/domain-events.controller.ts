import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { Commands, type Envelope, type NotificationSend } from '@crm/contracts';
import { handleEvent } from '@crm/messaging';
import { NotificationService } from './notification.service';

const CONSUMER = 'notification-service';

/**
 * Единственный потребитель очереди notification.events (§7.5).
 *
 * ── Почему обработчики по маске, а не по типу события ──────────────────
 * Очередь привязана к семи паттернам (auth.# hr.# approval.# task.# chat.#
 * video.# file.#), то есть получает ВЕСЬ поток системы. NestJS, не найдя
 * обработчика под routing key, делает nack(requeue: false) — сообщение
 * уходит в DLQ. При обработчиках на каждый тип события любое новое
 * событие в любом сервисе начинало бы молча копиться в notification.dlq,
 * и заметили бы это в лучшем случае по размеру диска.
 *
 * Маска покрывает ровно то, на что подписана очередь: пришедшее без
 * правила подтверждается и забывается — это нормальный исход, а не сбой.
 * Соответствие «событие → уведомление» описано данными в rules.catalog.ts,
 * поэтому новое уведомление добавляется записью в каталог, а не новым
 * методом контроллера.
 */
@Controller()
export class DomainEventsController {
  private readonly logger = new Logger(DomainEventsController.name);

  constructor(private readonly notifications: NotificationService) {}

  @EventPattern('auth.#')
  async onAuthEvent(@Payload() envelope: Envelope, @Ctx() context: RmqContext) {
    await this.dispatch(envelope, context);
  }

  @EventPattern('hr.#')
  async onHrEvent(@Payload() envelope: Envelope, @Ctx() context: RmqContext) {
    await this.dispatch(envelope, context);
  }

  @EventPattern('approval.#')
  async onApprovalEvent(@Payload() envelope: Envelope, @Ctx() context: RmqContext) {
    await this.dispatch(envelope, context);
  }

  @EventPattern('task.#')
  async onTaskEvent(@Payload() envelope: Envelope, @Ctx() context: RmqContext) {
    await this.dispatch(envelope, context);
  }

  @EventPattern('chat.#')
  async onChatEvent(@Payload() envelope: Envelope, @Ctx() context: RmqContext) {
    await this.dispatch(envelope, context);
  }

  @EventPattern('video.#')
  async onVideoEvent(@Payload() envelope: Envelope, @Ctx() context: RmqContext) {
    await this.dispatch(envelope, context);
  }

  @EventPattern('file.#')
  async onFileEvent(@Payload() envelope: Envelope, @Ctx() context: RmqContext) {
    await this.dispatch(envelope, context);
  }

  // ── Асинхронные команды (§7.4) ────────────────────────────────────────

  /** Явная отправка уведомления по адресу, известному отправителю. */
  @EventPattern(Commands.NOTIFICATION_SEND)
  async onSendCommand(
    @Payload() envelope: Envelope<NotificationSend>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent({ envelope, context, consumer: CONSUMER, logger: this.logger }, async () => {
      await this.notifications.handleCommand(envelope);
    });
  }

  /**
   * Рассылка по отделу или всей компании. Отдельный routing key, а не
   * флаг в payload: по журналу брокера должно быть видно, кто и когда
   * обращался ко всей компании, без разбора тела сообщений.
   */
  @EventPattern(Commands.NOTIFICATION_BROADCAST)
  async onBroadcastCommand(
    @Payload() envelope: Envelope<NotificationSend>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent({ envelope, context, consumer: CONSUMER, logger: this.logger }, async () => {
      const count = await this.notifications.handleCommand(envelope);
      this.logger.log({
        message: 'выполнена массовая рассылка',
        eventId: envelope.eventId,
        recipients: count,
        correlationId: envelope.correlationId,
      });
    });
  }

  /**
   * Дедупликация намеренно НЕ передаётся в handleEvent: сервис ставит
   * отметку об обработке внутри своей транзакции вместе с уведомлениями
   * (§7.7). Общая обёртка ставит её после успешного обработчика, то есть
   * отдельным запросом, и оставляет окно, в котором уведомления записаны,
   * а отметка нет — повтор разошлёт всё второй раз.
   */
  private async dispatch(envelope: Envelope, context: RmqContext): Promise<void> {
    await handleEvent({ envelope, context, consumer: CONSUMER, logger: this.logger }, async () => {
      await this.notifications.handleEvent(envelope);
    });
  }
}
