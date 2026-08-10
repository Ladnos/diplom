import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { randomUUID } from 'node:crypto';
import {
  CURRENT_EVENT_VERSION,
  CommandType,
  Envelope,
  EventType,
  PayloadOf,
  RequestContext,
} from '@crm/contracts';
import { getRequestContext } from '@crm/common';
import { EVENTS_CLIENT, COMMANDS_CLIENT } from './tokens';

/**
 * Публикация событий и команд в RabbitMQ.
 *
 * Обратите внимание на emit(), а не send(): события публикуются
 * fire-and-forget, издатель не ждёт и не знает подписчиков. Запрос-ответ
 * поверх брокера в системе запрещён — для него есть gRPC (§5).
 *
 * ВАЖНО про доставку. Прямой вызов publish() не даёт гарантии, что событие
 * переживёт падение процесса между коммитом в БД и отправкой в брокер.
 * Там, где это критично, событие пишется в таблицу outbox в одной
 * транзакции с изменением данных, а публикует его OutboxWorker (§7.7).
 */
@Injectable()
export class EventPublisher {
  private readonly logger = new Logger(EventPublisher.name);

  constructor(
    @Inject(EVENTS_CLIENT) private readonly events: ClientProxy,
    @Inject(COMMANDS_CLIENT) private readonly commands: ClientProxy,
  ) {}

  /** Публикация доменного события в crm.events. */
  publish<T extends EventType>(
    eventType: T,
    payload: PayloadOf<T>,
    context?: RequestContext,
  ): void {
    const envelope = this.wrap(eventType, payload, context);
    this.events.emit(eventType, envelope);
    this.logger.debug({
      message: 'событие опубликовано',
      eventType,
      eventId: envelope.eventId,
      correlationId: envelope.correlationId,
    });
  }

  /** Отправка асинхронной команды в crm.commands. */
  sendCommand<TPayload>(
    command: CommandType,
    payload: TPayload,
    context?: RequestContext,
  ): void {
    const envelope = this.wrap(command as unknown as EventType, payload, context);
    this.commands.emit(command, envelope);
    this.logger.debug({
      message: 'команда отправлена',
      command,
      eventId: envelope.eventId,
      correlationId: envelope.correlationId,
    });
  }

  /** Сборка конверта. Публичный метод: им же пользуется OutboxWorker. */
  wrap<TPayload>(
    eventType: EventType,
    payload: TPayload,
    context?: RequestContext,
  ): Envelope<TPayload> {
    const ctx = context ?? getRequestContext();
    return {
      eventId: randomUUID(),
      eventType,
      eventVersion: CURRENT_EVENT_VERSION,
      occurredAt: new Date().toISOString(),
      producer: process.env.SERVICE_NAME ?? 'unknown',
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      actor: ctx.actor,
      payload,
    };
  }
}
