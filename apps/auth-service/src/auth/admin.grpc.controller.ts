import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { AdminService } from './admin.service';

/** Максимум записей на странице: защита от выгрузки всей базы одним запросом. */
const MAX_PAGE_SIZE = 200;

/**
 * gRPC-интерфейс администрирования (AdminService в libs/contracts/proto/auth.proto).
 */
@Controller()
export class AdminGrpcController {
  constructor(private readonly admin: AdminService) {}

  @GrpcMethod('AdminService', 'ListUsers')
  async listUsers(data: {
    query?: string;
    role_code?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) {
    const result = await this.admin.listUsers({
      query: data.query || undefined,
      roleCode: data.role_code || undefined,
      status: data.status || undefined,
      // proto3 отдаёт 0 для незаданного числа — трактуем как «по умолчанию»
      limit: Math.min(data.limit && data.limit > 0 ? data.limit : 50, MAX_PAGE_SIZE),
      offset: data.offset && data.offset > 0 ? data.offset : 0,
    });

    return {
      users: result.users.map(toSummary),
      total: result.total,
    };
  }

  @GrpcMethod('AdminService', 'GetUser')
  async getUser(data: { user_id: string }) {
    return toDetails(await this.admin.getUserDetails(data.user_id));
  }

  @GrpcMethod('AdminService', 'GrantRole')
  async grantRole(data: { user_id: string; role_code: string; actor_user_id: string }) {
    return toDetails(
      await this.admin.grantRole({
        userId: data.user_id,
        roleCode: data.role_code,
        actorUserId: data.actor_user_id,
      }),
    );
  }

  @GrpcMethod('AdminService', 'RevokeRole')
  async revokeRole(data: { user_id: string; role_code: string; actor_user_id: string }) {
    return toDetails(
      await this.admin.revokeRole({
        userId: data.user_id,
        roleCode: data.role_code,
        actorUserId: data.actor_user_id,
      }),
    );
  }

  @GrpcMethod('AdminService', 'BlockUser')
  async blockUser(data: { user_id: string; reason?: string; actor_user_id: string }) {
    return toDetails(
      await this.admin.blockUser({
        userId: data.user_id,
        reason: data.reason || 'причина не указана',
        actorUserId: data.actor_user_id,
      }),
    );
  }

  @GrpcMethod('AdminService', 'UnblockUser')
  async unblockUser(data: { user_id: string; actor_user_id: string }) {
    return toDetails(
      await this.admin.unblockUser({
        userId: data.user_id,
        actorUserId: data.actor_user_id,
      }),
    );
  }

  @GrpcMethod('AdminService', 'ListSessions')
  async listSessions(data: { user_id: string }) {
    const sessions = await this.admin.listSessions(data.user_id);
    return {
      sessions: sessions.map((session) => ({
        session_id: session.sessionId,
        user_agent: session.userAgent,
        ip: session.ip,
        created_at: session.createdAt,
        expires_at: session.expiresAt,
      })),
    };
  }

  @GrpcMethod('AdminService', 'RevokeUserSessions')
  async revokeUserSessions(data: { user_id: string; reason?: string; actor_user_id: string }) {
    const value = await this.admin.revokeUserSessions({
      userId: data.user_id,
      reason: data.reason || 'отозвано администратором',
      actorUserId: data.actor_user_id,
    });
    return { value };
  }

  @GrpcMethod('AdminService', 'ListRoles')
  async listRoles() {
    const roles = await this.admin.listRoles();
    return {
      roles: roles.map((role) => ({
        code: role.code,
        name: role.name,
        permissions: role.permissions,
        user_count: role.userCount,
      })),
    };
  }
}

type Summary = Awaited<ReturnType<AdminService['getUserDetails']>>['summary'];
type Details = Awaited<ReturnType<AdminService['getUserDetails']>>;

function toSummary(user: Summary) {
  return {
    user_id: user.userId,
    email: user.email,
    status: user.status,
    employee_id: user.employeeId,
    roles: user.roles,
    created_at: user.createdAt,
    active_sessions: user.activeSessions,
  };
}

function toDetails(details: Details) {
  return {
    summary: toSummary(details.summary),
    grants: details.grants.map((grant) => ({
      role_code: grant.roleCode,
      role_name: grant.roleName,
      auto: grant.auto,
      assigned_by: grant.assignedBy,
      assigned_at: grant.assignedAt,
    })),
  };
}
