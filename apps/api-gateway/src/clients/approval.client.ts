import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { SERVICES } from '@crm/contracts';
import { DEADLINES_MS, grpcClientToken } from '@crm/grpc-clients';

export interface ApprovalStepDto {
  order: number;
  approver_employee_id: string;
  delegated_to: string;
  status: string;
  comment: string;
  decided_at: number;
}

export interface RequestDto {
  request_id: string;
  type: string;
  author_employee_id: string;
  status: string;
  current_step: number;
  steps: ApprovalStepDto[];
  payload_json: string;
  sla_deadline: number;
  created_at: number;
  failure_reason: string;
}

export interface RequestTypeInfoDto {
  type: string;
  title: string;
  manager_levels: number;
  requires_hr: boolean;
  sla_hours: number;
}

interface ApprovalGrpc {
  CreateRequest(data: {
    type: string;
    author_employee_id: string;
    payload_json: string;
  }): Observable<RequestDto>;
  GetRequest(data: { request_id: string }): Observable<RequestDto>;
  ListPendingForMe(data: {
    approver_employee_id: string;
    page?: { limit?: number; cursor?: string };
  }): Observable<{ requests: RequestDto[]; page: { next_cursor: string; has_more: boolean } }>;
  ListMyRequests(data: {
    author_employee_id: string;
    page?: { limit?: number; cursor?: string };
  }): Observable<{ requests: RequestDto[]; page: { next_cursor: string; has_more: boolean } }>;
  GetPendingCount(data: { approver_employee_id: string }): Observable<{ value: number }>;
  Approve(data: {
    request_id: string;
    approver_employee_id: string;
    actor_user_id: string;
    comment?: string;
  }): Observable<RequestDto>;
  Reject(data: {
    request_id: string;
    approver_employee_id: string;
    actor_user_id: string;
    comment?: string;
  }): Observable<RequestDto>;
  Cancel(data: { request_id: string; actor_employee_id: string }): Observable<RequestDto>;
  SetDelegation(data: {
    manager_employee_id: string;
    delegate_employee_id: string;
    period: { from: string; to: string };
  }): Observable<object>;
  GetAvailableTypes(data: { employee_id: string }): Observable<{
    types: string[];
    details: RequestTypeInfoDto[];
  }>;
}

@Injectable()
export class ApprovalClient implements OnModuleInit {
  private service!: ApprovalGrpc;

  constructor(@Inject(grpcClientToken(SERVICES.APPROVAL)) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.service = this.client.getService<ApprovalGrpc>('ApprovalService');
  }

  createRequest(type: string, authorEmployeeId: string, payload: Record<string, unknown>) {
    return firstValueFrom(
      this.service
        .CreateRequest({
          type,
          author_employee_id: authorEmployeeId,
          payload_json: JSON.stringify(payload),
        })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  getRequest(requestId: string) {
    return firstValueFrom(
      this.service.GetRequest({ request_id: requestId }).pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  listPendingForMe(approverEmployeeId: string, limit: number, offset: number) {
    return firstValueFrom(
      this.service
        .ListPendingForMe({
          approver_employee_id: approverEmployeeId,
          page: { limit, cursor: String(offset) },
        })
        .pipe(timeout(DEADLINES_MS.REPORTING)),
    );
  }

  listMyRequests(authorEmployeeId: string, limit: number, offset: number) {
    return firstValueFrom(
      this.service
        .ListMyRequests({
          author_employee_id: authorEmployeeId,
          page: { limit, cursor: String(offset) },
        })
        .pipe(timeout(DEADLINES_MS.REPORTING)),
    );
  }

  getPendingCount(approverEmployeeId: string) {
    return firstValueFrom(
      this.service
        .GetPendingCount({ approver_employee_id: approverEmployeeId })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  approve(requestId: string, approverEmployeeId: string, actorUserId: string, comment?: string) {
    return firstValueFrom(
      this.service
        .Approve({
          request_id: requestId,
          approver_employee_id: approverEmployeeId,
          actor_user_id: actorUserId,
          comment,
        })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  reject(requestId: string, approverEmployeeId: string, actorUserId: string, comment?: string) {
    return firstValueFrom(
      this.service
        .Reject({
          request_id: requestId,
          approver_employee_id: approverEmployeeId,
          actor_user_id: actorUserId,
          comment,
        })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  cancel(requestId: string, actorEmployeeId: string) {
    return firstValueFrom(
      this.service
        .Cancel({ request_id: requestId, actor_employee_id: actorEmployeeId })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  setDelegation(managerEmployeeId: string, delegateEmployeeId: string, from: string, to: string) {
    return firstValueFrom(
      this.service
        .SetDelegation({
          manager_employee_id: managerEmployeeId,
          delegate_employee_id: delegateEmployeeId,
          period: { from, to },
        })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  getAvailableTypes(employeeId: string) {
    return firstValueFrom(
      this.service
        .GetAvailableTypes({ employee_id: employeeId })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }
}
