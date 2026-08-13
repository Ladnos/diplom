import { Controller, Inject, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import {
  HrEvents,
  type EmployeeCreated,
  type EmployeeDeactivated,
  type EmployeeUpdated,
  type Envelope,
} from '@crm/contracts';
import { PROCESSED_EVENT_STORE, handleEvent, type ProcessedEventStore } from '@crm/messaging';
import { PrismaService } from '../prisma/prisma.service';

const CONSUMER = 'video-service';

/**
 * Потребитель очереди video.events (§7.5).
 *
 * Единственная привязка — `hr.employee.#`, и обработчик повторяет её
 * маской, а не перечисляет события поимённо: NestJS отвергает сообщение,
 * для которого не нашёл обработчика, и появление нового события в этом
 * контексте молча наполняло бы DLQ.
 *
 * Звонку от кадров нужно немногое: имя для списка участников и признак
 * увольнения, чтобы не звать в разговор того, кто уже не работает.
 */
@Controller()
export class HrEventsController {
  private readonly logger = new Logger(HrEventsController.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROCESSED_EVENT_STORE) private readonly processed: ProcessedEventStore,
  ) {}

  @EventPattern('hr.employee.#')
  async onEmployeeEvent(@Payload() envelope: Envelope, @Ctx() context: RmqContext) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async () => {
        switch (envelope.eventType) {
          case HrEvents.EMPLOYEE_CREATED: {
            const payload = envelope.payload as EmployeeCreated;
            await this.prisma.employeeRef.upsert({
              where: { employeeId: payload.employeeId },
              create: {
                employeeId: payload.employeeId,
                fullName: payload.fullName,
                active: true,
              },
              update: { fullName: payload.fullName, active: true },
            });
            return;
          }

          case HrEvents.EMPLOYEE_UPDATED: {
            const payload = envelope.payload as EmployeeUpdated;
            if (payload.changed?.fullName === undefined) return;
            await this.prisma.employeeRef.updateMany({
              where: { employeeId: payload.employeeId },
              data: { fullName: payload.changed.fullName },
            });
            return;
          }

          case HrEvents.EMPLOYEE_DEACTIVATED: {
            const payload = envelope.payload as EmployeeDeactivated;
            await this.prisma.employeeRef.upsert({
              where: { employeeId: payload.employeeId },
              create: { employeeId: payload.employeeId, fullName: '', active: false },
              update: { active: false },
            });
            // Из прошедших звонков участника не убираем: история встреч —
            // это факт, а не список действующих сотрудников.
            return;
          }

          default:
            return;
        }
      },
    );
  }
}
