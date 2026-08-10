import { Controller, Inject, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import {
  ApprovalEvents,
  HrEvents,
  type AbsenceRegistrationFailed,
  type Envelope,
  type RequestApproved,
} from '@crm/contracts';
import { getRequestContext } from '@crm/common';
import {
  EventPublisher,
  PROCESSED_EVENT_STORE,
  handleEvent,
  type ProcessedEventStore,
} from '@crm/messaging';
import type { AbsenceType } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { outboxRow } from '../prisma/outbox.store';
import { ScheduleService } from './schedule.service';
import { TimesheetService } from '../timesheet/timesheet.service';

const CONSUMER = 'hr-service';

/** Тип заявки → тип отсутствия. Заявки, не создающие отсутствие, тут отсутствуют. */
const ABSENCE_BY_REQUEST_TYPE: Record<string, AbsenceType> = {
  VACATION: 'VACATION',
  TIME_OFF: 'TIME_OFF',
  TRIP: 'BUSINESS_TRIP',
};

/**
 * Половина саги согласования на стороне hr-service. docs/architecture.md §10.3, §10.4
 *
 * approval-service владеет ПРОЦЕССОМ, но не результатом: он публикует
 * решение, а применяет его владелец данных. Здесь заявка превращается в
 * отсутствие, переработку или закрытый период, после чего публикуется
 * подтверждающее событие с тем же requestId — по нему approval-service
 * переводит заявку в APPLIED.
 *
 * Если применить не удалось, публикуется событие об отказе: заявка
 * уходит в APPLY_FAILED, а не зависает в APPROVED навсегда.
 */
@Controller()
export class ApprovalEventsController {
  private readonly logger = new Logger(ApprovalEventsController.name);

  constructor(
    private readonly schedule: ScheduleService,
    private readonly timesheet: TimesheetService,
    private readonly prisma: PrismaService,
    private readonly publisher: EventPublisher,
    @Inject(PROCESSED_EVENT_STORE) private readonly processed: ProcessedEventStore,
  ) {}

  @EventPattern(ApprovalEvents.REQUEST_APPROVED)
  async onRequestApproved(
    @Payload() envelope: Envelope<RequestApproved>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        try {
          await this.apply(payload);
        } catch (error) {
          // Отказ применения — НЕ повод ронять обработку в DLQ: заявка
          // может быть невыполнимой по бизнес-причине (пересечение
          // отпусков, закрытый период), и повторы этого не исправят.
          // Сообщаем об отказе и подтверждаем сообщение.
          const reason = error instanceof Error ? error.message : String(error);
          await this.reportFailure(payload, reason);
          this.logger.warn({
            message: 'утверждённая заявка не применена',
            requestId: payload.requestId,
            type: payload.type,
            reason,
          });
        }
      },
    );
  }

  private async apply(payload: RequestApproved): Promise<void> {
    const body = payload.payload ?? {};
    const context = getRequestContext();

    const absenceType = ABSENCE_BY_REQUEST_TYPE[payload.type];
    if (absenceType) {
      await this.schedule.registerAbsence(
        {
          employeeId: payload.authorEmployeeId,
          type: absenceType,
          from: String(body.from ?? ''),
          to: String(body.to ?? ''),
          requestId: payload.requestId,
          comment: body.comment ? String(body.comment) : undefined,
        },
        context,
      );
      return;
    }

    switch (payload.type) {
      case 'OVERTIME':
        await this.timesheet.registerOvertime(
          {
            employeeId: payload.authorEmployeeId,
            date: String(body.date ?? ''),
            minutes: Number(body.minutes ?? 0),
            requestId: payload.requestId,
            reason: body.reason ? String(body.reason) : undefined,
          },
          context,
        );
        return;

      case 'TIMESHEET_FIX':
        await this.timesheet.applyCorrection(
          {
            employeeId: payload.authorEmployeeId,
            date: String(body.date ?? ''),
            totalMinutes: Number(body.totalMinutes ?? 0),
            requestId: payload.requestId,
            reason: body.reason ? String(body.reason) : undefined,
          },
          context,
        );
        return;

      case 'PERIOD_CLOSE':
        await this.timesheet.closePeriod(
          {
            departmentId: body.departmentId ? String(body.departmentId) : undefined,
            from: String(body.from ?? ''),
            to: String(body.to ?? ''),
            actorEmployeeId: payload.authorEmployeeId,
          },
          context,
        );
        return;

      default:
        // Заявки, которые применяет не hr-service (обмен сменами между
        // сотрудниками, акт выполненных работ), сюда доходить не должны,
        // но молча игнорировать неизвестный тип нельзя.
        this.logger.log({
          message: 'тип заявки не применяется кадровым сервисом, пропуск',
          requestId: payload.requestId,
          type: payload.type,
        });
    }
  }

  /**
   * Сообщение об отказе применения.
   *
   * Публикуется через outbox, а не напрямую: если процесс упадёт сразу
   * после отправки ack, заявка осталась бы в APPROVED без объяснения.
   */
  private async reportFailure(payload: RequestApproved, reason: string): Promise<void> {
    const envelope = this.publisher.wrap<AbsenceRegistrationFailed>(
      HrEvents.ABSENCE_REGISTRATION_FAILED,
      {
        requestId: payload.requestId,
        employeeId: payload.authorEmployeeId,
        reason,
      },
      getRequestContext(),
    );
    await this.prisma.outbox.create({ data: outboxRow(envelope) });
  }
}
