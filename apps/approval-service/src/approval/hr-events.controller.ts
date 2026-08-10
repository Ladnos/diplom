import { Controller, Inject, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import {
  HrEvents,
  type AbsenceRegistered,
  type AbsenceRegistrationFailed,
  type EmployeeDeactivated,
  type EmploymentChanged,
  type Envelope,
  type HierarchyChanged,
  type OvertimeRegistered,
  type TimesheetClosed,
  type TimesheetCorrected,
} from '@crm/contracts';
import { PROCESSED_EVENT_STORE, handleEvent, type ProcessedEventStore } from '@crm/messaging';
import type { RequestType } from '../../generated/prisma';
import { ApprovalService } from './approval.service';
import { availableTypes, isApplicable } from './request-types';

const CONSUMER = 'approval-service';

/**
 * Потребители событий approval-service (очередь approval.events, §7.5).
 *
 * Здесь ЗАМЫКАЕТСЯ сага: hr-service применил решение и сообщил об этом
 * событием с тем же requestId, по которому заявка переходит в APPLIED.
 * Без этой обратной связи approval-service знал бы только, что решение
 * принято, но не что оно исполнено (ADR-3, §10.3).
 */
@Controller()
export class HrEventsController {
  private readonly logger = new Logger(HrEventsController.name);

  constructor(
    private readonly approval: ApprovalService,
    @Inject(PROCESSED_EVENT_STORE) private readonly processed: ProcessedEventStore,
  ) {}

  // ── Подтверждения применения ─────────────────────────────────────────

  @EventPattern(HrEvents.ABSENCE_REGISTERED)
  async onAbsenceRegistered(
    @Payload() envelope: Envelope<AbsenceRegistered>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        // Пустой requestId — отсутствие оформлено кадровиком приказом,
        // минуя согласование. Закрывать нечего.
        if (!payload.requestId) return;
        await this.approval.markApplied(payload.requestId);
      },
    );
  }

  @EventPattern(HrEvents.ABSENCE_REGISTRATION_FAILED)
  async onAbsenceFailed(
    @Payload() envelope: Envelope<AbsenceRegistrationFailed>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        if (!payload.requestId) return;
        await this.approval.markApplyFailed(payload.requestId, payload.reason);
      },
    );
  }

  @EventPattern(HrEvents.OVERTIME_REGISTERED)
  async onOvertimeRegistered(
    @Payload() envelope: Envelope<OvertimeRegistered>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        if (!payload.requestId) return;
        await this.approval.markApplied(payload.requestId);
      },
    );
  }

  @EventPattern(HrEvents.TIMESHEET_CORRECTED)
  async onTimesheetCorrected(
    @Payload() envelope: Envelope<TimesheetCorrected>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        if (!payload.requestId) return;
        await this.approval.markApplied(payload.requestId);
      },
    );
  }

  @EventPattern(HrEvents.TIMESHEET_CLOSED)
  async onTimesheetClosed(
    @Payload() envelope: Envelope<TimesheetClosed>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async () => {
        // Событие закрытия периода не несёт requestId: период может быть
        // закрыт и напрямую кадровой службой. Заявку PERIOD_CLOSE закроет
        // таймер саги, если подтверждения не будет.
        this.logger.debug({ message: 'период табеля закрыт' });
      },
    );
  }

  // ── Реакции на изменения в кадрах ────────────────────────────────────

  @EventPattern(HrEvents.HIERARCHY_CHANGED)
  async onHierarchyChanged(
    @Payload() envelope: Envelope<HierarchyChanged>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        // Заявки, ожидающие решения бывшего руководителя, зависли бы:
        // он больше не имеет прав на этого сотрудника.
        await this.approval.rebuildRoutesFor(payload.employeeId);
      },
    );
  }

  /**
   * Смена типа найма может сделать открытые заявки неприменимыми:
   * перевод в ГПХ отменяет заявку на отпуск, потому что права на отпуск
   * гражданско-правовой договор не даёт (§3.3, §10.5).
   */
  @EventPattern(HrEvents.EMPLOYMENT_CHANGED)
  async onEmploymentChanged(
    @Payload() envelope: Envelope<EmploymentChanged>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        const nowAvailable = availableTypes(payload.after.policy);
        const inapplicable = (
          ['VACATION', 'TIME_OFF', 'OVERTIME', 'SHIFT_SWAP', 'TIMESHEET_FIX', 'TRIP', 'WORK_ACT'] as RequestType[]
        ).filter((type) => !isApplicable(type, payload.after.policy));

        if (inapplicable.length === 0) return;

        const cancelled = await this.approval.cancelOpenRequests(
          payload.employeeId,
          `тип найма изменён на ${payload.after.type}: заявка стала неприменимой. ` +
            `Доступные типы: ${nowAvailable.join(', ') || 'нет'}`,
          inapplicable,
        );

        if (cancelled > 0) {
          this.logger.log({
            message: 'заявки отменены из-за смены типа найма',
            employeeId: payload.employeeId,
            policy: payload.after.policy,
            cancelled,
          });
        }
      },
    );
  }

  @EventPattern(HrEvents.EMPLOYEE_DEACTIVATED)
  async onEmployeeDeactivated(
    @Payload() envelope: Envelope<EmployeeDeactivated>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        await this.approval.cancelOpenRequests(payload.employeeId, 'сотрудник уволен');
      },
    );
  }
}
