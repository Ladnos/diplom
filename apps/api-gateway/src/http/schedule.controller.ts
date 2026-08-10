import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ScheduleClient, type ShiftDto } from '../clients/schedule.client';
import type { AuthenticatedUser } from '../auth/auth.guard';
import { CurrentUser, PermissionScope, RequirePermission } from '../auth/permission.guard';
import {
  ApplyTemplateDto,
  CalendarDayDto,
  CreateTemplateDto,
  PeriodQuery,
  RegisterAbsenceDto,
  SeedYearDto,
} from './dto';

/**
 * Графики работы, отсутствия и производственный календарь.
 *
 * Права проверяются по scope: сотрудник видит свой график, руководитель —
 * подчинённых, кадровик — всех. Сам список формирует hr-service, ничего
 * не знающий о правах, поэтому область действия применяется здесь.
 */
@Controller('api/schedule')
export class ScheduleController {
  constructor(private readonly schedule: ScheduleClient) {}

  // ── Смены ────────────────────────────────────────────────────────────

  @Get('shifts')
  @RequirePermission({ resource: 'shift', action: 'read', ownerFrom: { query: 'employeeId' } })
  async getShifts(@Query() query: PeriodQuery, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = this.resolveEmployee(query.employeeId, user);
    const result = await this.schedule.getShifts([employeeId], query.from, query.to);
    return { shifts: result.shifts.map(toPublicShift) };
  }

  /**
   * Норма рабочего времени за период — плановая основа табеля.
   * Отдельным методом, потому что интерфейсу она нужна и без списка смен.
   */
  @Get('norm')
  @RequirePermission({ resource: 'shift', action: 'read', ownerFrom: { query: 'employeeId' } })
  async getNorm(@Query() query: PeriodQuery, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = this.resolveEmployee(query.employeeId, user);
    const result = await this.schedule.getNormHours(employeeId, query.from, query.to);
    return {
      employeeId,
      normMinutes: Number(result.norm_minutes),
      normHours: Math.round((Number(result.norm_minutes) / 60) * 100) / 100,
      workingDays: Number(result.working_days),
    };
  }

  /**
   * Массовое назначение графика по шаблону.
   *
   * Сотрудникам, к типу найма которых график неприменим (ГПХ,
   * самозанятые), он не назначается — hr-service их пропускает.
   */
  @Post('apply')
  @RequirePermission({ resource: 'shift', action: 'write' })
  async applyTemplate(@Body() dto: ApplyTemplateDto) {
    const result = await this.schedule.applyTemplate(
      dto.employeeIds,
      dto.templateId,
      dto.from,
      dto.to,
    );
    return {
      shifts: result.shifts.length,
      employees: new Set(result.shifts.map((shift) => shift.employee_id)).size,
      period: { from: dto.from, to: dto.to },
    };
  }

  // ── Шаблоны ──────────────────────────────────────────────────────────

  @Get('templates')
  @RequirePermission({ resource: 'shift', action: 'read' })
  async listTemplates() {
    const result = await this.schedule.listTemplates();
    return {
      templates: result.templates.map((template) => ({
        templateId: template.template_id,
        name: template.name,
        kind: template.kind,
        weekdays: template.weekdays ?? [],
        cycleLength: template.cycle_length || null,
        cycleWorkDays: template.cycle_work_days ?? [],
        cycleAnchor: template.cycle_anchor || null,
        startTime: template.start_time,
        endTime: template.end_time,
        breakMinutes: template.break_minutes,
      })),
    };
  }

  @Post('templates')
  @RequirePermission({ resource: 'shift', action: 'write' })
  async createTemplate(@Body() dto: CreateTemplateDto) {
    const template = await this.schedule.createTemplate({
      name: dto.name,
      kind: dto.kind,
      weekdays: dto.weekdays ?? [],
      cycle_length: dto.cycleLength ?? 0,
      cycle_work_days: dto.cycleWorkDays ?? [],
      cycle_anchor: dto.cycleAnchor ?? '',
      start_time: dto.startTime,
      end_time: dto.endTime,
      break_minutes: dto.breakMinutes ?? 60,
    });
    return { templateId: template.template_id, name: template.name, kind: template.kind };
  }

