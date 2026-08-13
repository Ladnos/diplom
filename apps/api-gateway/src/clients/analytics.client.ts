import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { SERVICES } from '@crm/contracts';
import { DEADLINES_MS, grpcClientToken } from '@crm/grpc-clients';

export interface TimeUtilizationDto {
  rows: {
    employee_id: string;
    norm_minutes: number;
    absence_minutes: number;
    overtime_minutes: number;
    total_minutes: number;
  }[];
  total_norm_minutes: number;
  total_overtime_minutes: number;
}

export interface TaskFlowDto {
  avg_lead_time_hours: number;
  avg_cycle_time_hours: number;
  created_count: number;
  closed_count: number;
  column_durations: { column_id: string; column_name: string; avg_hours: number }[];
}

export interface MeetingStatsDto {
  call_count: number;
  total_duration_sec: number;
  avg_participants: number;
}

export interface ApprovalStatsDto {
  created: number;
  approved: number;
  rejected: number;
  expired: number;
  avg_decision_hours: number;
}

export interface ExportTicketDto {
  ticket_id: string;
  status: string;
  file_id: string;
  error: string;
  /** Заполняются только при status = READY. */
  content: string;
  filename: string;
}

export interface AuditEntryDto {
  event_id: string;
  event_type: string;
  producer: string;
  actor_user_id: string;
  actor_employee_id: string;
  correlation_id: string;
  payload_json: string;
  occurred_at: number;
}

interface Period {
  from: string;
  to: string;
}

interface AnalyticsGrpc {
  GetTimeUtilization(data: Record<string, unknown>): Observable<TimeUtilizationDto>;
  GetTaskFlowMetrics(data: { board_id: string; period: Period }): Observable<TaskFlowDto>;
  GetMeetingStats(data: Record<string, unknown>): Observable<MeetingStatsDto>;
  GetApprovalStats(data: Record<string, unknown>): Observable<ApprovalStatsDto>;
  RequestExport(data: Record<string, unknown>): Observable<ExportTicketDto>;
  GetExportStatus(data: { ticket_id: string }): Observable<ExportTicketDto>;
  GetAuditLog(data: Record<string, unknown>): Observable<{
    entries: AuditEntryDto[];
    page: { next_cursor: string; has_more: boolean };
  }>;
}

/**
 * Клиент к analytics-service.
 *
 * Дедлайн REPORTING, а не обычный: агрегирующие запросы по периоду
 * заведомо медленнее точечных, и мерить их той же меркой значило бы
 * обрывать отчёт, который просто честно считается.
 */
@Injectable()
export class AnalyticsClient implements OnModuleInit {
  private service!: AnalyticsGrpc;

  constructor(@Inject(grpcClientToken(SERVICES.ANALYTICS)) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.service = this.client.getService<AnalyticsGrpc>('AnalyticsService');
  }

  private call<T>(source: Observable<T>): Promise<T> {
    return firstValueFrom(source.pipe(timeout(DEADLINES_MS.REPORTING)));
  }

  timeUtilization(input: { managerEmployeeId?: string; departmentId?: string; period: Period }) {
    return this.call(
      this.service.GetTimeUtilization({
        manager_employee_id: input.managerEmployeeId ?? '',
        department_id: input.departmentId ?? '',
        period: input.period,
      }),
    );
  }

  taskFlow(boardId: string, period: Period) {
    return this.call(this.service.GetTaskFlowMetrics({ board_id: boardId, period }));
  }

  meetingStats(input: { managerEmployeeId?: string; departmentId?: string; period: Period }) {
    return this.call(
      this.service.GetMeetingStats({
        manager_employee_id: input.managerEmployeeId ?? '',
        department_id: input.departmentId ?? '',
        period: input.period,
      }),
    );
  }

  approvalStats(input: { managerEmployeeId?: string; departmentId?: string; period: Period }) {
    return this.call(
      this.service.GetApprovalStats({
        manager_employee_id: input.managerEmployeeId ?? '',
        department_id: input.departmentId ?? '',
        period: input.period,
      }),
    );
  }

  requestExport(input: {
    reportType: string;
    requestedByEmployeeId: string;
    period: Period;
    paramsJson?: string;
    format?: string;
  }) {
    return this.call(
      this.service.RequestExport({
        report_type: input.reportType,
        requested_by_employee_id: input.requestedByEmployeeId,
        period: input.period,
        params_json: input.paramsJson ?? '',
        format: input.format ?? 'CSV',
      }),
    );
  }

  exportStatus(ticketId: string) {
    return this.call(this.service.GetExportStatus({ ticket_id: ticketId }));
  }

  auditLog(input: {
    actorEmployeeId?: string;
    eventType?: string;
    period?: Period;
    limit?: number;
    cursor?: string;
  }) {
    return this.call(
      this.service.GetAuditLog({
        actor_employee_id: input.actorEmployeeId ?? '',
        event_type: input.eventType ?? '',
        period: input.period ?? { from: '', to: '' },
        page: { limit: input.limit ?? 50, cursor: input.cursor ?? '' },
      }),
    );
  }
}
