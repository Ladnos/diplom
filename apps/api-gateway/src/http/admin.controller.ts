import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { AdminClient, type UserDetailsDto, type UserSummaryDto } from '../clients/admin.client';
import { HrClient } from '../clients/hr.client';
import type { AuthenticatedUser } from '../auth/auth.guard';
import { CurrentUser, RequirePermission } from '../auth/permission.guard';
import { BlockUserDto, GrantRoleDto, ListUsersQuery } from './dto';

/**
 * Администрирование пользователей и ролей.
 *
 * Все маршруты требуют права `role/write` со scope GLOBAL — им обладает
 * только роль ADMIN. Проверка выполняется в auth-service, здесь только
 * объявление требования.
 *
 * КРИТИЧНО: идентификатор администратора берётся из проверенного токена
 * (@CurrentUser), а НЕ из тела запроса. Иначе любой обладатель права мог
 * бы подставить чужой actor_user_id и обойти защиту от самоблокировки,
 * а журнал аудита указал бы не на того человека.
 */
@Controller('api/admin')
@RequirePermission({ resource: 'role', action: 'write' })
export class AdminController {
  constructor(
    private readonly admin: AdminClient,
    private readonly hr: HrClient,
  ) {}

  /** Справочник ролей с их правами — для интерфейса назначения. */
  @Get('roles')
  async listRoles() {
    const result = await this.admin.listRoles();
    return {
      roles: result.roles.map((role) => ({
        code: role.code,
        name: role.name,
        userCount: role.user_count,
        permissions: role.permissions,
      })),
    };
  }

  /**
   * Список пользователей с поиском и постраничной выдачей.
   *
   * ФИО подмешивается из hr-service одним батчевым вызовом: в auth_db
   * его нет и быть не должно — мастер-данные о персонале принадлежат
   * кадровому сервису.
   */
  @Get('users')
  async listUsers(@Query() query: ListUsersQuery) {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const page = await this.admin.listUsers({
      query: query.q,
      roleCode: query.role,
      status: query.status,
      limit,
      offset,
    });

    const names = await this.resolveNames(page.users);

    return {
      users: page.users.map((user) => toPublicUser(user, names)),
      total: page.total,
      limit,
      offset,
    };
  }

  @Get('users/:id')
  async getUser(@Param('id', ParseUUIDPipe) id: string) {
    const details = await this.admin.getUser(id);
    const names = await this.resolveNames([details.summary]);
    return toPublicDetails(details, names);
  }

  @Post('users/:id/roles')
  async grantRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GrantRoleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const details = await this.admin.grantRole(id, dto.roleCode, actor.userId);
    return toPublicDetails(details, await this.resolveNames([details.summary]));
  }

  @Delete('users/:id/roles/:roleCode')
  async revokeRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('roleCode') roleCode: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const details = await this.admin.revokeRole(id, roleCode, actor.userId);
    return toPublicDetails(details, await this.resolveNames([details.summary]));
  }

  /** Блокировка обрывает все сессии немедленно, не дожидаясь истечения токена. */
  @Post('users/:id/block')
  async blockUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BlockUserDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const details = await this.admin.blockUser(id, dto.reason, actor.userId);
    return toPublicDetails(details, await this.resolveNames([details.summary]));
  }

  @Post('users/:id/unblock')
  async unblockUser(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const details = await this.admin.unblockUser(id, actor.userId);
    return toPublicDetails(details, await this.resolveNames([details.summary]));
  }

  /** Активные сессии: с каких устройств и адресов пользователь вошёл. */
  @Get('users/:id/sessions')
  async listSessions(@Param('id', ParseUUIDPipe) id: string) {
    const result = await this.admin.listSessions(id);
    return {
      sessions: result.sessions.map((session) => ({
        sessionId: session.session_id,
        userAgent: session.user_agent || null,
        ip: session.ip || null,
        createdAt: Number(session.created_at),
        expiresAt: Number(session.expires_at),
      })),
    };
  }

  /** Принудительный выход со всех устройств — без блокировки учётной записи. */
  @Delete('users/:id/sessions')
  @HttpCode(200)
  async revokeSessions(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const result = await this.admin.revokeSessions(id, 'отозвано администратором', actor.userId);
    return { revoked: Number(result.value) };
  }

  /**
   * ФИО по employeeId одним батчевым вызовом.
   *
   * Отказ hr-service не должен ломать админку: список пользователей
   * остаётся работоспособным, просто без имён.
   */
  private async resolveNames(users: UserSummaryDto[]): Promise<Map<string, string>> {
    const ids = users.map((user) => user.employee_id).filter((id): id is string => Boolean(id));
    if (ids.length === 0) return new Map();

    try {
      const result = await this.hr.getEmployeesBatch(ids);
      return new Map(result.employees.map((employee) => [employee.employee_id, employee.full_name]));
    } catch {
      return new Map();
    }
  }
}

function toPublicUser(user: UserSummaryDto, names: Map<string, string>) {
  return {
    userId: user.user_id,
    email: user.email,
    status: user.status,
    employeeId: user.employee_id || null,
    fullName: user.employee_id ? (names.get(user.employee_id) ?? null) : null,
    roles: user.roles ?? [],
    createdAt: Number(user.created_at),
    activeSessions: user.active_sessions ?? 0,
  };
}

function toPublicDetails(details: UserDetailsDto, names: Map<string, string>) {
  return {
    ...toPublicUser(details.summary, names),
    grants: (details.grants ?? []).map((grant) => ({
      roleCode: grant.role_code,
      roleName: grant.role_name,
      // Роль выдана системой из оргструктуры: снять её вручную нельзя,
      // интерфейс должен показывать такие записи иначе.
      auto: grant.auto,
      assignedBy: grant.assigned_by || null,
      assignedAt: Number(grant.assigned_at),
    })),
  };
}
