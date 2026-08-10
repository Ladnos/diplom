import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { SERVICES } from '@crm/contracts';
import { DEADLINES_MS, grpcClientToken } from '@crm/grpc-clients';

export interface ShiftDto {
  shift_id: string;
  employee_id: string;
  date: string;
  starts_at: string;
  ends_at: string;
  break_minutes: number;
  template_id: string;
}

export interface AbsenceDto {
  absence_id: string;
  employee_id: string;
  type: string;
  period: { from: string; to: string };
  request_id: string;
}

export interface TemplateDto {
  template_id: string;
  name: string;
  kind: string;
  weekdays: number[];
  cycle_length: number;
  cycle_work_days: number[];
  cycle_anchor: string;
  start_time: string;
  end_time: string;
  break_minutes: number;
  active: boolean;
}

export interface TimesheetEntryDto {
  date: string;
  norm_minutes: number;
  absence_minutes: number;
  overtime_minutes: number;
  total_minutes: number;
  source: string;
}

export interface TimesheetDto {
  employee_id: string;
  period: { from: string; to: string };
  entries: TimesheetEntryDto[];
  total_minutes: number;
  total_overtime_minutes: number;
  closed: boolean;
}

interface ScheduleGrpc {
  GetShiftsForPeriod(data: {
    employee_ids: string[];
    period: { from: string; to: string };
  }): Observable<{ shifts: ShiftDto[] }>;
  GetAbsences(data: {
    employee_ids: string[];
    period: { from: string; to: string };
  }): Observable<{ absences: AbsenceDto[] }>;
  ApplyTemplate(data: {
    employee_ids: string[];
    template_id: string;
    period: { from: string; to: string };
  }): Observable<{ shifts: ShiftDto[] }>;
  RegisterAbsence(data: {
    employee_id: string;
    type: string;
    period: { from: string; to: string };
    request_id?: string;
  }): Observable<AbsenceDto>;
  ListTemplates(data: Record<string, never>): Observable<{ templates: TemplateDto[] }>;
  CreateTemplate(data: Record<string, unknown>): Observable<TemplateDto>;
  GetCalendar(data: { period: { from: string; to: string } }): Observable<{
    days: { date: string; kind: string; note: string }[];
  }>;
  SetCalendarDay(data: { date: string; kind: string; note?: string }): Observable<{
    date: string;
    kind: string;
    note: string;
  }>;
  SeedCalendarYear(data: { year: number }): Observable<{ value: number }>;
  GetNormHours(data: {
    employee_id: string;
    period: { from: string; to: string };
  }): Observable<{ norm_minutes: number; working_days: number }>;
}

interface TimesheetGrpc {
  GetTimesheet(data: {
    employee_id: string;
    period: { from: string; to: string };
  }): Observable<TimesheetDto>;
  GetTeamTimesheet(data: {
    manager_id: string;
    period: { from: string; to: string };
  }): Observable<{ timesheets: TimesheetDto[] }>;
  RegisterOvertime(data: {
    employee_id: string;
    date: string;
    minutes: number;
    reason?: string;
  }): Observable<{ date: string; overtime_minutes: number }>;
  ApplyCorrection(data: {
    employee_id: string;
    date: string;
    total_minutes: number;
    reason?: string;
  }): Observable<{ date: string; total_minutes: number }>;
  ClosePeriod(data: {
    department_id?: string;
    period: { from: string; to: string };
    actor_employee_id: string;
  }): Observable<{
    period_id: string;
    closed: boolean;
    period: { from: string; to: string };
    total_minutes: number;
    skipped: { employee_id: string; reason: string }[];
  }>;
  ReopenPeriod(data: {
    department_id?: string;
    period: { from: string; to: string };
    reason?: string;
  }): Observable<{ period_id: string; closed: boolean; period: { from: string; to: string } }>;
}

/**
 * Клиент к модулям schedule и timesheet сервиса hr-service.
 *
 * Оба живут в пакете hr и обслуживаются одним контейнером (ADR-1), но
 * это ДВА разных gRPC-сервиса. Обращение к ним по отдельности, а не
 * через один общий интерфейс, — то, что позволит вынести любой модуль
 * в отдельный контейнер, поменяв здесь только URL.
 */
@Injectable()
export class ScheduleClient implements OnModuleInit {
  private schedule!: ScheduleGrpc;
  private timesheetSvc!: TimesheetGrpc;

