import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { SERVICES } from '@crm/contracts';
import { DEADLINES_MS, grpcClientToken } from '@crm/grpc-clients';

/**
 * Клиент к auth-service.
 *
 * Дедлайн задаётся на каждый вызов: без него зависший адресат держит
 * gateway до TCP-таймаута, а тот — пользователя (§6.4). Проверка прав
 * получает более жёсткий бюджет, потому что выполняется на КАЖДЫЙ запрос.
 */

export interface TokenClaims {
  user_id: string;
  employee_id: string;
  roles: string[];
  is_manager: boolean;
  expires_at: number;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  access_expires_at: number;
  refresh_expires_at: number;
}

export interface PermissionResult {
  allowed: boolean;
  reason: string;
  scope: string;
}

interface AuthGrpc {
  Register(data: { email: string; password: string; full_name: string }): Observable<{ user_id: string }>;
  Login(data: {
    email: string;
    password: string;
    user_agent?: string;
    ip?: string;
  }): Observable<TokenPair>;
  RefreshToken(data: { refresh_token: string }): Observable<TokenPair>;
  ValidateToken(data: { access_token: string }): Observable<TokenClaims>;
  CheckPermission(data: {
    user_id: string;
    resource: string;
    action: string;
    resource_id?: string;
    owner_id?: string;
  }): Observable<PermissionResult>;
  RevokeAllSessions(data: { user_id: string; reason: string }): Observable<object>;
}

@Injectable()
export class AuthClient implements OnModuleInit {
  private service!: AuthGrpc;

  constructor(@Inject(grpcClientToken(SERVICES.AUTH)) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.service = this.client.getService<AuthGrpc>('AuthService');
  }

  register(email: string, password: string, fullName: string) {
    return firstValueFrom(
      this.service
        .Register({ email, password, full_name: fullName })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  login(email: string, password: string, meta: { userAgent?: string; ip?: string }) {
    return firstValueFrom(
      this.service
        .Login({ email, password, user_agent: meta.userAgent, ip: meta.ip })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  refresh(refreshToken: string) {
    return firstValueFrom(
      this.service.RefreshToken({ refresh_token: refreshToken }).pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  validateToken(accessToken: string) {
    return firstValueFrom(
      this.service
        .ValidateToken({ access_token: accessToken })
        .pipe(timeout(DEADLINES_MS.PERMISSION)),
    );
  }

  checkPermission(input: {
    userId: string;
    resource: string;
    action: string;
    resourceId?: string;
    ownerId?: string;
  }) {
    return firstValueFrom(
      this.service
        .CheckPermission({
          user_id: input.userId,
          resource: input.resource,
          action: input.action,
          resource_id: input.resourceId ?? '',
          owner_id: input.ownerId ?? '',
        })
        .pipe(timeout(DEADLINES_MS.PERMISSION)),
    );
  }
}
