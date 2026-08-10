import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApprovalClient, type RequestDto } from '../clients/approval.client';
import { HrClient } from '../clients/hr.client';
import type { AuthenticatedUser } from '../auth/auth.guard';
import { CurrentUser, RequirePermission } from '../auth/permission.guard';
import { CreateRequestDto, DecisionDto, DelegationDto, PageQuery } from './dto';

/**
 * Заявки на согласование.
 *
 * КРИТИЧНО: автор заявки и согласующий берутся из проверенного токена,
 * а не из тела запроса. Иначе можно подать заявку от чужого имени или
 * подставить себя согласующим — и весь маршрут теряет смысл.
 *
 * Права проверяются дважды и это не избыточность: здесь — что у роли
 * вообще есть право approve, в approval-service — что этот человек стоит
 * в маршруте ИМЕННО этой заявки и является руководителем её автора.
 */
@Controller('api/requests')
export class RequestsController {
  constructor(
    private readonly approval: ApprovalClient,
    private readonly hr: HrClient,
  ) {}

  /**
   * Типы заявок, доступные текущему сотруднику.
   *
   * Зависят от типа найма (§3.3): у самозанятого в списке не будет ни
   * отпуска, ни переработки. Интерфейс не должен их показывать — это
   * лучше, чем отклонять форму после заполнения.
   */
  @Get('types')
  @RequirePermission({ resource: 'request', action: 'read' })
  async getAvailableTypes(@CurrentUser() user: AuthenticatedUser) {
    const employeeId = this.requireEmployee(user);
    const result = await this.approval.getAvailableTypes(employeeId);
    return {
      types: (result.details ?? []).map((info) => ({
        type: info.type,
        title: info.title,
        managerLevels: info.manager_levels,
        requiresHr: info.requires_hr,
        slaHours: info.sla_hours,
      })),
    };
  }

  @Post()
  @RequirePermission({ resource: 'request', action: 'create' })
  async create(@Body() dto: CreateRequestDto, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = this.requireEmployee(user);
    const request = await this.approval.createRequest(dto.type, employeeId, dto.payload);
    return this.enrich(request);
  }

  /** Мои заявки. */
  @Get('my')
  @RequirePermission({ resource: 'request', action: 'read' })
  async listMy(@Query() query: PageQuery, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = this.requireEmployee(user);
    const result = await this.approval.listMyRequests(
      employeeId,
      query.limit ?? 50,
      query.offset ?? 0,
    );
    return {
      requests: await this.enrichMany(result.requests),
      hasMore: result.page?.has_more ?? false,
    };
  }

  /** Очередь согласующего: заявки, ждущие решения именно сейчас. */
  @Get('inbox')
  @RequirePermission({ resource: 'request', action: 'approve' })
  async listInbox(@Query() query: PageQuery, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = this.requireEmployee(user);
    const result = await this.approval.listPendingForMe(
      employeeId,
      query.limit ?? 50,
      query.offset ?? 0,
    );
    return {
      requests: await this.enrichMany(result.requests),
      hasMore: result.page?.has_more ?? false,
    };
  }

  /** Счётчик для бейджа в интерфейсе. */
  @Get('inbox/count')
  @RequirePermission({ resource: 'request', action: 'approve' })
  async inboxCount(@CurrentUser() user: AuthenticatedUser) {
    const employeeId = this.requireEmployee(user);
    const result = await this.approval.getPendingCount(employeeId);
    return { pending: Number(result.value) };
  }

  @Get(':id')
  @RequirePermission({ resource: 'request', action: 'read' })
  async getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.enrich(await this.approval.getRequest(id));
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission({ resource: 'request', action: 'approve' })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecisionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const employeeId = this.requireEmployee(user);
    const request = await this.approval.approve(id, employeeId, user.userId, dto.comment);
    const enriched = await this.enrich(request);

    return {
      ...enriched,
      message:
        request.status === 'APPROVED'
          ? 'заявка утверждена; результат будет применён в течение нескольких секунд'
          : 'шаг согласования пройден, заявка передана следующему согласующему',
    };
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission({ resource: 'request', action: 'approve' })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecisionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const employeeId = this.requireEmployee(user);
    return this.enrich(await this.approval.reject(id, employeeId, user.userId, dto.comment));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission({ resource: 'request', action: 'cancel' })
  async cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = this.requireEmployee(user);
    return this.enrich(await this.approval.cancel(id, employeeId));
  }

  /**
   * Делегирование согласования на время отсутствия.
   *
   * Руководитель назначает заместителя сам: право approve на подчинённых
   * у него уже есть, и передача его на период — часть той же зоны
   * ответственности.
   */
  @Post('delegation')
  @RequirePermission({ resource: 'request', action: 'approve' })
  async setDelegation(@Body() dto: DelegationDto, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = this.requireEmployee(user);
    await this.approval.setDelegation(employeeId, dto.delegateEmployeeId, dto.from, dto.to);
    return {
      managerEmployeeId: employeeId,
      delegateEmployeeId: dto.delegateEmployeeId,
      period: { from: dto.from, to: dto.to },
      message: 'делегирование оформлено; заместитель увидит заявки в своей очереди',
    };
  }

  // ── Внутреннее ───────────────────────────────────────────────────────

  private requireEmployee(user: AuthenticatedUser): string {
    if (!user.employeeId) {
      throw new BadRequestException(
        'профиль сотрудника ещё не создан; подача и согласование заявок недоступны',
      );
    }
    return user.employeeId;
  }

  /**
   * Подмешивает ФИО автора и согласующих одним батчевым вызовом.
   * Отказ hr-service не ломает список: заявки видны, просто без имён.
   */
  private async enrichMany(requests: RequestDto[]) {
    if (requests.length === 0) return [];

    const ids = new Set<string>();
    for (const request of requests) {
      ids.add(request.author_employee_id);
      for (const step of request.steps ?? []) ids.add(step.approver_employee_id);
    }

    const names = await this.hr
      .getEmployeesBatch([...ids].filter(Boolean))
      .then((result) => new Map(result.employees.map((e) => [e.employee_id, e.full_name])))
      .catch(() => new Map<string, string>());

    return requests.map((request) => toPublicRequest(request, names));
  }

  private async enrich(request: RequestDto) {
    const [enriched] = await this.enrichMany([request]);
    return enriched;
  }
}

function toPublicRequest(request: RequestDto, names: Map<string, string>) {
  let payload: unknown = {};
  try {
    payload = request.payload_json ? JSON.parse(request.payload_json) : {};
  } catch {
    payload = { raw: request.payload_json };
  }

  return {
    requestId: request.request_id,
    type: request.type,
    status: request.status,
    author: {
      employeeId: request.author_employee_id,
      fullName: names.get(request.author_employee_id) ?? null,
    },
    payload,
    currentStep: request.current_step,
    steps: (request.steps ?? []).map((step) => ({
      order: step.order,
      approver: {
        employeeId: step.approver_employee_id,
        fullName: names.get(step.approver_employee_id) ?? null,
      },
      // Заполнено, если решение принял заместитель по делегированию
      decidedBy: step.delegated_to || null,
      status: step.status,
      comment: step.comment || null,
      decidedAt: Number(step.decided_at) || null,
    })),
    slaDeadline: Number(request.sla_deadline) || null,
    createdAt: Number(request.created_at),
    failureReason: request.failure_reason || null,
  };
}