  constructor(@Inject(grpcClientToken(SERVICES.HR)) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.schedule = this.client.getService<ScheduleGrpc>('ScheduleService');
    this.timesheetSvc = this.client.getService<TimesheetGrpc>('TimesheetService');
  }

  // ── График ───────────────────────────────────────────────────────────

  getShifts(employeeIds: string[], from: string, to: string) {
    return firstValueFrom(
      this.schedule
        .GetShiftsForPeriod({ employee_ids: employeeIds, period: { from, to } })
        .pipe(timeout(DEADLINES_MS.REPORTING)),
    );
  }

  getAbsences(employeeIds: string[], from: string, to: string) {
    return firstValueFrom(
      this.schedule
        .GetAbsences({ employee_ids: employeeIds, period: { from, to } })
        .pipe(timeout(DEADLINES_MS.REPORTING)),
    );
  }

  applyTemplate(employeeIds: string[], templateId: string, from: string, to: string) {
    return firstValueFrom(
      this.schedule
        .ApplyTemplate({ employee_ids: employeeIds, template_id: templateId, period: { from, to } })
        .pipe(timeout(DEADLINES_MS.REPORTING)),
    );
  }

  registerAbsence(input: { employeeId: string; type: string; from: string; to: string }) {
    return firstValueFrom(
      this.schedule
        .RegisterAbsence({
          employee_id: input.employeeId,
          type: input.type,
          period: { from: input.from, to: input.to },
        })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  listTemplates() {
    return firstValueFrom(this.schedule.ListTemplates({}).pipe(timeout(DEADLINES_MS.DEFAULT)));
  }

  createTemplate(data: Record<string, unknown>) {
    return firstValueFrom(this.schedule.CreateTemplate(data).pipe(timeout(DEADLINES_MS.DEFAULT)));
  }

  getNormHours(employeeId: string, from: string, to: string) {
    return firstValueFrom(
      this.schedule
        .GetNormHours({ employee_id: employeeId, period: { from, to } })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  // ── Производственный календарь ───────────────────────────────────────

  getCalendar(from: string, to: string) {
    return firstValueFrom(
      this.schedule.GetCalendar({ period: { from, to } }).pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  setCalendarDay(date: string, kind: string, note?: string) {
    return firstValueFrom(
      this.schedule.SetCalendarDay({ date, kind, note }).pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  seedCalendarYear(year: number) {
    return firstValueFrom(
      this.schedule.SeedCalendarYear({ year }).pipe(timeout(DEADLINES_MS.REPORTING)),
    );
  }

  // ── Табель ───────────────────────────────────────────────────────────

  getTimesheet(employeeId: string, from: string, to: string) {
    return firstValueFrom(
      this.timesheetSvc
        .GetTimesheet({ employee_id: employeeId, period: { from, to } })
        .pipe(timeout(DEADLINES_MS.REPORTING)),
    );
  }

  getTeamTimesheet(managerId: string, from: string, to: string) {
    return firstValueFrom(
      this.timesheetSvc
        .GetTeamTimesheet({ manager_id: managerId, period: { from, to } })
        .pipe(timeout(DEADLINES_MS.REPORTING)),
    );
  }

  registerOvertime(input: { employeeId: string; date: string; minutes: number; reason?: string }) {
    return firstValueFrom(
      this.timesheetSvc
        .RegisterOvertime({
          employee_id: input.employeeId,
          date: input.date,
          minutes: input.minutes,
          reason: input.reason,
        })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  applyCorrection(input: {
    employeeId: string;
    date: string;
    totalMinutes: number;
    reason?: string;
  }) {
    return firstValueFrom(
      this.timesheetSvc
        .ApplyCorrection({
          employee_id: input.employeeId,
          date: input.date,
          total_minutes: input.totalMinutes,
          reason: input.reason,
        })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  closePeriod(input: {
    departmentId?: string;
    from: string;
    to: string;
    actorEmployeeId: string;
  }) {
    return firstValueFrom(
      this.timesheetSvc
        .ClosePeriod({
          department_id: input.departmentId,
          period: { from: input.from, to: input.to },
          actor_employee_id: input.actorEmployeeId,
        })
        .pipe(timeout(DEADLINES_MS.REPORTING)),
    );
  }

  reopenPeriod(input: { departmentId?: string; from: string; to: string; reason: string }) {
    return firstValueFrom(
      this.timesheetSvc
        .ReopenPeriod({
          department_id: input.departmentId,
          period: { from: input.from, to: input.to },
          reason: input.reason,
        })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }
}
