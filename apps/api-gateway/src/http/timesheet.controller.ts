import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ScheduleClient, type TimesheetDto } from '../clients/schedule.client';
import type { AuthenticatedUser } from '../auth/auth.guard';
import { CurrentUser, RequirePermission } from '../auth/permission.guard';
import { ClosePeriodDto, CorrectionDto, OvertimeDto, PeriodQuery, ReopenPeriodDto } from './dto';

/**
 * Табель рабочего времени.
 *
 * Записи вычисляются на лету по формуле «норма по графику − отсутствия +
 * согласованные переработки» (ADR-2). Фактическое время прихода и ухода
 * не фиксируется: при окладной оплате оно не влияет ни на одно решение.
 */
@Controller('api/timesheet')
export class TimesheetController {
  constructor(private readonly hr: ScheduleClient) {}

  @Get()
  @RequirePermission({ resource: 'timesheet', action: 'read', ownerFrom: { query: 'employeeId' } })
  async getTimesheet(@Query() query: PeriodQuery, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = query.employeeId ?? user.employeeId;
    if (!employeeId) {
      throw new BadRequestException('профиль сотрудника ещё не создан; укажите employeeId явно');
    }
    const sheet = await this.hr.getTimesheet(employeeId, query.from, query.to);
    return toPublicTimesheet(sheet);
  }

  /** Табель всех подчинённых — дашборд руководителя. */
  @Get('team')
  @RequirePermission({ resource: 'timesheet', action: 'read' })
  async getTeamTimesheet(@Query() query: PeriodQuery, @CurrentUser() user: AuthenticatedUser) {
    if (!user.employeeId) {
      throw new BadRequestException('профиль сотрудника ещё не создан');
    }
    const result = await this.hr.getTeamTimesheet(user.employeeId, query.from, query.to);
    const timesheets = result.timesheets.map(toPublicTimesheet);

    return {
      period: { from: query.from, to: query.to },
      employees: timesheets.length,
      totalMinutes: timesheets.reduce((sum, sheet) => sum + sheet.totalMinutes, 0),
      timesheets,
    };
  }

  /**
   * Регистрация переработки приказом.
   *
   * Штатный путь — заявка через approval-service с утверждением
   * руководителем; здесь ручное оформление кадровиком. В обоих случаях
   * переработка СОГЛАСУЕТСЯ, а не измеряется: система не фиксирует
   * фактическое время и вывести переработку ей неоткуда (ADR-2).
   */
  @Post('overtime')
  @RequirePermission({ resource: 'timesheet', action: 'write', ownerFrom: { body: 'employeeId' } })
  async registerOvertime(@Body() dto: OvertimeDto) {
    const result = await this.hr.registerOvertime({
      employeeId: dto.employeeId,
      date: dto.date,
      minutes: dto.minutes,
      reason: dto.reason,
    });
    return {
      employeeId: dto.employeeId,
      date: result.date,
      overtimeMinutes: Number(result.overtime_minutes),
    };
  }

  /** Корректировка итога за день. Задаёт значение целиком. */
  @Post('correction')
  @RequirePermission({ resource: 'timesheet', action: 'write', ownerFrom: { body: 'employeeId' } })
  async applyCorrection(@Body() dto: CorrectionDto) {
    const result = await this.hr.applyCorrection({
      employeeId: dto.employeeId,
      date: dto.date,
      totalMinutes: dto.totalMinutes,
      reason: dto.reason,
    });
    return {
      employeeId: dto.employeeId,
      date: result.date,
      totalMinutes: Number(result.total_minutes),
    };
  }

  /**
   * Закрытие периода. После него правки в этих датах блокируются,
   * пока период не будет открыт заново — и это оставит след.
   */
  @Post('close')
  @RequirePermission({ resource: 'timesheet', action: 'write' })
  async closePeriod(@Body() dto: ClosePeriodDto, @CurrentUser() user: AuthenticatedUser) {
    if (!user.employeeId) {
      throw new BadRequestException('закрыть период может только сотрудник с профилем');
    }
    const result = await this.hr.closePeriod({
      departmentId: dto.departmentId,
      from: dto.from,
      to: dto.to,
      actorEmployeeId: user.employeeId,
    });
    const skipped = result.skipped ?? [];
    return {
      periodId: result.period_id,
      period: result.period,
      closed: result.closed,
      totalMinutes: Number(result.total_minutes),
      // Сотрудники, чьё время посчитать не удалось. Их часы НЕ вошли
      // в итог — подставить ноль значило бы занизить отчётность,
      // поэтому они перечислены явно.
      skipped: skipped.map((item) => ({
        employeeId: item.employee_id,
        reason: item.reason,
      })),
      message:
        skipped.length > 0
          ? `период закрыт, но ${skipped.length} сотрудник(ов) исключено из расчёта — см. skipped`
          : 'период закрыт; внесение переработок и корректировок заблокировано',
    };
  }

  @Post('reopen')
  @RequirePermission({ resource: 'timesheet', action: 'write' })
  async reopenPeriod(@Body() dto: ReopenPeriodDto) {
    const result = await this.hr.reopenPeriod({
      departmentId: dto.departmentId,
      from: dto.from,
      to: dto.to,
      reason: dto.reason,
    });
    return {
      periodId: result.period_id,
      period: result.period,
      closed: result.closed,
      message: 'период открыт заново; изменение зафиксировано в журнале аудита',
    };
  }
}

function toPublicTimesheet(sheet: TimesheetDto) {
  const totalMinutes = Number(sheet.total_minutes);
  return {
    employeeId: sheet.employee_id,
    period: sheet.period,
    entries: (sheet.entries ?? []).map((entry) => ({
      date: entry.date,
      normMinutes: Number(entry.norm_minutes),
      absenceMinutes: Number(entry.absence_minutes),
      overtimeMinutes: Number(entry.overtime_minutes),
      totalMinutes: Number(entry.total_minutes),
      // PLAN — рассчитано от нормы графика, FACT — из фактического учёта
      // (появится вместе с attendance-service), CORRECTION — правка.
      source: entry.source,
    })),
    totalMinutes,
    totalHours: Math.round((totalMinutes / 60) * 100) / 100,
    totalOvertimeMinutes: Number(sheet.total_overtime_minutes),
    closed: sheet.closed,
  };
}