  // ── Отсутствия ───────────────────────────────────────────────────────

  @Get('absences')
  @RequirePermission({ resource: 'absence', action: 'read', ownerFrom: { query: 'employeeId' } })
  async getAbsences(@Query() query: PeriodQuery, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = this.resolveEmployee(query.employeeId, user);
    const result = await this.schedule.getAbsences([employeeId], query.from, query.to);
    return {
      absences: result.absences.map((absence) => ({
        absenceId: absence.absence_id,
        employeeId: absence.employee_id,
        type: absence.type,
        from: absence.period.from,
        to: absence.period.to,
        requestId: absence.request_id || null,
      })),
    };
  }

  /**
   * Оформление отсутствия кадровиком — приказом, минуя согласование.
   *
   * Штатный путь для сотрудника другой: заявка в approval-service,
   * утверждение руководителем и автоматическое применение по событию
   * (§10.3). Здесь — ручное оформление, у которого нет requestId.
   */
  @Post('absences')
  @RequirePermission({ resource: 'absence', action: 'write', ownerFrom: { body: 'employeeId' } })
  async registerAbsence(@Body() dto: RegisterAbsenceDto) {
    const absence = await this.schedule.registerAbsence({
      employeeId: dto.employeeId,
      type: dto.type,
      from: dto.from,
      to: dto.to,
    });
    return {
      absenceId: absence.absence_id,
      employeeId: absence.employee_id,
      type: absence.type,
      from: absence.period.from,
      to: absence.period.to,
    };
  }

  // ── Производственный календарь ───────────────────────────────────────

  @Get('calendar')
  @RequirePermission({ resource: 'calendar', action: 'read' })
  async getCalendar(@Query() query: PeriodQuery) {
    const result = await this.schedule.getCalendar(query.from, query.to);
    return {
      days: result.days.map((day) => ({
        date: day.date,
        kind: day.kind,
        note: day.note || null,
      })),
    };
  }

  /** Перенос выходного, региональный праздник, ручная правка. */
  @Post('calendar')
  @RequirePermission({ resource: 'calendar', action: 'write' })
  async setCalendarDay(@Body() dto: CalendarDayDto) {
    const day = await this.schedule.setCalendarDay(dto.date, dto.kind, dto.note);
    return { date: day.date, kind: day.kind, note: day.note || null };
  }

  /**
   * Засев праздников на год.
   *
   * Заполняются только даты, закреплённые в ст. 112 ТК РФ. Переносы
   * выходных устанавливает постановление Правительства на каждый год —
   * их вносят вручную через POST /calendar.
   */
  @Post('calendar/seed')
  @RequirePermission({ resource: 'calendar', action: 'write' })
  async seedCalendar(@Body() dto: SeedYearDto) {
    const result = await this.schedule.seedCalendarYear(dto.year);
    return {
      year: dto.year,
      holidays: Number(result.value),
      note: 'переносы выходных задаются отдельно: их устанавливает постановление Правительства',
    };
  }

  /**
   * Чей график запрашивают.
   *
   * Без явного employeeId — свой. Пользователь без профиля сотрудника
   * получает понятную ошибку вместо пустого ответа: у него ещё нет
   * положения в оргструктуре, и график ему не назначен.
   */
  private resolveEmployee(requested: string | undefined, user: AuthenticatedUser): string {
    const employeeId = requested ?? user.employeeId;
    if (!employeeId) {
      throw new BadRequestException(
        'профиль сотрудника ещё не создан; укажите employeeId явно',
      );
    }
    return employeeId;
  }
}

function toPublicShift(shift: ShiftDto) {
  return {
    shiftId: shift.shift_id,
    employeeId: shift.employee_id,
    date: shift.date,
    startsAt: shift.starts_at,
    endsAt: shift.ends_at,
    breakMinutes: shift.break_minutes,
  };
}
