import { Controller } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { TimesheetService, type Timesheet } from './timesheet.service';
import { toIsoDate } from '../schedule/date.util';

function mapTimesheet(sheet: Timesheet) {
  return {
    employee_id: sheet.employeeId,
    period: sheet.period,
    entries: sheet.entries.map((entry) => ({
      date: entry.date,
      norm_minutes: entry.normMinutes,
      absence_minutes: entry.absenceMinutes,
      overtime_minutes: entry.overtimeMinutes,
      total_minutes: entry.totalMinutes,
      source: entry.source,
    })),
    total_minutes: sheet.totalMinutes,
    total_overtime_minutes: sheet.totalOvertimeMinutes,
    closed: sheet.closed,
  };
}

/**
 * gRPC-интерфейс модуля timesheet (TimesheetService в hr.proto).
 *
 * Записи табеля вычисляются на лету из графика, отсутствий и
 * корректировок — см. TimesheetService и ADR-2.
 */
@Controller()
export class TimesheetGrpcController {
  constructor(private readonly timesheet: TimesheetService) {}

  @GrpcMethod('TimesheetService', 'GetTimesheet')
  async getTimesheet(data: { employee_id: string; period: { from: string; to: string } }) {
    const sheet = await this.timesheet.getTimesheet(
      data.employee_id,
      data.period.from,
      data.period.to,
    );
    return mapTimesheet(sheet);
  }

  @GrpcMethod('TimesheetService', 'GetTeamTimesheet')
  async getTeamTimesheet(data: { manager_id: string; period: { from: string; to: string } }) {
    const sheets = await this.timesheet.getTeamTimesheet(
      data.manager_id,
      data.period.from,
      data.period.to,
    );
    return { timesheets: sheets.map(mapTimesheet) };
  }

  @GrpcMethod('TimesheetService', 'RegisterOvertime')
  async registerOvertime(data: {
    employee_id: string;
    date: string;
    minutes: number;
    request_id?: string;
    reason?: string;
  }) {
    const adjustment = await this.timesheet.registerOvertime({
      employeeId: data.employee_id,
      date: data.date,
      minutes: data.minutes,
      requestId: data.request_id || undefined,
      reason: data.reason || undefined,
    });
    return {
      date: toIsoDate(adjustment.date),
      overtime_minutes: adjustment.minutes,
      source: 'CORRECTION',
    };
  }

  @GrpcMethod('TimesheetService', 'ApplyCorrection')
  async applyCorrection(data: {
    employee_id: string;
    date: string;
    total_minutes: number;
    request_id?: string;
    reason?: string;
  }) {
    const adjustment = await this.timesheet.applyCorrection({
      employeeId: data.employee_id,
      date: data.date,
      totalMinutes: data.total_minutes,
      requestId: data.request_id || undefined,
      reason: data.reason || undefined,
    });
    return {
      date: toIsoDate(adjustment.date),
      total_minutes: adjustment.minutes,
      source: 'CORRECTION',
    };
  }

  @GrpcMethod('TimesheetService', 'ClosePeriod')
  async closePeriod(data: {
    department_id?: string;
    period: { from: string; to: string };
    actor_employee_id: string;
  }) {
    const saved = await this.timesheet.closePeriod({
      departmentId: data.department_id || undefined,
      from: data.period.from,
      to: data.period.to,
      actorEmployeeId: data.actor_employee_id,
    });
    return {
      period_id: saved.id,
      department_id: saved.departmentId ?? '',
      period: { from: toIsoDate(saved.periodFrom), to: toIsoDate(saved.periodTo) },
      closed: saved.closed,
      closed_by: saved.closedBy ?? '',
      closed_at: saved.closedAt?.getTime() ?? 0,
      total_minutes: saved.totalMinutes,
      skipped: saved.skipped.map((item) => ({
        employee_id: item.employeeId,
        reason: item.reason,
      })),
    };
  }

  @GrpcMethod('TimesheetService', 'ReopenPeriod')
  async reopenPeriod(data: {
    department_id?: string;
    period: { from: string; to: string };
    reason?: string;
  }) {
    const saved = await this.timesheet.reopenPeriod({
      departmentId: data.department_id || undefined,
      from: data.period.from,
      to: data.period.to,
      reason: data.reason || 'без указания причины',
    });
    return {
      period_id: saved.id,
      department_id: saved.departmentId ?? '',
      period: { from: toIsoDate(saved.periodFrom), to: toIsoDate(saved.periodTo) },
      closed: saved.closed,
      closed_by: '',
      closed_at: 0,
      total_minutes: saved.totalMinutes,
      skipped: [],
    };
  }

  /**
   * Выгрузка унифицированной формы Т-13.
   *
   * Требует file-service: форма формируется в XLSX и возвращается ссылкой
   * на файл, а не телом ответа — иначе многомегабайтная выгрузка пойдёт
   * через gRPC с его лимитом на размер сообщения. Реализуется вместе
   * с file-service.
   */
  @GrpcMethod('TimesheetService', 'ExportT13')
  exportT13(): never {
    throw new RpcException({
      code: GrpcStatus.UNIMPLEMENTED,
      message: 'выгрузка Т-13 требует file-service, который ещё не реализован',
    });
  }
}
