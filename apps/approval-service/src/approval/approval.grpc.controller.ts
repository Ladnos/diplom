import { Controller } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Prisma, RequestType } from '../../generated/prisma';
import { ApprovalService } from './approval.service';
import { REQUEST_RULES, availableTypes } from './request-types';

type RequestWithSteps = Prisma.RequestGetPayload<{ include: { steps: true } }>;

const MAX_PAGE_SIZE = 200;

function mapRequest(request: RequestWithSteps) {
  return {
    request_id: request.id,
    type: request.type,
    author_employee_id: request.authorEmployeeId,
    status: request.status,
    current_step: request.currentStep,
    steps: request.steps.map((step) => ({
      order: step.order,
      approver_employee_id: step.approverEmployeeId,
      delegated_to: step.decidedBy && step.decidedBy !== step.approverEmployeeId ? step.decidedBy : '',
      status: step.status,
      comment: step.comment ?? '',
      decided_at: step.decidedAt?.getTime() ?? 0,
    })),
    payload_json: JSON.stringify(request.payload ?? {}),
    sla_deadline: request.slaDeadline?.getTime() ?? 0,
    created_at: request.createdAt.getTime(),
    failure_reason: request.failureReason ?? '',
  };
}

/** proto3 отдаёт 0 для незаданного числа — трактуем как «по умолчанию». */
function page(limit?: number, offset?: number) {
  return {
    limit: Math.min(limit && limit > 0 ? limit : 50, MAX_PAGE_SIZE),
    offset: offset && offset > 0 ? offset : 0,
  };
}

/** gRPC-интерфейс approval-service (libs/contracts/proto/approval.proto). */
@Controller()
export class ApprovalGrpcController {
  constructor(private readonly approval: ApprovalService) {}

  @GrpcMethod('ApprovalService', 'CreateRequest')
  async createRequest(data: {
    type: RequestType;
    author_employee_id: string;
    payload_json: string;
  }) {
    let payload: Record<string, unknown>;
    try {
      payload = data.payload_json ? JSON.parse(data.payload_json) : {};
    } catch {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'payload_json не является корректным JSON',
      });
    }

    const request = await this.approval.createRequest({
      type: data.type,
      authorEmployeeId: data.author_employee_id,
      payload,
    });
    return mapRequest(request);
  }

  @GrpcMethod('ApprovalService', 'GetRequest')
  async getRequest(data: { request_id: string }) {
    return mapRequest(await this.approval.getRequest(data.request_id));
  }

  @GrpcMethod('ApprovalService', 'ListPendingForMe')
  async listPendingForMe(data: {
    approver_employee_id: string;
    page?: { limit?: number; cursor?: string };
  }) {
    const { limit, offset } = page(data.page?.limit, Number(data.page?.cursor ?? 0));
    const result = await this.approval.listPendingForApprover(
      data.approver_employee_id,
      limit,
      offset,
    );
    return {
      requests: result.requests.map(mapRequest),
      page: { next_cursor: String(offset + limit), has_more: offset + limit < result.total },
    };
  }

  @GrpcMethod('ApprovalService', 'ListMyRequests')
  async listMyRequests(data: {
    author_employee_id: string;
    page?: { limit?: number; cursor?: string };
  }) {
    const { limit, offset } = page(data.page?.limit, Number(data.page?.cursor ?? 0));
    const result = await this.approval.listByAuthor(data.author_employee_id, limit, offset);
    return {
      requests: result.requests.map(mapRequest),
      page: { next_cursor: String(offset + limit), has_more: offset + limit < result.total },
    };
  }

  @GrpcMethod('ApprovalService', 'GetPendingCount')
  async getPendingCount(data: { approver_employee_id: string }) {
    return { value: await this.approval.getPendingCount(data.approver_employee_id) };
  }

  @GrpcMethod('ApprovalService', 'Approve')
  async approve(data: {
    request_id: string;
    approver_employee_id: string;
    actor_user_id: string;
    comment?: string;
  }) {
    const request = await this.approval.approve({
      requestId: data.request_id,
      actorUserId: data.actor_user_id,
      actorEmployeeId: data.approver_employee_id,
      comment: data.comment || undefined,
    });
    return mapRequest(request);
  }

  @GrpcMethod('ApprovalService', 'Reject')
  async reject(data: {
    request_id: string;
    approver_employee_id: string;
    actor_user_id: string;
    comment?: string;
  }) {
    const request = await this.approval.reject({
      requestId: data.request_id,
      actorUserId: data.actor_user_id,
      actorEmployeeId: data.approver_employee_id,
      comment: data.comment || undefined,
    });
    return mapRequest(request);
  }

  @GrpcMethod('ApprovalService', 'Cancel')
  async cancel(data: { request_id: string; actor_employee_id: string }) {
    const request = await this.approval.cancel({
      requestId: data.request_id,
      actorEmployeeId: data.actor_employee_id,
    });
    return mapRequest(request);
  }

  @GrpcMethod('ApprovalService', 'SetDelegation')
  async setDelegation(data: {
    manager_employee_id: string;
    delegate_employee_id: string;
    period: { from: string; to: string };
  }) {
    await this.approval.setDelegation({
      managerEmployeeId: data.manager_employee_id,
      delegateEmployeeId: data.delegate_employee_id,
      from: data.period.from,
      to: data.period.to,
    });
    return {};
  }

  @GrpcMethod('ApprovalService', 'GetRoute')
  async getRoute(data: { request_id: string }) {
    const request = await this.approval.getRequest(data.request_id);
    return {
      request_id: request.id,
      steps: mapRequest(request).steps,
      current_step: request.currentStep,
    };
  }

  /**
   * Типы заявок, доступные сотруднику.
   *
   * Зависят от политики учёта времени (§3.3): у самозанятого в списке
   * не будет ни отпуска, ни переработки — интерфейс не должен их
   * показывать, а не отклонять после отправки формы.
   */
  @GrpcMethod('ApprovalService', 'GetAvailableTypes')
  async getAvailableTypes(data: { employee_id: string }) {
    const types = await this.approval.getAvailableTypes(data.employee_id);
    return {
      types,
      details: types.map((type) => ({
        type,
        title: REQUEST_RULES[type].title,
        manager_levels: REQUEST_RULES[type].managerLevels,
        requires_hr: REQUEST_RULES[type].requiresHr,
        sla_hours: REQUEST_RULES[type].slaHours,
      })),
    };
  }
}

export { availableTypes };
