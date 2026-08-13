import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AnalyticsClient } from '../clients/analytics.client';
import { HrClient } from '../clients/hr.client';
import type { AuthenticatedUser } from '../auth/auth.guard';
import { CurrentUser, RequirePermission } from '../auth/permission.guard';
import { AuditLogQuery, ReportPeriodQuery, RequestExportDto } from './dto';

/**
 * Отчёты и журнал аудита.
 *
 * Читаются готовые витрины analytics-service: тяжёлый агрегирующий запрос
 * не ходит в чужие базы и не зависит от их доступности (§12). Отсюда и
 * дедлайн REPORTING вместо обычного — считать по периоду заведомо
 * дольше, чем читать одну строку.
 */
@Controller('api/reports')
export class ReportsController {
  constructor(
    private readonly analytics: AnalyticsClient,
    private readonly hr: HrClient,
  ) {}

  /**
   * Использование рабочего времени по команде.
   *
   * Право `report/read` со scope SUBORDINATE у руководителя и GLOBAL у
   * администратора. Кого именно считать командой, решает не шлюз: он
   * передаёт себя как руководителя, и витрина отбирает прямых
   * подчинённых.
   */
  @Get('time')
  @RequirePermission({ resource: 'report', action: 'read' })
  async time(@Query() query: ReportPeriodQuery, @CurrentUser() user: AuthenticatedUser) {
    const scope = this.resolveScope(query, user);
    const report = await this.analytics.timeUtilization({ ...scope, period: toPeriod(query) });
    const names = await this.resolveNames(report.rows.map((row) => row.employee_id));

    return {
      period: toPeriod(query),
      rows: report.rows.map((row) => ({
        employeeId: row.employee_id,
        fullName: names.get(row.employee_id) ?? null,
        normMinutes: row.norm_minutes,
        absenceMinutes: row.absence_minutes,
        overtimeMinutes: row.overtime_minutes,
        totalMinutes: row.total_minutes,
      })),
      totalNormMinutes: report.total_norm_minutes,
      totalOvertimeMinutes: report.total_overtime_minutes,
    };
  }

  /** Поток задач по доске: где карточки стоят и сколько живут. */
  @Get('task-flow')
  @RequirePermission({ resource: 'report', action: 'read' })
  async taskFlow(@Query() query: ReportPeriodQuery) {
    if (!query.boardId) throw new BadRequestException('нужен boardId');

    const report = await this.analytics.taskFlow(query.boardId, toPeriod(query));
    return {
      period: toPeriod(query),
      avgLeadTimeHours: report.avg_lead_time_hours,
      avgCycleTimeHours: report.avg_cycle_time_hours,
      createdCount: report.created_count,
      closedCount: report.closed_count,
      columnDurations: report.column_durations.map((item) => ({
        columnId: item.column_id,
        avgHours: item.avg_hours,
      })),
    };
  }

  @Get('approvals')
  @RequirePermission({ resource: 'report', action: 'read' })
  async approvals(@Query() query: ReportPeriodQuery, @CurrentUser() user: AuthenticatedUser) {
    const scope = this.resolveScope(query, user);
    const report = await this.analytics.approvalStats({ ...scope, period: toPeriod(query) });
    return {
      period: toPeriod(query),
      created: report.created,
      approved: report.approved,
      rejected: report.rejected,
      expired: report.expired,
      avgDecisionHours: report.avg_decision_hours,
    };
  }

  /** Статистика встреч — агрегированная, без разбивки по людям (ADR-2). */
  @Get('meetings')
  @RequirePermission({ resource: 'report', action: 'read' })
  async meetings(@Query() query: ReportPeriodQuery, @CurrentUser() user: AuthenticatedUser) {
    const scope = this.resolveScope(query, user);
    const report = await this.analytics.meetingStats({ ...scope, period: toPeriod(query) });
    return {
      period: toPeriod(query),
      callCount: report.call_count,
      totalDurationMinutes: Math.round(report.total_duration_sec / 60),
      avgParticipants: report.avg_participants,
    };
  }

