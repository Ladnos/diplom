import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthClient } from '../clients/auth.client';
import type { AuthenticatedUser } from './auth.guard';

export const PERMISSION_KEY = 'auth:permission';

export interface PermissionRule {
  resource: string;
  action: string;
  /**
   * Откуда взять employeeId владельца объекта. Без него проверяется
   * только наличие права, а область действия возвращается вызывающему,
   * чтобы тот сам ограничил выборку.
   */
  ownerFrom?: { param?: string; query?: string; body?: string };
}

export const RequirePermission = (rule: PermissionRule) => SetMetadata(PERMISSION_KEY, rule);

/** Текущий пользователь из запроса — после JwtAuthGuard. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  return context.switchToHttp().getRequest<Request>().user as AuthenticatedUser;
});

/** Область действия, которую вернул auth-service: домен сам сузит выборку. */
export const PermissionScope = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<Request & { permissionScope?: string }>();
  return request.permissionScope ?? 'SCOPE_UNSPECIFIED';
});

/**
 * Проверка права через auth-service.
 *
 * Gateway не решает сам, кому что можно: вопрос целиком уходит в
 * auth-service вместе с идентификатором владельца объекта. Так правило
 * «руководитель распоряжается только своими подчинёнными» описано в
 * одном месте, а не повторено в каждом контроллере (ADR-3).
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // См. JwtAuthGuard: глобальный guard срабатывает и на сообщениях из
    // брокера, и на сообщениях WebSocket. Права на комнату проверяет сам
    // шлюз при подписке, права на событие из RabbitMQ проверять не у кого.
    if (context.getType() !== 'http') return true;

    const rule = this.reflector.getAllAndOverride<PermissionRule>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!rule) return true;

    const request = context.switchToHttp().getRequest<
      Request & { permissionScope?: string }
    >();
    const user = request.user;
    if (!user) throw new ForbiddenException('запрос не аутентифицирован');

    const ownerId = resolveOwner(request, rule);

    const decision = await this.auth.checkPermission({
      userId: user.userId,
      resource: rule.resource,
      action: rule.action,
      resourceId: (request.params as Record<string, string>)?.id,
      ownerId,
    });

    if (!decision.allowed) {
      throw new ForbiddenException(decision.reason || 'недостаточно прав');
    }

    request.permissionScope = decision.scope;
    return true;
  }
}

function resolveOwner(request: Request, rule: PermissionRule): string | undefined {
  const source = rule.ownerFrom;
  if (!source) return undefined;

  if (source.param) return (request.params as Record<string, string>)?.[source.param];
  if (source.query) return (request.query as Record<string, string>)?.[source.query];
  if (source.body) return (request.body as Record<string, string>)?.[source.body];
  return undefined;
}
