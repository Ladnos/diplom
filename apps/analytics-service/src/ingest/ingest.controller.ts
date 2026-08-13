import { Controller, Inject, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { Commands, type Envelope } from '@crm/contracts';
import { PROCESSED_EVENT_STORE, handleEvent, type ProcessedEventStore } from '@crm/messaging';
import { AuditService } from './audit.service';
import { ProjectionsService } from '../projections/projections.service';
import { ExportService } from '../reports/export.service';

const CONSUMER = 'analytics-service';

/**
 * Приём всего потока событий. docs/architecture.md §7.5
 *
 * ОДИН ОБРАБОТЧИК НА ВСЮ ШИНУ, и это не упрощение. Очередь сервиса
 * привязана к `#`, то есть сюда приходит каждое событие системы; NestJS
 * выбирает обработчик по routing key и отвергает сообщение, для которого
 * не нашёл подходящего. Перечислять полсотни типов поимённо означало бы
 * отправлять в DLQ каждое новое событие, появившееся в любом сервисе, —
 * ровно это и произошло к моменту реализации: в `analytics.events.dlq`
 * лежало больше сотни сообщений, накопленных заглушкой.
 *
 * Команда `report.generate` разбирается здесь же, а не отдельным
 * обработчиком. Она тоже подходит под `#`, и при двух подходящих
 * паттернах выбор зависел бы от порядка регистрации — то есть от того,
 * в каком порядке TypeScript разложил методы класса.
 */
@Controller()
export class IngestController {
  private readonly logger = new Logger(IngestController.name);

  constructor(
    private readonly audit: AuditService,
    private readonly projections: ProjectionsService,
    private readonly exports: ExportService,
    @Inject(PROCESSED_EVENT_STORE) private readonly processed: ProcessedEventStore,
  ) {}

  @EventPattern('#')
  async onAnyEvent(@Payload() envelope: Envelope, @Ctx() context: RmqContext): Promise<void> {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async () => {
        // Сравнение через приведение к строке: eventType типизирован
        // каталогом ДОМЕННЫХ событий, а сюда по той же очереди приходят
        // ещё и команды — их имена в этот тип не входят по определению.
        if (String(envelope.eventType) === Commands.REPORT_GENERATE) {
          await this.exports.run(envelope.payload as { ticketId?: string });
          return;
        }

        // Журнал ведётся ДО проекций и независимо от них. Событие, которое
        // не удалось разложить по витринам, всё равно обязано остаться в
        // аудите: витрину можно пересобрать из журнала, журнал из витрины —
        // нет.
        await this.audit.record(envelope);
        await this.projections.apply(envelope);
      },
    );
  }
}
