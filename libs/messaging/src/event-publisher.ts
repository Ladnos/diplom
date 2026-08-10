import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { randomUUID } from 'node:crypto';
import {
  CURRENT_EVENT_VERSION,
  CommandType,
  Commands,
  Envelope,
  EventType,
  PayloadOf,
  RequestContext,
} from '@crm/contracts';
import { getRequestContext } from '@crm/common';
import { EVENTS_CLIENT, COMMANDS_CLIENT } from './tokens';

/**
 * Команды и события живут в разных обменниках, а конверт из outbox несёт
 * только строку типа. Различаем по каталогу: имена команд перечислимы и
 * их немного, тогда как события добавляются постоянно.
 */
const COMMAND_TYPES = new Set<string>(Object.values(Commands));

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

  /**
   * Публикация уже собранного конверта.
   *
   * Используется OutboxWorker: конверт был создан и сохранён в БД раньше,
   * в момент доменной операции, и пересобирать его нельзя — потерялись бы
   * исходные eventId, occurredAt и correlationId, а с ними дедупликация
   * на стороне потребителя и связность логов.
   */
  publishEnvelope(envelope: Envelope): void {
    const client = COMMAND_TYPES.has(envelope.eventType) ? this.commands : this.events;
    client.emit(envelope.eventType, envelope);
  }

  /** Сборка конверта. Публичный метод: им же пользуется outbox. */
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