  /**
   * Заказ выгрузки.
   *
   * Возвращает билет, а не файл: отчёт за год по отделу считается
   * секундами, а HTTP-запрос столько держать незачем. Готовность
   * узнаётся опросом билета либо событием analytics.report.ready.
   */
  @Post('export')
  @HttpCode(202)
  @RequirePermission({ resource: 'report', action: 'read' })
  async requestExport(
    @Query() query: ReportPeriodQuery,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RequestExportDto,
  ) {
    const employeeId = requireEmployee(user);
    const scope = this.resolveScope(query, user);

    const ticket = await this.analytics.requestExport({
      reportType: dto.reportType,
      requestedByEmployeeId: employeeId,
      period: toPeriod(query),
      paramsJson: JSON.stringify({
        managerEmployeeId: scope.managerEmployeeId,
        departmentId: scope.departmentId,
        boardId: query.boardId,
      }),
      format: dto.format,
    });

    return { ticketId: ticket.ticket_id, status: ticket.status };
  }

  @Get('export/:id')
  @RequirePermission({ resource: 'report', action: 'read' })
  async exportStatus(@Param('id', ParseUUIDPipe) id: string) {
    const ticket = await this.analytics.exportStatus(id);
    return {
      ticketId: ticket.ticket_id,
      status: ticket.status,
      error: ticket.error || null,
      ready: ticket.status === 'READY',
    };
  }

  /**
   * Скачивание готовой выгрузки.
   *
   * Содержимое приходит из витрины и отдаётся как файл. Через
   * file-service оно не проходит: выгрузку формирует сервис по команде из
   * очереди, и предъявить хранилищу токен пользователя ему нечем.
   */
  @Get('export/:id/download')
  @Header('Cache-Control', 'private, no-store')
  async download(@Param('id', ParseUUIDPipe) id: string, @Res() response: Response) {
    const ticket = await this.analytics.exportStatus(id);
    if (ticket.status !== 'READY' || !ticket.content) {
      throw new NotFoundException(
        ticket.status === 'FAILED' ? `выгрузка не собралась: ${ticket.error}` : 'выгрузка ещё не готова',
      );
    }

    const filename = ticket.filename || 'report.csv';
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    response.send(ticket.content);
  }

  /**
   * Журнал аудита.
   *
   * Право `audit/read` не выдано ни одной роли, кроме администратора с
   * его `*:*`. Это осознанно: журнал показывает, кто что делал во всей
   * системе, и руководителю отдела он не нужен — ему нужны отчёты по
   * своей команде, которые лежат рядом.
   */
  @Get('audit')
  @RequirePermission({ resource: 'audit', action: 'read' })
  async audit(@Query() query: AuditLogQuery) {
    const result = await this.analytics.auditLog({
      actorEmployeeId: query.actorEmployeeId,
      eventType: query.eventType,
      period: query.from && query.to ? { from: query.from, to: query.to } : undefined,
      limit: query.limit,
      cursor: query.cursor,
    });

    return {
      entries: result.entries.map((entry) => ({
        eventId: entry.event_id,
        eventType: entry.event_type,
        producer: entry.producer,
        actor: entry.actor_employee_id
          ? { employeeId: entry.actor_employee_id, userId: entry.actor_user_id || null }
          : null,
        correlationId: entry.correlation_id,
        payload: safeParse(entry.payload_json),
        occurredAt: new Date(Number(entry.occurred_at)).toISOString(),
      })),
      nextCursor: result.page.next_cursor || null,
      hasMore: result.page.has_more,
    };
  }

  /**
   * Чья команда попадёт в отчёт.
   *
   * По умолчанию — своя: руководитель открывает отчёт про своих людей.
   * Явно указанный отдел разрешит auth-service, если у роли хватает
   * области действия; шлюз тут ничего не решает сам.
   */
  private resolveScope(
    query: ReportPeriodQuery,
    user: AuthenticatedUser,
  ): { managerEmployeeId?: string; departmentId?: string } {
    if (query.departmentId) return { departmentId: query.departmentId };
    return { managerEmployeeId: requireEmployee(user) };
  }

  private async resolveNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();

    return this.hr
      .getEmployeesBatch(unique)
      .then((result) => new Map(result.employees.map((e) => [e.employee_id, e.full_name])))
      .catch(() => new Map<string, string>());
  }
}

function toPeriod(query: ReportPeriodQuery): { from: string; to: string } {
  // Период по умолчанию — текущий месяц: отчёт без явных дат спрашивают
  // про «сейчас».
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    from: query.from ?? first.toISOString().slice(0, 10),
    to: query.to ?? now.toISOString().slice(0, 10),
  };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function requireEmployee(user: AuthenticatedUser): string {
  if (!user.employeeId) {
    throw new BadRequestException('у учётной записи нет карточки сотрудника');
  }
  return user.employeeId;
}
