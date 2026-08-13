import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthClient } from './auth.client';

export interface FileActor {
  userId: string;
  employeeId?: string;
  roles: string[];
}

declare module 'express' {
  interface Request {
    actor?: FileActor;
  }
}

/**
 * Проверка токена на HTTP-маршрутах file-service.
 *
 * Guard применяется точечно к контроллерам загрузки и отдачи, а не
 * глобально: у сервиса есть ещё health-проба и обработчики событий из
 * брокера, где предъявлять токен некому.
 *
 * Кэша здесь нет, в отличие от шлюза. Файловых запросов на порядок
 * меньше, чем обычных, а каждый и без того сопровождается обращением к
 * диску; экономить на них проверку, продлевая жизнь отозванному токену,
 * не стоит.
 */
@Injectable()
export class TokenGuard implements CanActivate {
  constructor(private readonly auth: AuthClient) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = extractBearer(request);
    if (!token) {
      throw new UnauthorizedException('требуется заголовок Authorization: Bearer <token>');
    }

    try {
      const claims = await this.auth.validateToken(token);
      request.actor = {
        userId: claims.user_id,
        employeeId: claims.employee_id || undefined,
        roles: claims.roles ?? [],
      };
      return true;
    } catch {
      throw new UnauthorizedException('токен недействителен или истёк');
    }
  }
}

function extractBearer(request: Request): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();

  const fromCookie = (request as Request & { cookies?: Record<string, string> }).cookies
    ?.access_token;
  return fromCookie ?? null;
}
