import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import {
  HrEvents,
  type OvertimeRegistered,
  type RequestContext,
  type TimesheetClosed,
  type TimesheetCorrected,
  type TimesheetReopened,
} from '@crm/contracts';
import { getRequestContext } from '@crm/common';
import { EventPublisher } from '@crm/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { outboxRow } from '../prisma/outbox.store';
import { capabilitiesOf } from '../staff/employment-policy';
import { ScheduleService } from '../schedule/schedule.service';
import { eachDate, normalizePeriod, parseDate, toIsoDate, type IsoDate } from '../schedule/date.util';
import { WorkedTimeSourceResolver } from './worked-time.source';

/**
 * Ключ области периода. 'ALL' для общесистемного закрытия — см.
 * комментарий к scopeKey в schema.prisma: NULL в уникальном индексе
 * PostgreSQL не конфликтует сам с собой.
 */
const ALL_DEPARTMENTS = 'ALL';

function scopeKeyOf(departmentId?: string | null): string {
  return departmentId ?? ALL_DEPARTMENTS;
}

export type EntrySource = 'PLAN' | 'FACT' | 'CORRECTION';

export interface TimesheetEntry {
  date: IsoDate;
  normMinutes: number;
  absenceMinutes: number;
  overtimeMinutes: number;
  totalMinutes: number;
  source: EntrySource;
  absenceType?: string;
}

export interface Timesheet {
  employeeId: string;
  period: { from: IsoDate; to: IsoDate };
  entries: TimesheetEntry[];
  totalMinutes: number;
  totalOvertimeMinutes: number;
  totalAbsenceMinutes: number;
  closed: boolean;
  /** Пусто, если табель ведётся; иначе — причина, по которой его нет. */
  notApplicableReason?: string;
}

/**
 * Расчётный табель. docs/architecture.md ADR-2
 *
 * Записи табеля НЕ хранятся, а вычисляются каждый раз:
 *
 *     отработано = норма по графику − отсутствия + согласованные переработки
 *
 * Хранение готовых записей означало бы, что изменение графика задним
 * числом не отражается в табеле, пока кто-то не пересчитает его вручную.
 * Расчёт вместо хранения убирает целый класс расхождений: единственный
 * источник истины — график, отсутствия и корректировки.
 *
 * Исключение — ЗАКРЫТЫЙ период: там сохраняется снимок итога, потому что
 * сданная в бухгалтерию отчётность меняться задним числом не должна.
 */
@Injectable()
export class TimesheetService {
  private readonly logger = new Logger(TimesheetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: ScheduleService,
    private readonly sources: WorkedTimeSourceResolver,
    private readonly publisher: EventPublisher,
  ) {}

  // ── Расчёт ───────────────────────────────────────────────────────────

