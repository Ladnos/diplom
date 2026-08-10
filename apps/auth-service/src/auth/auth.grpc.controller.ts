import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { AuthService } from './auth.service';
import { PermissionService } from './permission.service';

/**
 * gRPC-интерфейс auth-service (libs/contracts/proto/auth.proto).
 *
 * Имена полей — snake_case: загрузчик настроен с keepCase: true, поэтому
 * контракт и код называют поля одинаково и при чтении логов gRPC не
 * приходится держать в голове два варианта одного имени.
 */
@Controller()
export class AuthGrpcController {
  constructor(
    private readonly auth: AuthService,
    private readonly permissions: PermissionService,
  ) {}

  @GrpcMethod('AuthService', 'Register')
  async register(data: { email: string; password: string; full_name: string }) {
    const result = await this.auth.register({
      email: data.email,
      password: data.password,
      fullName: data.full_name,
    });
    return { user_id: result.userId };
  }

  @GrpcMethod('AuthService', 'Login')
  async login(data: { email: string; password: string; user_agent?: string; ip?: string }) {
    const result = await this.auth.login({
      email: data.email,
      password: data.password,
      userAgent: data.user_agent,
      ip: data.ip,
    });
    return {
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      access_expires_at: result.accessExpiresAt,
      refresh_expires_at: result.refreshExpiresAt,
    };
  }

  @GrpcMethod('AuthService', 'RefreshToken')
  async refresh(data: { refresh_token: string }) {
    const result = await this.auth.refresh(data.refresh_token, {});
    return {
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      access_expires_at: result.accessExpiresAt,
      refresh_expires_at: result.refreshExpiresAt,
    };
  }

  @GrpcMethod('AuthService', 'ValidateToken')
  async validateToken(data: { access_token: string }) {
    const claims = await this.auth.validateAccessToken(data.access_token);
    return {
      user_id: claims.userId,
      employee_id: claims.employeeId,
      roles: claims.roles,
      is_manager: claims.isManager,
      expires_at: claims.expiresAt,
    };
  }

  @GrpcMethod('AuthService', 'CheckPermission')
  async checkPermission(data: {
    user_id: string;
    resource: string;
    action: string;
    resource_id?: string;
    owner_id?: string;
  }) {
    const decision = await this.permissions.check({
      userId: data.user_id,
      resource: data.resource,
      action: data.action,
      resourceId: data.resource_id || undefined,
      ownerId: data.owner_id || undefined,
    });
    return { allowed: decision.allowed, reason: decision.reason, scope: decision.scope };
  }

  /**
   * Пакетная проверка: интерфейс часто спрашивает права сразу на список
   * объектов (какие карточки можно редактировать). Отдельный вызов на
   * каждую превратил бы отрисовку доски в десятки round-trip'ов.
   */
  @GrpcMethod('AuthService', 'CheckPermissionsBatch')
  async checkPermissionsBatch(data: {
    requests: {
      user_id: string;
      resource: string;
      action: string;
      resource_id?: string;
      owner_id?: string;
    }[];
  }) {
    const results = await Promise.all(
      (data.requests ?? []).map((request) =>
        this.permissions.check({
          userId: request.user_id,
          resource: request.resource,
          action: request.action,
          resourceId: request.resource_id || undefined,
          ownerId: request.owner_id || undefined,
        }),
      ),
    );
    return { results };
  }

  @GrpcMethod('AuthService', 'RevokeSession')
  async revokeSession(data: { session_id: string }) {
    await this.auth.revokeSession(data.session_id);
    return {};
  }

  @GrpcMethod('AuthService', 'RevokeAllSessions')
  async revokeAllSessions(data: { user_id: string; reason?: string }) {
    await this.auth.revokeAllSessions(data.user_id, data.reason ?? 'запрошено извне');
    return {};
  }
}
