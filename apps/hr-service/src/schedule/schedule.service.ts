import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import {
  HrEvents,
  type AbsenceRegistered,
  type RequestContext,
  type ScheduleApplied,
  type ShiftAssigned,
  type ShiftCancelled,
} from '@crm/contracts';
import { getRequestContext } from '@crm/common';
import { EventPublisher } from '@crm/messaging';
import type { AbsenceType, Prisma, ScheduleTemplate, Shift } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { outboxRow } from '../prisma/outbox.store';
import { CalendarService, SHORTENED_DAY_REDUCTION_MINUTES, type DayKind } from './calendar.service';
import {
  addDays,
  daysBetween,
  eachDate,
  isoWeekday,
  isWeekend,
  normalizePeriod,
  parseDate,
  shiftDurationMinutes,
  toIsoDate,
  type IsoDate,
} from './date.util';
import { capabilitiesOf } from '../staff/employment-policy';

@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: CalendarService,
    private readonly publisher: EventPublisher,
  ) {}

  // ── Шаблоны ──────────────────────────────────────────────────────────

  async listTemplates(): Promise<ScheduleTemplate[]> {
    return this.prisma.scheduleTemplate.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    });
  }

  async createTemplate(input: {
    name: string;
    kind: 'FIXED_WEEK' | 'SHIFT_CYCLE';
    weekdays?: number[];
    cycleLength?: number;
    cycleWorkDays?: number[];
    cycleAnchor?: IsoDate;
    startTime: string;
    endTime: string;
    breakMinutes?: number;
  }): Promise<ScheduleTemplate> {
    if (input.kind === 'FIXED_WEEK') {
      const weekdays = input.weekdays ?? [];
      if (weekdays.length === 0 || weekdays.some((day) => day < 1 || day > 7)) {
        throw new RpcException({
          code: GrpcStatus.INVALID_ARGUMENT,
          message: 'для недельного графика укажите рабочие дни числами от 1 (пн) до 7 (вс)',
        });
      }
    } else {
      const length = input.cycleLength ?? 0;
      const workDays = input.cycleWorkDays ?? [];
      if (length < 2 || workDays.length === 0 || workDays.some((day) => day < 1 || day > length)) {
        throw new RpcException({
          code: GrpcStatus.INVALID_ARGUMENT,
          message: 'для сменного графика укажите длину цикла и номера рабочих дней внутри него',
        });
      }
    }

    return this.prisma.scheduleTemplate.create({
      data: {
        name: input.name,
        kind: input.kind,
        weekdays: input.kind === 'FIXED_WEEK' ? (input.weekdays ?? []) : [],
        cycleLength: input.kind === 'SHIFT_CYCLE' ? input.cycleLength : null,
        cycleWorkDays: input.kind === 'SHIFT_CYCLE' ? (input.cycleWorkDays ?? []) : [],
        cycleAnchor: input.cycleAnchor ? parseDate(input.cycleAnchor) : null,
        startTime: input.startTime,
        endTime: input.endTime,
        breakMinutes: input.breakMinutes ?? 60,
      },
    });
  }

  // ── Смены ────────────────────────────────────────────────────────────

  async getShiftsForPeriod(employeeIds: string[], from: IsoDate, to: IsoDate): Promise<Shift[]> {
    const period = this.period(from, to);
    return this.prisma.shift.findMany({
      where: {
        ...(employeeIds.length ? { employeeId: { in: employeeIds } } : {}),
        date: { gte: period.from, lte: period.to },
      },
      orderBy: [{ date: 'asc' }, { employeeId: 'asc' }],
    });
  }

  /**
   * Применение шаблона: генерация смен на период.
   *
   * Существующие смены в периоде заменяются — повторный запуск даёт тот
   * же результат. Идемпотентность здесь важнее «бережного» слияния:
   * кадровик правит график итеративно, и накопление дублей от прошлых
   * попыток превратило бы табель в мусор.
   */
  async applyTemplate(
    input: { employeeIds: string[]; templateId: string; from: IsoDate; to: IsoDate },
    context: RequestContext = getRequestContext(),
  ): Promise<Shift[]> {
    const period = this.period(input.from, input.to);
    const template = await this.prisma.scheduleTemplate.findUnique({
      where: { id: input.templateId },
    });
    if (!template) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'шаблон графика не найден' });
    }

    const employees = await this.prisma.employee.findMany({
      where: { id: { in: input.employeeIds }, active: true },
      include: { contracts: { orderBy: { validFrom: 'desc' }, take: 1 } },
    });

    // График применим не ко всем: у исполнителя по ГПХ его быть не должно
    // (§3.3) — это признак трудовых отношений в гражданском договоре.
    const applicable = employees.filter((employee) => {
      const policy = employee.contracts[0]?.policy;
      return policy ? capabilitiesOf(policy).schedule : false;
    });
    const rejected = employees.filter((employee) => !applicable.includes(employee));

    if (applicable.length === 0) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message:
          'ни одному из указанных сотрудников график не назначается: ' +
          'проверьте тип найма — для ГПХ и самозанятых учёт рабочего времени не ведётся',
      });
    }
    if (rejected.length > 0) {
      this.logger.warn({
        message: 'часть сотрудников пропущена: график неприменим к их типу найма',
        skipped: rejected.map((employee) => employee.id),
      });
    }

    const dayKinds = await this.calendar.getDayKinds(period.from, period.to);
    const created: Shift[] = [];

    for (const employee of applicable) {
      const planned = this.buildShifts(template, period.from, period.to, dayKinds);
      const normMinutes = planned.reduce(
        (sum, shift) => sum + shiftDurationMinutes(shift.startsAt, shift.endsAt, shift.breakMinutes),
        0,
      );

      const shifts = await this.prisma.$transaction(async (tx) => {
        await tx.shift.deleteMany({
          where: { employeeId: employee.id, date: { gte: period.from, lte: period.to } },
        });

        await tx.shift.createMany({
          data: planned.map((shift) => ({
            employeeId: employee.id,
            date: shift.date,
            startsAt: shift.startsAt,
            endsAt: shift.endsAt,
            breakMinutes: shift.breakMinutes,
            templateId: template.id,
          })),
        });

        const envelope = this.publisher.wrap<ScheduleApplied>(
          HrEvents.SCHEDULE_APPLIED,
          {
            employeeId: employee.id,
            templateId: template.id,
            templateName: template.name,
            period: { from: input.from, to: input.to },
            shiftsCreated: planned.length,
            normMinutes,
          },
          context,
        );
        await tx.outbox.create({ data: outboxRow(envelope) });

        return tx.shift.findMany({
          where: { employeeId: employee.id, date: { gte: period.from, lte: period.to } },
          orderBy: { date: 'asc' },
        });
      });

      created.push(...shifts);
    }

    this.logger.log({
      message: 'шаблон графика применён',
      templateId: template.id,
      employees: applicable.length,
      shifts: created.length,
    });
    return created;
  }

  /** Точечное назначение или изменение смены. */
  async assignShifts(
    input: {
      shifts: { employeeId: string; date: IsoDate; startsAt: string; endsAt: string; breakMinutes?: number }[];
    },
    context: RequestContext = getRequestContext(),
  ): Promise<Shift[]> {
    const result: Shift[] = [];

    for (const item of input.shifts) {
      const date = parseDate(item.date);
      const shift = await this.prisma.$transaction(async (tx) => {
        const saved = await tx.shift.upsert({
          where: { employeeId_date: { employeeId: item.employeeId, date } },
          create: {
            employeeId: item.employeeId,
            date,
            startsAt: item.startsAt,
            endsAt: item.endsAt,
            breakMinutes: item.breakMinutes ?? 60,
          },
          update: {
            startsAt: item.startsAt,
            endsAt: item.endsAt,
            breakMinutes: item.breakMinutes ?? 60,
          },
        });

        const envelope = this.publisher.wrap<ShiftAssigned>(
          HrEvents.SHIFT_ASSIGNED,
          {
            shiftId: saved.id,
            employeeId: saved.employeeId,
            date: toIsoDate(saved.date),
            startsAt: saved.startsAt,
            endsAt: saved.endsAt,
          },
          context,
        );
        await tx.outbox.create({ data: outboxRow(envelope) });
        return saved;
      });
      result.push(shift);
    }

    return result;
  }

  async cancelShift(
    shiftId: string,
    reason: string,
    context: RequestContext = getRequestContext(),
  ): Promise<void> {
    const shift = await this.prisma.shift.findUnique({ where: { id: shiftId } });
    if (!shift) return;

    await this.prisma.$transaction(async (tx) => {
      await tx.shift.delete({ where: { id: shiftId } });
      const envelope = this.publisher.wrap<ShiftCancelled>(
        HrEvents.SHIFT_CANCELLED,
        {
          shiftId: shift.id,
          employeeId: shift.employeeId,
          date: toIsoDate(shift.date),
          reason,
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });
    });
  }

  // ── Отсутствия ───────────────────────────────────────────────────────

  async getAbsences(employeeIds: string[], from: IsoDate, to: IsoDate) {
    const period = this.period(from, to);
    return this.prisma.absence.findMany({
      where: {
        ...(employeeIds.length ? { employeeId: { in: employeeIds } } : {}),
        // Пересечение с периодом, а не вхождение: отпуск, начавшийся
        // в прошлом месяце, влияет и на текущий.
        dateFrom: { lte: period.to },
        dateTo: { gte: period.from },
      },
      orderBy: { dateFrom: 'asc' },
    });
  }

  /**
   * Регистрация отсутствия.
   *
   * Вызывается из двух мест: потребителем approval.request.approved
   * (сотрудник подал заявку, руководитель утвердил) и напрямую кадровиком
   * (оформление приказом). Во втором случае requestId пуст.
   */
  async registerAbsence(
    input: {
      employeeId: string;
      type: AbsenceType;
      from: IsoDate;
      to: IsoDate;
      requestId?: string;
      comment?: string;
    },
    context: RequestContext = getRequestContext(),
  ) {
    const period = this.period(input.from, input.to);

    const employee = await this.prisma.employee.findUnique({
      where: { id: input.employeeId },
      include: { contracts: { orderBy: { validFrom: 'desc' }, take: 1 } },
    });
    if (!employee || !employee.active) {
      throw new RpcException({
        code: GrpcStatus.NOT_FOUND,
        message: 'сотрудник не найден или уволен',
      });
    }

    const policy = employee.contracts[0]?.policy;
    if (!policy || !capabilitiesOf(policy).leave) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message:
          'отпуска и больничные не применимы к этому типу найма: ' +
          'права на них дают трудовые отношения, а не гражданско-правовой договор',
      });
    }

    // Повторная доставка события согласования не должна создать второй
    // отпуск: requestId уникален на уровне БД, а проверка даёт понятный
    // ответ вместо ошибки нарушения ограничения.
    if (input.requestId) {
      const existing = await this.prisma.absence.findUnique({
        where: { requestId: input.requestId },
      });
      if (existing) return existing;
    }

    const overlapping = await this.prisma.absence.findFirst({
      where: {
        employeeId: input.employeeId,
        dateFrom: { lte: period.to },
        dateTo: { gte: period.from },
      },
    });
    if (overlapping) {
      throw new RpcException({
        code: GrpcStatus.ALREADY_EXISTS,
        message: `период пересекается с уже оформленным отсутствием с ${toIsoDate(overlapping.dateFrom)} по ${toIsoDate(overlapping.dateTo)}`,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const absence = await tx.absence.create({
        data: {
          employeeId: input.employeeId,
          type: input.type,
          dateFrom: period.from,
          dateTo: period.to,
          requestId: input.requestId ?? null,
          comment: input.comment ?? null,
        },
      });

      // Подтверждающее событие саги: approval-service по requestId
      // переведёт заявку в APPLIED (§10.3).
      const envelope = this.publisher.wrap<AbsenceRegistered>(
        HrEvents.ABSENCE_REGISTERED,
        {
          requestId: input.requestId ?? '',
          absenceId: absence.id,
          employeeId: absence.employeeId,
          type: absence.type,
          period: { from: toIsoDate(absence.dateFrom), to: toIsoDate(absence.dateTo) },
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      this.logger.log({
        message: 'отсутствие зарегистрировано',
        employeeId: absence.employeeId,
        type: absence.type,
        from: toIsoDate(absence.dateFrom),
        to: toIsoDate(absence.dateTo),
      });
      return absence;
    });
  }

  // ── Норма и рабочий контекст ─────────────────────────────────────────

  /** Плановая норма в минутах за период — основа расчёта табеля. */
  async getNormMinutes(employeeId: string, from: IsoDate, to: IsoDate): Promise<{
    normMinutes: number;
    workingDays: number;
  }> {
    const shifts = await this.getShiftsForPeriod([employeeId], from, to);
    return {
      normMinutes: shifts.reduce(
        (sum, shift) => sum + shiftDurationMinutes(shift.startsAt, shift.endsAt, shift.breakMinutes),
        0,
      ),
      workingDays: shifts.length,
    };
  }

  /**
   * Сотрудник + его смена + отсутствие на дату одним запросом.
   * Используется дашбордом руководителя и валидацией заявок.
   */
  async getWorkContext(employeeId: string, date: IsoDate) {
    const day = parseDate(date);

    const [employee, shift, absence] = await Promise.all([
      this.prisma.employee.findUnique({
        where: { id: employeeId },
        include: { contracts: { orderBy: { validFrom: 'desc' }, take: 1 } },
      }),
      this.prisma.shift.findUnique({ where: { employeeId_date: { employeeId, date: day } } }),
      this.prisma.absence.findFirst({
        where: { employeeId, dateFrom: { lte: day }, dateTo: { gte: day } },
      }),
    ]);

    if (!employee) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'сотрудник не найден' });
    }

    return {
      employee,
      shift,
      absence,
      shouldBeWorking: Boolean(shift) && !absence && employee.active,
    };
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

  /**
   * Раскладка шаблона по датам.
   *
   * Недельный график не работает в праздники, сменный — работает: смена
   * «сутки через трое» не прерывается 8 марта. Перенесённая рабочая
   * суббота (WORKDAY) делает выходной рабочим для недельного графика.
   */
  private buildShifts(
    template: ScheduleTemplate,
    from: Date,
    to: Date,
    dayKinds: Map<IsoDate, DayKind>,
  ): { date: Date; startsAt: string; endsAt: string; breakMinutes: number }[] {
    const result: { date: Date; startsAt: string; endsAt: string; breakMinutes: number }[] = [];

    for (const date of eachDate(from, to)) {
      const iso = toIsoDate(date);
      const kind = dayKinds.get(iso) ?? 'WORKING';

      const working =
        template.kind === 'FIXED_WEEK'
          ? this.isFixedWeekWorkday(template, date, kind)
          : this.isCycleWorkday(template, date);

      if (!working) continue;

      // Сокращённый предпраздничный день: минус час (ст. 95 ТК РФ).
      // К сменному графику не применяется — там смена неделима.
      const shortened = kind === 'SHORTENED' && template.kind === 'FIXED_WEEK';
      const endsAt = shortened
        ? shiftEndMinusMinutes(template.endTime, SHORTENED_DAY_REDUCTION_MINUTES)
        : template.endTime;

      result.push({
        date,
        startsAt: template.startTime,
        endsAt,
        breakMinutes: template.breakMinutes,
      });
    }

    return result;
  }

  /**
   * Рабочий ли день при недельном графике.
   *
   * Порядок проверок отражает приоритет источников: праздник и выходной
   * перекрывают шаблон, а перенесённая рабочая суббота перекрывает день
   * недели. Последнее — единственный случай, когда день вне weekdays
   * оказывается рабочим: getDayKinds отдаёт для субботы WORKING только
   * при явной записи WORKDAY в календаре.
   */
  private isFixedWeekWorkday(template: ScheduleTemplate, date: Date, kind: DayKind): boolean {
    if (kind === 'HOLIDAY' || kind === 'WEEKEND') return false;
    if (isWeekend(date)) return true;
    return template.weekdays.includes(isoWeekday(date));
  }

  private isCycleWorkday(template: ScheduleTemplate, date: Date): boolean {
    const anchor = template.cycleAnchor ?? new Date(Date.UTC(2026, 0, 1));
    const length = template.cycleLength ?? 0;
    if (length < 1) return false;

    const offset = ((daysBetween(anchor, date) % length) + length) % length;
    return template.cycleWorkDays.includes(offset + 1);
  }
}

function shiftEndMinusMinutes(endTime: string, minutes: number): string {
  const [hours, mins] = endTime.split(':').map(Number);
  const total = hours * 60 + mins - minutes;
  const normalized = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}
