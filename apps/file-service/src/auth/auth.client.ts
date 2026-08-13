import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { SERVICES } from '@crm/contracts';
import { DEADLINES_MS, grpcClientToken } from '@crm/grpc-clients';

export interface TokenClaims {
  user_id: string;
  employee_id: string;
  roles: string[];
  is_manager: boolean;
  expires_at: number;
}

interface AuthGrpc {
  ValidateToken(data: { access_token: string }): Observable<TokenClaims>;
  CheckPermission(data: {
    user_id: string;
    resource: string;
    action: string;
    resource_id?: string;
    owner_id?: string;
  }): Observable<{ allowed: boolean; reason: string; scope: string }>;
}

/**
 * Клиент к auth-service.
 *
 * Единственный сервис, кроме api-gateway, который проверяет токены сам, —
 * и по необходимости: загрузка и скачивание файлов идут в него напрямую,
 * минуя шлюз (§9.2). Многомегабайтные тела не должны проходить через
 * сервис, обслуживающий все остальные запросы, а раз запрос приходит
 * напрямую, то и предъявленный токен проверять некому, кроме получателя.
 */
@Injectable()
export class AuthClient implements OnModuleInit {
  private service!: AuthGrpc;

  constructor(@Inject(grpcClientToken(SERVICES.AUTH)) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.service = this.client.getService<AuthGrpc>('AuthService');
  }

  validateToken(accessToken: string): Promise<TokenClaims> {
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
