import { createHash } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC } from '@crm/common';
import { AuthClient, type TokenClaims } from '../clients/auth.client';
import { RedisService } from '../cache/redis.service';

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
 * Проверка access-токена через auth-service.
 *
 * Gateway НЕ проверяет подпись сам, хотя технически мог бы: тогда секрет
 * пришлось бы раздать всем краевым инстансам, а решение о валидности
 * разъехалось бы с логикой отзыва. Вместо этого — вызов ValidateToken
 * с дедлайном 500 мс и кэшем результата в Redis.
 *
 * Кэш живёт 60 секунд (§10.1). Это осознанный компромисс: отозванный
 * токен продолжает действовать до минуты. Для немедленного обрыва
 * доступа служит отзыв refresh-сессии, а не ожидание протухания кэша.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private static readonly CACHE_TTL_SECONDS = 60;

  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthClient,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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

    const claims = await this.resolveClaims(token);
    request.user = {
      userId: claims.user_id,
      employeeId: claims.employee_id || undefined,
      roles: claims.roles ?? [],
      isManager: claims.is_manager ?? false,
    };
    return true;
  }

  private async resolveClaims(token: string): Promise<TokenClaims> {
    const cacheKey = `auth:token:${hashToken(token)}`;

    const cached = await this.redis.getJson<TokenClaims>(cacheKey);
    if (cached) return cached;

    try {
      const claims = await this.auth.validateToken(token);
      // TTL не длиннее остатка жизни самого токена — иначе кэш продлил бы
      // действие истёкшего access-токена.
      const remainingSeconds = Math.floor((claims.expires_at - Date.now()) / 1000);
      const ttl = Math.max(1, Math.min(JwtAuthGuard.CACHE_TTL_SECONDS, remainingSeconds));
      await this.redis.setJson(cacheKey, claims, ttl);
      return claims;
    } catch {
      throw new UnauthorizedException('токен недействителен или истёк');
    }
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

/** Ключ кэша — хэш токена: сам токен в Redis не попадает. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}
