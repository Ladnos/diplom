import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Absence, AbsenceType, CalendarDay, CalendarDayKind, ScheduleTemplate, Shift } from '../../generated/prisma';
import { ScheduleService } from './schedule.service';
import { CalendarService } from './calendar.service';
import { parseDate, toIsoDate } from './date.util';

function mapShift(shift: Shift) {
  return {
    shift_id: shift.id,
    employee_id: shift.employeeId,
    date: toIsoDate(shift.date),
    starts_at: shift.startsAt,
    ends_at: shift.endsAt,
    break_minutes: shift.breakMinutes,
    template_id: shift.templateId ?? '',
  };
}

function mapAbsence(absence: Absence) {
  return {
    absence_id: absence.id,
    employee_id: absence.employeeId,
    type: absence.type,
    period: { from: toIsoDate(absence.dateFrom), to: toIsoDate(absence.dateTo) },
    request_id: absence.requestId ?? '',
  };
}

function mapTemplate(template: ScheduleTemplate) {
  return {
    template_id: template.id,
    name: template.name,
    kind: template.kind,
    weekdays: template.weekdays,
    cycle_length: template.cycleLength ?? 0,
    cycle_work_days: template.cycleWorkDays,
    cycle_anchor: template.cycleAnchor ? toIsoDate(template.cycleAnchor) : '',
    start_time: template.startTime,
    end_time: template.endTime,
    break_minutes: template.breakMinutes,
    active: template.active,
  };
}

function mapCalendarDay(day: CalendarDay) {
  return { date: toIsoDate(day.date), kind: day.kind, note: day.note ?? '' };
}

/**
 * gRPC-интерфейс модуля schedule (ScheduleService в hr.proto).
 * Один из трёх сервисов пакета hr — см. ADR-1.
 */
@Controller()
export class ScheduleGrpcController {
  constructor(
    private readonly schedule: ScheduleService,
    private readonly calendar: CalendarService,
  ) {}

  @GrpcMethod('ScheduleService', 'GetShiftsForPeriod')
  async getShiftsForPeriod(data: {
    employee_ids: string[];
    period: { from: string; to: string };
  }) {
    const shifts = await this.schedule.getShiftsForPeriod(
      data.employee_ids ?? [],
      data.period.from,
      data.period.to,
    );
    return { shifts: shifts.map(mapShift) };
  }

  @GrpcMethod('ScheduleService', 'GetNormHours')
  async getNormHours(data: { employee_id: string; period: { from: string; to: string } }) {
    const result = await this.schedule.getNormMinutes(
      data.employee_id,
      data.period.from,
      data.period.to,
    );
    return { norm_minutes: result.normMinutes, working_days: result.workingDays };
  }

  @GrpcMethod('ScheduleService', 'GetWorkContext')
  async getWorkContext(data: { employee_id: string; date: string }) {
    const context = await this.schedule.getWorkContext(data.employee_id, data.date);
    const contract = context.employee.contracts?.[0];

    return {
      employee: {
        employee_id: context.employee.id,
        user_id: context.employee.userId,
        full_name: context.employee.fullName,
        department_id: context.employee.departmentId ?? '',
        manager_id: context.employee.managerId ?? '',
        active: context.employee.active,
        employment: contract
          ? {
              contract_id: contract.id,
              employee_id: contract.employeeId,
              type: contract.type,
              payment_form: contract.paymentForm,
              policy: contract.policy,
              rate: Number(contract.rate),
              valid_from: toIsoDate(contract.validFrom),
              valid_to: contract.validTo ? toIsoDate(contract.validTo) : '',
            }
          : undefined,
      },
      planned_shift: context.shift ? mapShift(context.shift) : undefined,
      absence: context.absence ? mapAbsence(context.absence) : undefined,
      should_be_working: context.shouldBeWorking,
    };
  }

  @GrpcMethod('ScheduleService', 'GetAbsences')
  async getAbsences(data: { employee_ids: string[]; period: { from: string; to: string } }) {
    const absences = await this.schedule.getAbsences(
      data.employee_ids ?? [],
      data.period.from,
      data.period.to,
    );
    return { absences: absences.map(mapAbsence) };
  }

