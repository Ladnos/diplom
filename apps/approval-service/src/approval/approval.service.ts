import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import {
  ApprovalEvents,
  type DelegationSet,
  type RequestApproved,
  type RequestCreated,
  type RequestRejected,
  type RequestStepPassed,
  type RequestContext,
} from '@crm/contracts';
import { getRequestContext, optionalEnv } from '@crm/common';
import { EventPublisher } from '@crm/messaging';
import type { Prisma, Request, RequestStatus, RequestType } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { outboxRow } from '../prisma/outbox.store';
import { HrClient } from '../clients/hr.client';
import { AuthClient } from '../clients/auth.client';
import { REQUEST_RULES, isApplicable, availableTypes, validatePayload } from './request-types';

type RequestWithSteps = Prisma.RequestGetPayload<{ include: { steps: true } }>;

@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);

  /**
   * Сотрудник кадровой службы, участвующий в маршрутах с requiresHr.
   *
   * Пока настройкой окружения: полноценный справочник согласующих по
   * типам заявок — отдельная задача, а без этого поля шаг кадровой
   * службы просто пропускается, и заявка не зависает.
   */
  private readonly hrApproverId = optionalEnv('APPROVAL_HR_EMPLOYEE_ID', '');

  constructor(
    private readonly prisma: PrismaService,
    private readonly hr: HrClient,
    private readonly auth: AuthClient,
    private readonly publisher: EventPublisher,
  ) {}

  // ── Создание ─────────────────────────────────────────────────────────

  async createRequest(
    input: { type: RequestType; authorEmployeeId: string; payload: Record<string, unknown> },
    context: RequestContext = getRequestContext(),
  ): Promise<RequestWithSteps> {
    const rule = REQUEST_RULES[input.type];
    if (!rule) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: `неизвестный тип заявки: ${input.type}`,
      });
    }

    const payloadError = validatePayload(input.type, input.payload);
    if (payloadError) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: payloadError });
    }

    // Применимость типа заявки к политике учёта проверяется ДО вовлечения
    // руководителя: заявка на отпуск от самозанятого не должна попадать
    // к нему в очередь, чтобы он её отклонял вручную (§3.3, §10.3).
    const employment = await this.hr.getEmploymentInfo(input.authorEmployeeId).catch(() => null);
    if (!employment) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'у сотрудника нет действующего договора, заявку подать нельзя',
      });
    }
    if (!isApplicable(input.type, employment.policy)) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message:
          `заявка «${rule.title}» не применима при типе учёта ${employment.policy}. ` +
          `Доступные типы: ${availableTypes(employment.policy).join(', ') || 'нет'}`,
      });
    }

    await this.assertNoConflict(input.type, input.authorEmployeeId, input.payload);

    const route = await this.buildRoute(input.type, input.authorEmployeeId);
    const slaDeadline = new Date(Date.now() + rule.slaHours * 60 * 60 * 1000);

    // Маршрут пуст: у автора нет руководителя (вершина оргструктуры).
    // Заявка утверждается сразу — иначе она зависла бы навсегда.
    const autoApproved = route.length === 0;

    const created = await this.prisma.$transaction(async (tx) => {
      const request = await tx.request.create({
        data: {
          type: input.type,
          authorEmployeeId: input.authorEmployeeId,
          status: autoApproved ? 'APPROVED' : 'PENDING',
          currentStep: 1,
          payload: input.payload as Prisma.InputJsonValue,
          slaDeadline: autoApproved ? null : slaDeadline,
          approvedAt: autoApproved ? new Date() : null,
          steps: {
            create: route.map((approverId, index) => ({
              order: index + 1,
              approverEmployeeId: approverId,
            })),
          },
        },
        include: { steps: { orderBy: { order: 'asc' } } },
      });

      const createdEvent = this.publisher.wrap<RequestCreated>(
        ApprovalEvents.REQUEST_CREATED,
        {
          requestId: request.id,
          type: input.type,
          authorEmployeeId: input.authorEmployeeId,
          approverEmployeeIds: route,
          slaDeadline: slaDeadline.getTime(),
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(createdEvent) });

      if (autoApproved) {
        await tx.outbox.create({
          data: outboxRow(this.approvedEvent(request, context)),
        });
      }

      return request;
    });

    this.logger.log({
      message: autoApproved ? 'заявка создана и утверждена автоматически' : 'заявка создана',
      requestId: created.id,
      type: input.type,
      steps: route.length,
    });
    return created;
  }

  // ── Решения ──────────────────────────────────────────────────────────

  async approve(
    input: { requestId: string; actorUserId: string; actorEmployeeId: string; comment?: string },
    context: RequestContext = getRequestContext(),
  ): Promise<RequestWithSteps> {
    const request = await this.loadPending(input.requestId);
    const step = this.currentStep(request);

    await this.assertCanDecide(request, step.approverEmployeeId, input);

    const isLastStep = step.order >= request.steps.length;

    return this.prisma.$transaction(async (tx) => {
      await tx.approvalStep.update({
        where: { id: step.id },
        data: {
          status: 'APPROVED',
          decidedBy: input.actorEmployeeId,
          decidedAt: new Date(),
          comment: input.comment ?? null,
        },
      });

      const updated = await tx.request.update({
        where: { id: request.id },
        data: isLastStep
          ? { status: 'APPROVED', approvedAt: new Date(), slaDeadline: null }
          : { currentStep: step.order + 1 },
        include: { steps: { orderBy: { order: 'asc' } } },
      });

      if (isLastStep) {
        // Решение принято. Применяет его ВЛАДЕЛЕЦ ДАННЫХ по событию,
        // а заявка ждёт подтверждения в APPROVED (ADR-3, §10.3).
        await tx.outbox.create({ data: outboxRow(this.approvedEvent(updated, context)) });
      } else {
        const next = updated.steps.find((item) => item.order === step.order + 1);
        const passed = this.publisher.wrap<RequestStepPassed>(
          ApprovalEvents.REQUEST_STEP_PASSED,
          {
            requestId: request.id,
            step: step.order,
            approverEmployeeId: input.actorEmployeeId,
            nextApproverEmployeeId: next?.approverEmployeeId,
          },
          context,
        );
        await tx.outbox.create({ data: outboxRow(passed) });
      }

      this.logger.log({
        message: isLastStep ? 'заявка утверждена' : 'шаг согласования пройден',
        requestId: request.id,
        step: step.order,
        by: input.actorEmployeeId,
      });
      return updated;
    });
  }

  async reject(
    input: { requestId: string; actorUserId: string; actorEmployeeId: string; comment?: string },
    context: RequestContext = getRequestContext(),
  ): Promise<RequestWithSteps> {
    const request = await this.loadPending(input.requestId);
    const step = this.currentStep(request);

    await this.assertCanDecide(request, step.approverEmployeeId, input);

    return this.prisma.$transaction(async (tx) => {
      await tx.approvalStep.update({
        where: { id: step.id },
        data: {
          status: 'REJECTED',
          decidedBy: input.actorEmployeeId,
          decidedAt: new Date(),
          comment: input.comment ?? null,
        },
      });

      const updated = await tx.request.update({
        where: { id: request.id },
        data: {
          status: 'REJECTED',
          slaDeadline: null,
          failureReason: input.comment ?? 'отклонено без комментария',
        },
        include: { steps: { orderBy: { order: 'asc' } } },
      });

      const rejected = this.publisher.wrap<RequestRejected>(
        ApprovalEvents.REQUEST_REJECTED,
        {
          requestId: request.id,
          type: request.type,
          authorEmployeeId: request.authorEmployeeId,
          approverEmployeeId: input.actorEmployeeId,
          reason: input.comment ?? '',
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(rejected) });

      return updated;
    });
  }

  /** Отзыв заявки автором. Возможен, пока решение не принято. */
  async cancel(input: { requestId: string; actorEmployeeId: string }): Promise<RequestWithSteps> {
    const request = await this.loadRequest(input.requestId);

    if (request.authorEmployeeId !== input.actorEmployeeId) {
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: 'отозвать заявку может только её автор',
      });
    }
    if (request.status !== 'PENDING' && request.status !== 'DRAFT') {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: `заявку в статусе ${request.status} отозвать нельзя`,
      });
    }

    return this.prisma.request.update({
      where: { id: request.id },
      data: { status: 'CANCELLED', slaDeadline: null },
      include: { steps: { orderBy: { order: 'asc' } } },
    });
  }

  // ── Замыкание саги ───────────────────────────────────────────────────

  /**
   * Подтверждение применения от владельца данных.
   *
   * Вызывается потребителем событий hr.absence.registered и
   * hr.timesheet.* — именно оно закрывает сагу (§10.3).
   */
  async markApplied(requestId: string): Promise<void> {
    const result = await this.prisma.request.updateMany({
      where: { id: requestId, status: 'APPROVED' },
      data: { status: 'APPLIED', appliedAt: new Date() },
    });
    if (result.count > 0) {
      this.logger.log({ message: 'заявка применена', requestId });
    }
  }

  async markApplyFailed(requestId: string, reason: string): Promise<void> {
    const result = await this.prisma.request.updateMany({
      where: { id: requestId, status: 'APPROVED' },
      data: { status: 'APPLY_FAILED', failureReason: reason },
    });
    if (result.count > 0) {
      this.logger.warn({ message: 'применение заявки провалилось', requestId, reason });
    }
  }

  // ── Чтение ───────────────────────────────────────────────────────────

  async getRequest(requestId: string): Promise<RequestWithSteps> {
    return this.loadRequest(requestId);
  }

  /** Очередь согласующего: заявки, ждущие именно его решения. */
  async listPendingForApprover(approverEmployeeId: string, limit: number, offset: number) {
    const delegatedFrom = await this.activeDelegatorsFor(approverEmployeeId);
    const approvers = [approverEmployeeId, ...delegatedFrom];

    const where: Prisma.RequestWhereInput = {
      status: 'PENDING',
      steps: {
        some: { approverEmployeeId: { in: approvers }, status: 'WAITING' },
      },
    };

    const [requests, total] = await this.prisma.$transaction([
      this.prisma.request.findMany({
        where,
        include: { steps: { orderBy: { order: 'asc' } } },
        orderBy: { createdAt: 'asc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.request.count({ where }),
    ]);

    // Заявка попадает в очередь, только если ждёт ТЕКУЩЕГО шага:
    // фильтр по шагам выше вернул бы и те, где согласующий стоит дальше.
    const actionable = requests.filter((request) => {
      const step = request.steps.find((item) => item.order === request.currentStep);
      return step ? approvers.includes(step.approverEmployeeId) : false;
    });

    return { requests: actionable, total };
  }

  async listByAuthor(authorEmployeeId: string, limit: number, offset: number) {
    const where: Prisma.RequestWhereInput = { authorEmployeeId };
    const [requests, total] = await this.prisma.$transaction([
      this.prisma.request.findMany({
        where,
        include: { steps: { orderBy: { order: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.request.count({ where }),
    ]);
    return { requests, total };
  }

  async getPendingCount(approverEmployeeId: string): Promise<number> {
    const result = await this.listPendingForApprover(approverEmployeeId, 500, 0);
    return result.requests.length;
  }

  async getAvailableTypes(employeeId: string): Promise<RequestType[]> {
    const employment = await this.hr.getEmploymentInfo(employeeId).catch(() => null);
    if (!employment) return [];
    return availableTypes(employment.policy);
  }

  // ── Делегирование ────────────────────────────────────────────────────

  async setDelegation(
    input: {
      managerEmployeeId: string;
      delegateEmployeeId: string;
      from: string;
      to: string;
    },
    context: RequestContext = getRequestContext(),
  ) {
    if (input.managerEmployeeId === input.delegateEmployeeId) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'нельзя делегировать согласование самому себе',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const delegation = await tx.delegation.create({
        data: {
          managerEmployeeId: input.managerEmployeeId,
          delegateEmployeeId: input.delegateEmployeeId,
          validFrom: new Date(input.from),
          validTo: new Date(input.to),
        },
      });

      // auth-service слушает это событие и временно расширяет scope
      // заместителя — иначе он видел бы заявки, но не мог их утвердить.
      const envelope = this.publisher.wrap<DelegationSet>(
        ApprovalEvents.DELEGATION_SET,
        {
          managerEmployeeId: input.managerEmployeeId,
          delegateEmployeeId: input.delegateEmployeeId,
          period: { from: input.from, to: input.to },
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      return delegation;
    });
  }

  // ── Реакции на изменения оргструктуры ────────────────────────────────

  /**
   * Пересчёт маршрутов открытых заявок после смены руководителя.
   *
   * Без этого заявка ушедшего руководителя зависла бы: согласующий,
   * указанный в шаге, больше не имеет прав на автора.
   */
  async rebuildRoutesFor(employeeId: string): Promise<number> {
    const open = await this.prisma.request.findMany({
      where: { authorEmployeeId: employeeId, status: 'PENDING' },
      include: { steps: { orderBy: { order: 'asc' } } },
    });
    let rebuilt = 0;

    for (const request of open) {
      const route = await this.buildRoute(request.type, employeeId);
      if (route.length === 0) continue;

      const decided = request.steps.filter((step) => step.status !== 'WAITING');
      // Пройденные шаги не трогаем: решения уже приняты и переигрывать
      // их нельзя. Перестраивается только оставшийся хвост маршрута.
      const tail = route.slice(decided.length);
      if (tail.length === 0) continue;

      await this.prisma.$transaction(async (tx) => {
        await tx.approvalStep.deleteMany({
          where: { requestId: request.id, status: 'WAITING' },
        });
        await tx.approvalStep.createMany({
          data: tail.map((approverId, index) => ({
            requestId: request.id,
            order: decided.length + index + 1,
            approverEmployeeId: approverId,
          })),
        });
        await tx.request.update({
          where: { id: request.id },
          data: { currentStep: decided.length + 1 },
        });
      });
      rebuilt += 1;
    }

    if (rebuilt > 0) {
      this.logger.log({ message: 'маршруты согласования пересчитаны', employeeId, rebuilt });
    }
    return rebuilt;
  }

  /** Отмена открытых заявок: увольнение или смена типа найма. */
  async cancelOpenRequests(employeeId: string, reason: string, types?: RequestType[]): Promise<number> {
    const result = await this.prisma.request.updateMany({
      where: {
        authorEmployeeId: employeeId,
        status: { in: ['PENDING', 'DRAFT'] },
        ...(types ? { type: { in: types } } : {}),
      },
      data: { status: 'CANCELLED', failureReason: reason, slaDeadline: null },
    });
    if (result.count > 0) {
      this.logger.log({ message: 'открытые заявки отменены', employeeId, reason, count: result.count });
    }
    return result.count;
  }

  // ── Внутреннее ───────────────────────────────────────────────────────

  /**
   * Маршрут согласования из оргструктуры.
   *
   * Шаги, где согласующий совпадает с автором, ПРОПУСКАЮТСЯ и маршрут
   * поднимается выше: руководитель не утверждает собственный отпуск сам,
   * это то же правило, что и область SUBORDINATE в правах (ADR-3).
   */
  private async buildRoute(type: RequestType, authorEmployeeId: string): Promise<string[]> {
    const rule = REQUEST_RULES[type];
    const chain = await this.hr.getManagerChain(authorEmployeeId).catch(() => ({ employees: [] }));

    const managers = chain.employees
      .map((employee) => employee.employee_id)
      .filter((id) => id && id !== authorEmployeeId)
      .slice(0, rule.managerLevels);

    const route = [...managers];

    if (rule.requiresHr && this.hrApproverId && this.hrApproverId !== authorEmployeeId) {
      if (!route.includes(this.hrApproverId)) route.push(this.hrApproverId);
    } else if (rule.requiresHr && !this.hrApproverId) {
      this.logger.warn({
        message:
          'шаг кадровой службы пропущен: не задан APPROVAL_HR_EMPLOYEE_ID. ' +
          'Заявка будет утверждена только руководителем',
        type,
      });
    }

    return route;
  }

  /** Проверка пересечений и осмысленности заявки до вовлечения людей. */
  private async assertNoConflict(
    type: RequestType,
    employeeId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (type !== 'VACATION' && type !== 'TIME_OFF' && type !== 'TRIP') return;

    const duplicate = await this.prisma.request.findFirst({
      where: {
        authorEmployeeId: employeeId,
        type,
        status: { in: ['PENDING', 'APPROVED'] },
      },
    });
    if (duplicate) {
      throw new RpcException({
        code: GrpcStatus.ALREADY_EXISTS,
        message:
          `у вас уже есть заявка «${REQUEST_RULES[type].title}» на рассмотрении ` +
          '— дождитесь решения или отзовите её',
      });
    }

    const from = String(payload.from ?? '');
    if (from && from < new Date().toISOString().slice(0, 10) && type === 'VACATION') {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'отпуск задним числом оформляется приказом кадровой службы, а не заявкой',
      });
    }
  }

  private async loadRequest(requestId: string): Promise<RequestWithSteps> {
    const request = await this.prisma.request.findUnique({
      where: { id: requestId },
      include: { steps: { orderBy: { order: 'asc' } } },
    });
    if (!request) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'заявка не найдена' });
    }
    return request;
  }

  private async loadPending(requestId: string): Promise<RequestWithSteps> {
    const request = await this.loadRequest(requestId);
    if (request.status !== 'PENDING') {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: `заявка в статусе ${request.status}, решение принять нельзя`,
      });
    }
    return request;
  }

  private currentStep(request: RequestWithSteps) {
    const step = request.steps.find((item) => item.order === request.currentStep);
    if (!step) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'маршрут согласования повреждён: текущий шаг не найден',
      });
    }
    return step;
  }

  /**
   * Право принять решение по шагу.
   *
   * Две независимые проверки: назначен ли актор на этот шаг (или является
   * действующим заместителем) и есть ли у него право approve на автора.
   * Первая — про маршрут, вторая — про полномочия; ни одна не заменяет
   * другую, потому что руководитель может быть в маршруте, но уже
   * потерять подчинённого.
   */
  private async assertCanDecide(
    request: RequestWithSteps,
    stepApproverId: string,
    actor: { actorUserId: string; actorEmployeeId: string },
  ): Promise<void> {
    if (request.authorEmployeeId === actor.actorEmployeeId) {
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: 'нельзя принимать решение по собственной заявке',
      });
    }

    const isAssigned = stepApproverId === actor.actorEmployeeId;
    const isDelegate = isAssigned
      ? false
      : (await this.activeDelegatorsFor(actor.actorEmployeeId)).includes(stepApproverId);

    if (!isAssigned && !isDelegate) {
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: 'заявка ожидает решения другого согласующего',
      });
    }

    const decision = await this.auth.checkPermission({
      userId: actor.actorUserId,
      resource: 'request',
      action: 'approve',
      resourceId: request.id,
      ownerId: request.authorEmployeeId,
    });
    if (!decision.allowed) {
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: decision.reason || 'недостаточно прав для утверждения',
      });
    }
  }

  /** Руководители, чьи полномочия сейчас делегированы этому сотруднику. */
  private async activeDelegatorsFor(delegateEmployeeId: string): Promise<string[]> {
    const now = new Date();
    const delegations = await this.prisma.delegation.findMany({
      where: {
        delegateEmployeeId,
        validFrom: { lte: now },
        validTo: { gte: now },
      },
      select: { managerEmployeeId: true },
    });
    return delegations.map((item) => item.managerEmployeeId);
  }

  private approvedEvent(request: Request, context: RequestContext) {
    return this.publisher.wrap<RequestApproved>(
      ApprovalEvents.REQUEST_APPROVED,
      {
        requestId: request.id,
        type: request.type,
        authorEmployeeId: request.authorEmployeeId,
        payload: request.payload as Record<string, unknown>,
      },
      context,
    );
  }

  /** Статусы, из которых заявка уже не изменится. */
  static readonly TERMINAL_STATUSES: RequestStatus[] = [
    'APPLIED',
    'REJECTED',
    'CANCELLED',
    'EXPIRED',
  ];
}
