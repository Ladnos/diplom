import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuthClient, type TokenClaims } from '../clients/auth.client';
import { RedisService } from '../cache/redis.service';

/**
 * Разбор access-токена с кэшированием решения.
 *
 * Вынесено из JwtAuthGuard, потому что потребителей стало два: HTTP-запрос
 * приходит с заголовком на каждый вызов, а WebSocket предъявляет токен один
 * раз при рукопожатии и живёт часами. Оба обязаны получать одинаковый ответ
 * на один и тот же токен — иначе соединение оставалось бы открытым для
 * пользователя, которому REST уже отвечает 401.
 *
 * Gateway НЕ проверяет подпись сам: секрет пришлось бы раздать всем краевым
 * инстансам, а решение о валидности разъехалось бы с логикой отзыва (§10.1).
 */
@Injectable()
export class TokenResolver {
  /**
   * Кэш живёт минуту. Осознанный компромисс: отозванный токен продолжает
   * действовать до её истечения. Для немедленного обрыва доступа служит
   * отзыв refresh-сессии, а не ожидание протухания кэша.
   */
  private static readonly CACHE_TTL_SECONDS = 60;

  constructor(
    private readonly auth: AuthClient,
    private readonly redis: RedisService,
  ) {}

  /** Бросает исключение gRPC, если токен недействителен или истёк. */
  async resolve(token: string): Promise<TokenClaims> {
    const cacheKey = `auth:token:${hashToken(token)}`;

    const cached = await this.redis.getJson<TokenClaims>(cacheKey);
    if (cached) return cached;

    const claims = await this.auth.validateToken(token);

    // TTL не длиннее остатка жизни самого токена — иначе кэш продлил бы
    // действие истёкшего access-токена.
    const remainingSeconds = Math.floor((claims.expires_at - Date.now()) / 1000);
    const ttl = Math.max(1, Math.min(TokenResolver.CACHE_TTL_SECONDS, remainingSeconds));
    await this.redis.setJson(cacheKey, claims, ttl);
    return claims;
  }
}

/** Ключ кэша — хэш токена: сам токен в Redis не попадает. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}
