import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { SERVICES } from '@crm/contracts';
import { DEADLINES_MS, grpcClientToken } from '@crm/grpc-clients';

interface AuthGrpc {
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
 * approval-service НЕ решает сам, кто может утверждать заявку: вопрос
 * целиком уходит в auth вместе с владельцем объекта. Иначе правило
 * «руководитель распоряжается только своими подчинёнными» оказалось бы
 * описанным в двух местах и рано или поздно разошлось (ADR-3).
 */
@Injectable()
export class AuthClient implements OnModuleInit {
  private service!: AuthGrpc;

  constructor(@Inject(grpcClientToken(SERVICES.AUTH)) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.service = this.client.getService<AuthGrpc>('AuthService');
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
