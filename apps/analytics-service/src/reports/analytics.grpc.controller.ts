import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { AuditLog, ExportTicket } from '../../generated/prisma';
import { AuditService } from '../ingest/audit.service';
import { ExportService } from './export.service';
import { ReportsService, type Period } from './reports.service';

/**
 * gRPC-фасад analytics-service.
 *
 * Только чтение готовых витрин и заказ выгрузок. Данных сюда никто не
 * присылает: основной поток приходит событиями (§12), и метода «записать
 * факт» в контракте нет намеренно — он позволил бы наполнить отчётность
 * в обход шины, и цифры разошлись бы с тем, что происходило на самом
 * деле.
 */
@Controller()
export class AnalyticsGrpcController {
  constructor(
    private readonly reports: ReportsService,
    private readonly exports: ExportService,
    private readonly audit: AuditService,
  ) {}

  @GrpcMethod('AnalyticsService', 'GetTimeUtilization')
  async getTimeUtilization(data: {
    manager_employee_id?: string;
    department_id?: string;
    period?: { from?: string; to?: string };
  }) {
    const team = await this.reports.teamMembers({
      managerEmployeeId: data.manager_employee_id || undefined,
      departmentId: data.department_id || undefined,
    });
    const report = await this.reports.timeUtilization(team, toPeriod(data.period));

    return {
      rows: report.rows.map((row) => ({
        employee_id: row.employeeId,
        norm_minutes: row.normMinutes,
        absence_minutes: row.absenceMinutes,
        overtime_minutes: row.overtimeMinutes,
        total_minutes: row.totalMinutes,
      })),
      total_norm_minutes: report.totalNormMinutes,
      total_overtime_minutes: report.totalOvertimeMinutes,
    };
  }

  @GrpcMethod('AnalyticsService', 'GetTaskFlowMetrics')
  async getTaskFlowMetrics(data: {
    board_id: string;
    period?: { from?: string; to?: string };
  }) {
    const report = await this.reports.taskFlow(data.board_id, toPeriod(data.period));
    return {
      avg_lead_time_hours: report.avgLeadTimeHours,
      avg_cycle_time_hours: report.avgCycleTimeHours,
      created_count: report.createdCount,
      closed_count: report.closedCount,
      column_durations: report.columnDurations.map((item) => ({
        column_id: item.columnId,
        // Названия колонок живут в task-service; витрина хранит
        // идентификаторы, а подпись подмешивает вызывающий, если она ему
        // нужна. Держать здесь копию названий значило бы обновлять её при
        // каждом переименовании колонки.
        column_name: '',
        avg_hours: item.avgHours,
      })),
    };
  }

  @GrpcMethod('AnalyticsService', 'GetMeetingStats')
  async getMeetingStats(data: {
    manager_employee_id?: string;
    department_id?: string;
    period?: { from?: string; to?: string };
  }) {
    const team = await this.reports.teamMembers({
      managerEmployeeId: data.manager_employee_id || undefined,
      departmentId: data.department_id || undefined,
    });
    const report = await this.reports.meetingStats(team, toPeriod(data.period));
    return {
      call_count: report.callCount,
      total_duration_sec: report.totalDurationSec,
      avg_participants: report.avgParticipants,
    };
  }

  @GrpcMethod('AnalyticsService', 'GetApprovalStats')
  async getApprovalStats(data: {
    manager_employee_id?: string;
    department_id?: string;
    period?: { from?: string; to?: string };
  }) {
    const team = await this.reports.teamMembers({
      managerEmployeeId: data.manager_employee_id || undefined,
      departmentId: data.department_id || undefined,
    });
    const report = await this.reports.approvalStats(team, toPeriod(data.period));
    return {
      created: report.created,
      approved: report.approved,
      rejected: report.rejected,
      expired: report.expired,
      avg_decision_hours: report.avgDecisionHours,
    };
  }

  @GrpcMethod('AnalyticsService', 'RequestExport')
  async requestExport(data: {
    report_type: string;
    requested_by_employee_id: string;
    period?: { from?: string; to?: string };
    params_json?: string;
    format?: string;
  }) {
    const ticket = await this.exports.request({
      reportType: data.report_type,
      format: data.format || 'CSV',
      requestedByEmployeeId: data.requested_by_employee_id,
      from: data.period?.from ?? '',
      to: data.period?.to ?? '',
      paramsJson: data.params_json || undefined,
    });
    return mapTicket(ticket);
  }

  /**
   * Состояние билета и, если отчёт готов, его содержимое.
   *
   * Содержимое отдаётся здесь же, а не отдельным методом: клиент
   * опрашивает состояние до готовности, и заставлять его после
   * положительного ответа делать второй вызов — лишний круг ради
   * разделения, которое ничему не помогает.
   */
  @GrpcMethod('AnalyticsService', 'GetExportStatus')
  async getExportStatus(data: { ticket_id: string }) {
    const ticket = await this.exports.get(data.ticket_id);
    return {
      ...mapTicket(ticket),
      content: ticket.content ?? '',
      filename: ticket.filename ?? '',
    };
  }

  @GrpcMethod('AnalyticsService', 'GetAuditLog')
  async getAuditLog(data: {
    actor_employee_id?: string;
    event_type?: string;
    period?: { from?: string; to?: string };
    page?: { limit?: number; cursor?: string };
  }) {
    const result = await this.audit.page({
      actorEmployeeId: data.actor_employee_id || undefined,
      eventType: data.event_type || undefined,
      from: data.period?.from || undefined,
      to: data.period?.to || undefined,
      limit: data.page?.limit ?? 50,
      cursor: data.page?.cursor || undefined,
    });

    return {
      entries: result.entries.map(mapEntry),
      page: { next_cursor: result.nextCursor, has_more: result.hasMore },
    };
  }
}

function toPeriod(period?: { from?: string; to?: string }): Period {
  const from = new Date(`${(period?.from ?? '').slice(0, 10)}T00:00:00.000Z`);
  const to = new Date(`${(period?.to ?? '').slice(0, 10)}T23:59:59.999Z`);

  // Период по умолчанию — текущий месяц: отчёт без периода спрашивают
  // про «сейчас», а пустой ответ выглядел бы как отсутствие данных.
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    const now = new Date();
    return {
      from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      to: now,
    };
  }
  return { from, to };
}

function mapTicket(ticket: ExportTicket) {
  return {
    ticket_id: ticket.id,
    status: ticket.status,
    // file_id остаётся пустым: содержимое лежит в самом билете, см.
    // комментарий к модели ExportTicket.
    file_id: '',
    error: ticket.error ?? '',
  };
}

function mapEntry(entry: AuditLog) {
  return {
    event_id: entry.eventId,
    event_type: entry.eventType,
    producer: entry.producer,
    actor_user_id: entry.actorUserId ?? '',
    actor_employee_id: entry.actorEmployeeId ?? '',
    correlation_id: entry.correlationId,
    payload_json: JSON.stringify(entry.payload ?? {}),
    occurred_at: entry.occurredAt.getTime(),
  };
}
