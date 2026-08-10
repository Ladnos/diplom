import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { SERVICES } from '@crm/contracts';
import { DEADLINES_MS, grpcClientToken } from '@crm/grpc-clients';

export interface UserSummaryDto {
  user_id: string;
  email: string;
  status: string;
  employee_id: string;
  roles: string[];
  created_at: number;
  active_sessions: number;
}

export interface RoleGrantDto {
  role_code: string;
  role_name: string;
  auto: boolean;
  assigned_by: string;
  assigned_at: number;
}

export interface UserDetailsDto {
  summary: UserSummaryDto;
  grants: RoleGrantDto[];
}

export interface SessionInfoDto {
  session_id: string;
  user_agent: string;
  ip: string;
  created_at: number;
  expires_at: number;
}

export interface RoleInfoDto {
  code: string;
  name: string;
  permissions: { resource: string; action: string; scope: string }[];
  user_count: number;
}

interface AdminGrpc {
  ListUsers(data: {
    query?: string;
    role_code?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Observable<{ users: UserSummaryDto[]; total: number }>;
  GetUser(data: { user_id: string }): Observable<UserDetailsDto>;
  GrantRole(data: {
    user_id: string;
    role_code: string;
    actor_user_id: string;
  }): Observable<UserDetailsDto>;
  RevokeRole(data: {
    user_id: string;
    role_code: string;
    actor_user_id: string;
  }): Observable<UserDetailsDto>;
  BlockUser(data: {
    user_id: string;
    reason: string;
    actor_user_id: string;
  }): Observable<UserDetailsDto>;
  UnblockUser(data: { user_id: string; actor_user_id: string }): Observable<UserDetailsDto>;
  ListSessions(data: { user_id: string }): Observable<{ sessions: SessionInfoDto[] }>;
  RevokeUserSessions(data: {
    user_id: string;
    reason: string;
    actor_user_id: string;
  }): Observable<{ value: number }>;
  ListRoles(data: Record<string, never>): Observable<{ roles: RoleInfoDto[] }>;
}

/**
 * Клиент к AdminService.
 *
 * Отдельный от AuthClient намеренно: административные операции редки,
 * тяжелее и требуют иных дедлайнов, чем проверка токена на каждом
 * запросе. Смешав их, легко случайно выставить общий бюджет 500 мс
 * и получать таймауты на выборке пользователей.
 */
@Injectable()
export class AdminClient implements OnModuleInit {
  private service!: AdminGrpc;

  constructor(@Inject(grpcClientToken(SERVICES.AUTH)) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.service = this.client.getService<AdminGrpc>('AdminService');
  }

  listUsers(input: {
    query?: string;
    roleCode?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) {
    return firstValueFrom(
      this.service
        .ListUsers({
          query: input.query,
          role_code: input.roleCode,
          status: input.status,
          limit: input.limit,
          offset: input.offset,
        })
        .pipe(timeout(DEADLINES_MS.REPORTING)),
    );
  }

  getUser(userId: string) {
    return firstValueFrom(
      this.service.GetUser({ user_id: userId }).pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  grantRole(userId: string, roleCode: string, actorUserId: string) {
    return firstValueFrom(
      this.service
        .GrantRole({ user_id: userId, role_code: roleCode, actor_user_id: actorUserId })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  revokeRole(userId: string, roleCode: string, actorUserId: string) {
    return firstValueFrom(
      this.service
        .RevokeRole({ user_id: userId, role_code: roleCode, actor_user_id: actorUserId })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  blockUser(userId: string, reason: string, actorUserId: string) {
    return firstValueFrom(
      this.service
        .BlockUser({ user_id: userId, reason, actor_user_id: actorUserId })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  unblockUser(userId: string, actorUserId: string) {
    return firstValueFrom(
      this.service
        .UnblockUser({ user_id: userId, actor_user_id: actorUserId })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  listSessions(userId: string) {
    return firstValueFrom(
      this.service.ListSessions({ user_id: userId }).pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  revokeSessions(userId: string, reason: string, actorUserId: string) {
    return firstValueFrom(
      this.service
        .RevokeUserSessions({ user_id: userId, reason, actor_user_id: actorUserId })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  listRoles() {
    return firstValueFrom(this.service.ListRoles({}).pipe(timeout(DEADLINES_MS.DEFAULT)));
  }
}