  async getTimesheet(employeeId: string, from: IsoDate, to: IsoDate): Promise<Timesheet> {
    const period = this.period(from, to);

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      include: { contracts: { orderBy: { validFrom: 'desc' }, take: 1 } },
    });
    if (!employee) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'сотрудник не найден' });
    }

    const policy = employee.contracts[0]?.policy;
    const empty: Timesheet = {
      employeeId,
      period: { from, to },
      entries: [],
      totalMinutes: 0,
      totalOvertimeMinutes: 0,
      totalAbsenceMinutes: 0,
      closed: false,
    };

    if (!policy) {
      return { ...empty, notApplicableReason: 'у сотрудника нет действующего договора' };
    }

    // Для ГПХ, самозанятых и сдельщиков табель не ведётся — и это
    // защитное поведение, а не отсутствие функции (§3.3).
    if (!capabilitiesOf(policy).timesheet) {
      return {
        ...empty,
        notApplicableReason:
          `табель не ведётся при типе учёта ${policy}: ` +
          'учёт рабочего времени применим только к трудовым отношениям',
      };
    }

    // Здесь и находится точка ветвления задела §3.4: NORM_BASED уходит
    // в график, FACT_BASED — в attendance-service (пока UNIMPLEMENTED).
    const source = this.sources.resolve(policy);
    const worked = await source.getWorkedMinutes(employeeId, from, to);
    const workedByDate = new Map(worked.map((item) => [item.date, item]));

    const [absences, adjustments, closedPeriod] = await Promise.all([
      this.schedule.getAbsences([employeeId], from, to),
      this.prisma.timesheetAdjustment.findMany({
        where: { employeeId, date: { gte: period.from, lte: period.to } },
      }),
      this.findClosedPeriod(employee.departmentId, period.from, period.to),
    ]);

    const overtimeByDate = new Map<IsoDate, number>();
    const correctionByDate = new Map<IsoDate, number>();
    for (const adjustment of adjustments) {
      const iso = toIsoDate(adjustment.date);
      if (adjustment.kind === 'OVERTIME') {
        overtimeByDate.set(iso, (overtimeByDate.get(iso) ?? 0) + adjustment.minutes);
      } else {
        // Корректировка задаёт итог за день целиком. Последняя выигрывает.
        correctionByDate.set(iso, adjustment.minutes);
      }
    }

    const entries: TimesheetEntry[] = [];

    for (const date of eachDate(period.from, period.to)) {
      const iso = toIsoDate(date);
      const plan = workedByDate.get(iso);
      const normMinutes = plan?.minutes ?? 0;

      const absence = absences.find(
        (item) => item.dateFrom <= date && item.dateTo >= date,
      );
      // Отсутствие «съедает» плановую норму дня целиком: в отпуске
      // сотрудник не работает, но день остаётся в табеле с отметкой.
      const absenceMinutes = absence ? normMinutes : 0;
      const overtimeMinutes = overtimeByDate.get(iso) ?? 0;

      const correction = correctionByDate.get(iso);
      const computed = normMinutes - absenceMinutes + overtimeMinutes;

      // Пустые дни (выходные без переработок) в табель не попадают:
      // строка «0 минут» ничего не сообщает, а объём ответа утраивает.
      if (correction === undefined && computed === 0 && !absence) continue;

      entries.push({
        date: iso,
        normMinutes,
        absenceMinutes,
        overtimeMinutes,
        totalMinutes: correction ?? computed,
        source: correction !== undefined ? 'CORRECTION' : (plan?.source ?? 'PLAN'),
        absenceType: absence?.type,
      });
    }

    return {
      employeeId,
      period: { from, to },
      entries,
      totalMinutes: entries.reduce((sum, entry) => sum + entry.totalMinutes, 0),
      totalOvertimeMinutes: entries.reduce((sum, entry) => sum + entry.overtimeMinutes, 0),
      totalAbsenceMinutes: entries.reduce((sum, entry) => sum + entry.absenceMinutes, 0),
      closed: closedPeriod?.closed ?? false,
    };
  }

  /** Табель по всем подчинённым — дашборд руководителя. */
  async getTeamTimesheet(managerId: string, from: IsoDate, to: IsoDate): Promise<Timesheet[]> {
    const subordinates = await this.prisma.employee.findMany({
      where: { managerId, active: true },
      select: { id: true },
    });
    return Promise.all(
      subordinates.map((employee) => this.getTimesheet(employee.id, from, to)),
    );
  }

  // ── Переработки и корректировки ──────────────────────────────────────

  /**
   * Регистрация переработки.
   *
   * Переработка не измеряется, а СОГЛАСУЕТСЯ (ADR-2): штатный источник —
   * утверждённая заявка из approval-service. Прямой вызов кадровиком
   * (оформление приказом) допустим и отличается пустым requestId.
   */
  async registerOvertime(
    input: {
      employeeId: string;
      date: IsoDate;
      minutes: number;
      requestId?: string;
      reason?: string;
      actorEmployeeId?: string;
    },
    context: RequestContext = getRequestContext(),
  ) {
    if (input.minutes <= 0 || input.minutes > 12 * 60) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'переработка должна быть от 1 минуты до 12 часов',
      });
    }

    await this.assertTimesheetApplicable(input.employeeId);
    await this.assertPeriodOpen(input.employeeId, input.date);

    if (input.requestId) {
      const existing = await this.prisma.timesheetAdjustment.findUnique({
        where: { requestId: input.requestId },
      });
      if (existing) return existing;
    }

    const date = parseDate(input.date);

    // Переработка вне рабочего дня по графику — не ошибка (вызвали
    // в выходной), но повод зафиксировать: такие случаи оформляются иначе.
    const shift = await this.prisma.shift.findUnique({
      where: { employeeId_date: { employeeId: input.employeeId, date } },
    });
    if (!shift) {
      this.logger.log({
        message: 'переработка в день, не являющийся рабочим по графику',
        employeeId: input.employeeId,
        date: input.date,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const adjustment = await tx.timesheetAdjustment.create({
        data: {
          employeeId: input.employeeId,
          date,
          kind: 'OVERTIME',
          minutes: input.minutes,
          requestId: input.requestId ?? null,
          reason: input.reason ?? null,
          createdBy: input.actorEmployeeId ?? null,
        },
      });

      // Подтверждающее событие саги: approval-service переведёт заявку
      // в APPLIED по requestId (§10.4).
      const envelope = this.publisher.wrap<OvertimeRegistered>(
        HrEvents.OVERTIME_REGISTERED,
        {
          requestId: input.requestId ?? '',
          employeeId: input.employeeId,
          date: input.date,
          minutes: input.minutes,
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      return adjustment;
    });
  }

  /** Ручная корректировка итога за день. Задаёт значение целиком. */
  async applyCorrection(
    input: {
      employeeId: string;
      date: IsoDate;
      totalMinutes: number;
      requestId?: string;
      reason?: string;
      actorEmployeeId?: string;
    },
    context: RequestContext = getRequestContext(),
  ) {
    if (input.totalMinutes < 0 || input.totalMinutes > 24 * 60) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'итог за день должен быть от 0 до 24 часов',
      });
    }

    await this.assertTimesheetApplicable(input.employeeId);
    await this.assertPeriodOpen(input.employeeId, input.date);

    if (input.requestId) {
      const existing = await this.prisma.timesheetAdjustment.findUnique({
        where: { requestId: input.requestId },
      });
      if (existing) return existing;
    }

    const date = parseDate(input.date);
    const before = await this.getTimesheet(input.employeeId, input.date, input.date);
    const beforeMinutes = before.entries[0]?.totalMinutes ?? 0;

    return this.prisma.$transaction(async (tx) => {
      const adjustment = await tx.timesheetAdjustment.create({
        data: {
          employeeId: input.employeeId,
          date,
          kind: 'CORRECTION',
          minutes: input.totalMinutes,
          requestId: input.requestId ?? null,
          reason: input.reason ?? null,
          createdBy: input.actorEmployeeId ?? null,
        },
      });

      const envelope = this.publisher.wrap<TimesheetCorrected>(
        HrEvents.TIMESHEET_CORRECTED,
        {
          requestId: input.requestId ?? '',
          employeeId: input.employeeId,
          date: input.date,
          beforeMinutes,
          afterMinutes: input.totalMinutes,
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      return adjustment;
    });
  }

  // ── Закрытие периода ─────────────────────────────────────────────────

  /**
   * Закрытие периода фиксирует итог снимком.
   *
   * После закрытия правки блокируются: переработку или корректировку
   * в закрытый месяц внести нельзя, пока период не открыт заново — и
   * повторное открытие оставляет след в журнале аудита.
   */
  async closePeriod(
    input: {
      departmentId?: string;
      from: IsoDate;
      to: IsoDate;
      actorEmployeeId: string;
    },
    context: RequestContext = getRequestContext(),
  ) {
    const period = this.period(input.from, input.to);

    const employees = await this.prisma.employee.findMany({
      where: {
        active: true,
        ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      },
      select: { id: true },
    });

    let totalMinutes = 0;
    const skipped: { employeeId: string; reason: string }[] = [];

    for (const employee of employees) {
      try {
        const sheet = await this.getTimesheet(employee.id, input.from, input.to);
        totalMinutes += sheet.totalMinutes;
      } catch (error) {
        // Один сотрудник, чьё время посчитать нельзя, не должен срывать
        // закрытие месяца для всего отдела. Такое возможно уже сегодня:
        // у сотрудника с почасовой оплатой источник данных —
        // attendance-service, который не реализован (§3.4).
        //
        // Молча подставить ноль нельзя: итог занизился бы, а табель
        // сдаётся в бухгалтерию. Поэтому сотрудник исключается ЯВНО
        // и попадает в ответ.
        const reason = error instanceof Error ? error.message : String(error);
        skipped.push({ employeeId: employee.id, reason });
        this.logger.warn({
          message: 'сотрудник исключён из закрытия периода: табель не рассчитан',
          employeeId: employee.id,
          reason,
        });
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const saved = await tx.timesheetPeriod.upsert({
        where: {
          scopeKey_periodFrom_periodTo: {
            scopeKey: scopeKeyOf(input.departmentId),
            periodFrom: period.from,
            periodTo: period.to,
          },
        },
        create: {
          departmentId: input.departmentId ?? null,
          scopeKey: scopeKeyOf(input.departmentId),
          periodFrom: period.from,
          periodTo: period.to,
          closed: true,
          closedBy: input.actorEmployeeId,
          closedAt: new Date(),
          totalMinutes,
        },
        update: {
          closed: true,
          closedBy: input.actorEmployeeId,
          closedAt: new Date(),
          totalMinutes,
        },
      });

      const envelope = this.publisher.wrap<TimesheetClosed>(
        HrEvents.TIMESHEET_CLOSED,
        {
          periodId: saved.id,
          departmentId: input.departmentId ?? '',
          period: { from: input.from, to: input.to },
          totalMinutes,
          closedBy: input.actorEmployeeId,
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      this.logger.log({
        message: 'период табеля закрыт',
        from: input.from,
        to: input.to,
        employees: employees.length,
        skipped: skipped.length,
        totalMinutes,
      });
      return { ...saved, skipped };
    });
  }

  async reopenPeriod(
    input: { departmentId?: string; from: IsoDate; to: IsoDate; reason: string },
    context: RequestContext = getRequestContext(),
  ) {
    const period = this.period(input.from, input.to);

    const existing = await this.prisma.timesheetPeriod.findUnique({
      where: {
        scopeKey_periodFrom_periodTo: {
          scopeKey: scopeKeyOf(input.departmentId),
          periodFrom: period.from,
          periodTo: period.to,
        },
      },
    });
    if (!existing || !existing.closed) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'период не закрыт, открывать нечего',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const saved = await tx.timesheetPeriod.update({
        where: { id: existing.id },
        data: { closed: false, closedBy: null, closedAt: null },
      });

      const envelope = this.publisher.wrap<TimesheetReopened>(
        HrEvents.TIMESHEET_REOPENED,
        {
          periodId: saved.id,
          departmentId: input.departmentId ?? '',
          period: { from: input.from, to: input.to },
          reason: input.reason,
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      this.logger.warn({
        message: 'период табеля открыт заново',
        from: input.from,
        to: input.to,
        reason: input.reason,
      });
      return saved;
    });
  }

  // ── Внутреннее ───────────────────────────────────────────────────────

  private period(from: IsoDate, to: IsoDate) {
    try {
      return normalizePeriod(from, to);
    } catch (error) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: error instanceof Error ? error.message : 'некорректный период',
      });
    }
  }

  private async assertTimesheetApplicable(employeeId: string): Promise<void> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      include: { contracts: { orderBy: { validFrom: 'desc' }, take: 1 } },
    });
    const policy = employee?.contracts[0]?.policy;
    if (!policy || !capabilitiesOf(policy).timesheet) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'табель не ведётся для этого типа найма',
      });
    }
  }

  private async assertPeriodOpen(employeeId: string, date: IsoDate): Promise<void> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { departmentId: true },
    });
    const day = parseDate(date);
    const closed = await this.findClosedPeriod(employee?.departmentId ?? null, day, day);

    if (closed?.closed) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message:
          `период с ${toIsoDate(closed.periodFrom)} по ${toIsoDate(closed.periodTo)} закрыт; ` +
          'чтобы внести правку, откройте его заново',
      });
    }
  }

  /** Закрытый период, накрывающий даты. Общесистемные (без отдела) тоже. */
  private async findClosedPeriod(departmentId: string | null, from: Date, to: Date) {
    return this.prisma.timesheetPeriod.findFirst({
      where: {
        closed: true,
        periodFrom: { lte: from },
        periodTo: { gte: to },
        // Период отдела ИЛИ общесистемный: закрытие «по всей компании»
        // блокирует правки в каждом отделе.
        scopeKey: { in: [scopeKeyOf(departmentId), ALL_DEPARTMENTS] },
      },
    });
  }
}
