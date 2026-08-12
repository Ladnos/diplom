import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC } from '@crm/common';
import { TokenResolver } from './token-resolver';

export interface AuthenticatedUser {
  userId: string;
  employeeId?: string;
  roles: string[];
  isManager: boolean;
}

declare module 'express' {
  interface Request {
    user?: AuthenticatedUser;
  }
}

/**
 * Проверка access-токена HTTP-запроса.
 *
 * Само разрешение токена живёт в TokenResolver: тем же кодом пользуется
 * рукопожатие WebSocket, и решение о валидности обязано совпадать для
 * обоих транспортов.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Guard зарегистрирован глобально и потому вызывается для ВСЕХ
    // транспортов, а не только для HTTP. У сообщения из RabbitMQ нет
    // заголовка Authorization, и требовать его бессмысленно: источник —
    // брокер, а не клиент. У WebSocket токен предъявляется один раз при
    // рукопожатии, там же и проверяется; отдельные сообщения внутри уже
    // установленного соединения переспрашивать не нужно.
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = extractBearer(request);
    if (!token) {
      throw new UnauthorizedException('требуется заголовок Authorization: Bearer <token>');
    }

    const claims = await this.tokens
      .resolve(token)
      .catch(() => {
        throw new UnauthorizedException('токен недействителен или истёк');
      });

    request.user = {
      userId: claims.user_id,
      employeeId: claims.employee_id || undefined,
      roles: claims.roles ?? [],
      isManager: claims.is_manager ?? false,
    };
    return true;
  }
}

function extractBearer(request: Request): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();

  // Веб-клиент хранит токен в httpOnly-cookie: так его не достанет XSS
  const fromCookie = (request as Request & { cookies?: Record<string, string> }).cookies
    ?.access_token;
  return fromCookie ?? null;
}