  @GrpcMethod('ScheduleService', 'AssignShifts')
  async assignShifts(data: {
    shifts: {
      employee_id: string;
      date: string;
      starts_at: string;
      ends_at: string;
      break_minutes?: number;
    }[];
  }) {
    const shifts = await this.schedule.assignShifts({
      shifts: (data.shifts ?? []).map((shift) => ({
        employeeId: shift.employee_id,
        date: shift.date,
        startsAt: shift.starts_at,
        endsAt: shift.ends_at,
        // proto3 отдаёт 0 для незаданного числа — здесь это означало бы
        // смену без перерыва, поэтому ноль трактуем как «по умолчанию».
        breakMinutes: shift.break_minutes && shift.break_minutes > 0 ? shift.break_minutes : 60,
      })),
    });
    return { shifts: shifts.map(mapShift) };
  }

  @GrpcMethod('ScheduleService', 'ApplyTemplate')
  async applyTemplate(data: {
    employee_ids: string[];
    template_id: string;
    period: { from: string; to: string };
  }) {
    const shifts = await this.schedule.applyTemplate({
      employeeIds: data.employee_ids ?? [],
      templateId: data.template_id,
      from: data.period.from,
      to: data.period.to,
    });
    return { shifts: shifts.map(mapShift) };
  }

  @GrpcMethod('ScheduleService', 'RegisterAbsence')
  async registerAbsence(data: {
    employee_id: string;
    type: AbsenceType;
    period: { from: string; to: string };
    request_id?: string;
  }) {
    const absence = await this.schedule.registerAbsence({
      employeeId: data.employee_id,
      type: data.type,
      from: data.period.from,
      to: data.period.to,
      requestId: data.request_id || undefined,
    });
    return mapAbsence(absence);
  }

  @GrpcMethod('ScheduleService', 'CancelShift')
  async cancelShift(data: { shift_id: string; reason?: string }) {
    await this.schedule.cancelShift(data.shift_id, data.reason || 'без указания причины');
    return {};
  }

  @GrpcMethod('ScheduleService', 'ListTemplates')
  async listTemplates() {
    const templates = await this.schedule.listTemplates();
    return { templates: templates.map(mapTemplate) };
  }

  @GrpcMethod('ScheduleService', 'CreateTemplate')
  async createTemplate(data: {
    name: string;
    kind: 'FIXED_WEEK' | 'SHIFT_CYCLE';
    weekdays?: number[];
    cycle_length?: number;
    cycle_work_days?: number[];
    cycle_anchor?: string;
    start_time: string;
    end_time: string;
    break_minutes?: number;
  }) {
    const template = await this.schedule.createTemplate({
      name: data.name,
      kind: data.kind,
      weekdays: data.weekdays,
      cycleLength: data.cycle_length,
      cycleWorkDays: data.cycle_work_days,
      cycleAnchor: data.cycle_anchor || undefined,
      startTime: data.start_time,
      endTime: data.end_time,
      breakMinutes: data.break_minutes && data.break_minutes > 0 ? data.break_minutes : 60,
    });
    return mapTemplate(template);
  }

  @GrpcMethod('ScheduleService', 'GetCalendar')
  async getCalendar(data: { period: { from: string; to: string } }) {
    const days = await this.calendar.listExceptions(
      parseDate(data.period.from),
      parseDate(data.period.to),
    );
    return { days: days.map(mapCalendarDay) };
  }

  @GrpcMethod('ScheduleService', 'SetCalendarDay')
  async setCalendarDay(data: { date: string; kind: CalendarDayKind; note?: string }) {
    const day = await this.calendar.setDay(parseDate(data.date), data.kind, data.note || undefined);
    return mapCalendarDay(day);
  }

  @GrpcMethod('ScheduleService', 'SeedCalendarYear')
  async seedCalendarYear(data: { year: number }) {
    const value = await this.calendar.seedYear(data.year);
    return { value };
  }
}
