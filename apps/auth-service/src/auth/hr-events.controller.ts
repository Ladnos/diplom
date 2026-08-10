import { Controller, Inject, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import {
  ApprovalEvents,
  HrEvents,
  type DelegationSet,
  type EmployeeCreated,
  type EmployeeDeactivated,
  type EmployeeUpdated,
  type Envelope,
  type HierarchyChanged,
} from '@crm/contracts';
import { PROCESSED_EVENT_STORE, handleEvent, type ProcessedEventStore } from '@crm/messaging';
import { AuthService } from './auth.service';
import { OrgProjectionService } from './org-projection.service';

const CONSUMER = 'auth-service';

/**
 * Потребители событий auth-service (очередь auth.events, §7.5).
 *
 * Сервис не спрашивает оргструктуру у hr-service синхронно — он строит
 * собственную проекцию по событиям. Так проверка прав не зависит от
 * доступности кадрового сервиса и укладывается в дедлайн 500 мс.
 */
@Controller()
export class HrEventsController {
  private readonly logger = new Logger(HrEventsController.name);

  constructor(
    private readonly org: OrgProjectionService,
    private readonly auth: AuthService,
    @Inject(PROCESSED_EVENT_STORE) private readonly processed: ProcessedEventStore,
  ) {}

  @EventPattern(HrEvents.EMPLOYEE_CREATED)
  async onEmployeeCreated(
    @Payload() envelope: Envelope<EmployeeCreated>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        await this.org.upsertEmployee({
          employeeId: payload.employeeId,
          userId: payload.userId,
          departmentId: payload.departmentId,
          managerId: payload.managerId ?? null,
          active: true,
        });
        await this.org.rebuildClosure();
      },
    );
  }

  @EventPattern(HrEvents.EMPLOYEE_UPDATED)
  async onEmployeeUpdated(
    @Payload() envelope: Envelope<EmployeeUpdated>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        const touchesHierarchy =
          payload.changed.managerId !== undefined || payload.changed.departmentId !== undefined;
        if (!touchesHierarchy) return;

        await this.org.upsertEmployee({
          employeeId: payload.employeeId,
          departmentId: payload.changed.departmentId,
          managerId: payload.changed.managerId,
        });
        await this.org.rebuildClosure();
      },
    );
  }

  /**
   * Увольнение. Сессии обрываются немедленно, а не по истечении токена:
   * refresh хранится в БД именно ради этого (§10.6).
   */
  @EventPattern(HrEvents.EMPLOYEE_DEACTIVATED)
  async onEmployeeDeactivated(
    @Payload() envelope: Envelope<EmployeeDeactivated>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        await this.org.deactivateEmployee(payload.employeeId);
        await this.org.rebuildClosure();
        await this.auth.revokeAllSessions(payload.userId, 'сотрудник уволен');
      },
    );
  }

  @EventPattern(HrEvents.HIERARCHY_CHANGED)
  async onHierarchyChanged(
    @Payload() envelope: Envelope<HierarchyChanged>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        await this.org.upsertEmployee({
          employeeId: payload.employeeId,
          managerId: payload.newManagerId ?? null,
        });
        await this.org.rebuildClosure();
      },
    );
  }

  @EventPattern(ApprovalEvents.DELEGATION_SET)
  async onDelegationSet(@Payload() envelope: Envelope<DelegationSet>, @Ctx() context: RmqContext) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        await this.org.setDelegation({
          managerEmployeeId: payload.managerEmployeeId,
          delegateEmployeeId: payload.delegateEmployeeId,
          from: new Date(payload.period.from),
          to: new Date(payload.period.to),
        });
      },
    );
  }
}
