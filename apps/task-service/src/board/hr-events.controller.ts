import { Controller, Inject, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import {
  HrEvents,
  type AbsenceRegistered,
  type EmployeeCreated,
  type EmployeeDeactivated,
  type EmployeeUpdated,
  type Envelope,
} from '@crm/contracts';
import { PROCESSED_EVENT_STORE, handleEvent, type ProcessedEventStore } from '@crm/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { BoardService } from './board.service';

const CONSUMER = 'task-service';

/**
 * Потребители кадровых событий (очередь task.events, §7.5).
 *
 * Доска обязана отражать реальность отдела без ручной синхронизации:
 * принятый сотрудник должен увидеть доску сам, уволенный — исчезнуть
 * из исполнителей, ушедший в отпуск — быть помеченным, чтобы на него
 * не вешали задачи со сроком внутри отпуска.
 */
@Controller()
export class HrEventsController {
  private readonly logger = new Logger(HrEventsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly boards: BoardService,
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
        await this.prisma.employeeAvailability.upsert({
          where: { employeeId: payload.employeeId },
          create: { employeeId: payload.employeeId, active: true },
          update: { active: true },
        });

        if (!payload.departmentId) return;
        await this.addToDepartmentBoards(payload.departmentId, payload.employeeId);
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
        // Перевод в другой отдел: доступ к доскам нового отдела выдаётся,
        // из старых участие НЕ снимается — по прежним задачам человек
        // остаётся исполнителем и должен их видеть.
        if (!payload.changed.departmentId) return;
        await this.addToDepartmentBoards(payload.changed.departmentId, payload.employeeId);
      },
    );
  }

  /**
   * Увольнение. Карточки не удаляются и не закрываются: работа осталась,
   * её нужно перераспределить. Снимается только исполнитель, чтобы
   * задача попала в поле зрения руководителя как ничейная.
   */
  @EventPattern(HrEvents.EMPLOYEE_DEACTIVATED)
  async onEmployeeDeactivated(
    @Payload() envelope: Envelope<EmployeeDeactivated>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        const unassigned = await this.prisma.card.updateMany({
          where: { assigneeEmployeeId: payload.employeeId, closedAt: null },
          data: { assigneeEmployeeId: null },
        });

        await this.prisma.employeeAvailability.upsert({
          where: { employeeId: payload.employeeId },
          create: { employeeId: payload.employeeId, active: false },
          update: { active: false, absentUntil: null, absenceType: null },
        });

        await this.prisma.boardMember.deleteMany({ where: { employeeId: payload.employeeId } });

        this.logger.log({
          message: 'сотрудник уволен: карточки освобождены',
          employeeId: payload.employeeId,
          unassignedCards: unassigned.count,
        });
      },
    );
  }

  /**
   * Отпуск и больничный. Карточки остаются за исполнителем, но доска
   * показывает, что его не будет: назначать задачу со сроком внутри
   * отпуска бессмысленно, а руководитель об этом узнаёт из интерфейса,
   * а не постфактум.
   */
  @EventPattern(HrEvents.ABSENCE_REGISTERED)
  async onAbsenceRegistered(
    @Payload() envelope: Envelope<AbsenceRegistered>,
    @Ctx() context: RmqContext,
  ) {
    await handleEvent(
      { envelope, context, consumer: CONSUMER, store: this.processed, logger: this.logger },
      async (payload) => {
        await this.prisma.employeeAvailability.upsert({
          where: { employeeId: payload.employeeId },
          create: {
            employeeId: payload.employeeId,
            active: true,
            absentUntil: new Date(payload.period.to),
            absenceType: payload.type,
          },
          update: {
            absentUntil: new Date(payload.period.to),
            absenceType: payload.type,
          },
        });

        // Задачи, срок которых попадает в отсутствие, — повод для
        // руководителя пересмотреть план. Их количество попадает в лог,
        // чтобы это было заметно и без интерфейса.
        const affected = await this.prisma.card.count({
          where: {
            assigneeEmployeeId: payload.employeeId,
            closedAt: null,
            dueDate: { gte: new Date(payload.period.from), lte: new Date(payload.period.to) },
          },
        });
        if (affected > 0) {
          this.logger.warn({
            message: 'у сотрудника есть задачи со сроком внутри отсутствия',
            employeeId: payload.employeeId,
            period: payload.period,
            cards: affected,
          });
        }
      },
    );
  }

  /** Добавление сотрудника во все доски его отдела. */
  private async addToDepartmentBoards(departmentId: string, employeeId: string): Promise<void> {
    const boards = await this.prisma.board.findMany({
      where: { departmentId, archived: false },
      select: { id: true },
    });
    if (boards.length === 0) return;

    for (const board of boards) {
      await this.boards.addMembers({ boardId: board.id, employeeIds: [employeeId] });
    }
    this.logger.log({
      message: 'сотрудник добавлен в доски отдела',
      employeeId,
      departmentId,
      boards: boards.length,
    });
  }
}
