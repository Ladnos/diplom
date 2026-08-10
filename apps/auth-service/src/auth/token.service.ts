import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { requireEnv, optionalEnv } from '@crm/common';

/**
 * Выпуск и проверка токенов.
 *
 * Схема: короткоживущий access-JWT + долгоживущий refresh-токен.
 *
 * Access — самодостаточный JWT: его проверка не требует обращения к БД,
 * поэтому api-gateway валидирует запросы дёшево. Обратная сторона —
 * отозвать его до истечения нельзя, отсюда малый TTL (15 минут).
 *
 * Refresh — НЕ JWT, а случайная строка. Он хранится в БД (хэшем) и потому
 * отзывается мгновенно: увольнение сотрудника обрывает все его сессии
 * в тот же момент, а не через срок жизни токена.
 */
export interface AccessTokenClaims {
  sub: string;
  employeeId?: string;
  roles: string[];
  isManager: boolean;
}

@Injectable()
export class TokenService {
  private readonly accessSecret = requireEnv('JWT_ACCESS_SECRET');
  // В секундах, а не строкой: типы jsonwebtoken принимают только литералы
  // вида '15m', а значение приходит из переменной окружения.
  private readonly accessTtlSeconds = parseDuration(optionalEnv('JWT_ACCESS_TTL', '15m'), 900);
  private readonly refreshTtlSeconds = parseDuration(
    optionalEnv('JWT_REFRESH_TTL', '30d'),
    30 * 24 * 60 * 60,
  );

  constructor(private readonly jwt: JwtService) {}

  async issueAccessToken(claims: AccessTokenClaims): Promise<{ token: string; expiresAt: number }> {
    const token = await this.jwt.signAsync(claims, {
      secret: this.accessSecret,
      expiresIn: this.accessTtlSeconds,
    });
    const decoded = this.jwt.decode(token) as { exp: number };
    return { token, expiresAt: decoded.exp * 1000 };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims & { exp: number }> {
    return this.jwt.verifyAsync(token, { secret: this.accessSecret });
  }

  /**
   * Refresh-токен: 32 случайных байта.
   * В базу кладётся SHA-256 от него — при утечке дампа токены бесполезны.
   * Быстрый хэш здесь уместен в отличие от паролей: значение имеет высокую
   * энтропию, перебирать нечего.
   */
  issueRefreshToken(): { token: string; hash: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    return {
      token,
      hash: TokenService.hashRefreshToken(token),
      expiresAt: new Date(Date.now() + this.refreshTtlSeconds * 1000),
    };
  }

  static hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

/** Разбор длительности вида 15m / 24h / 30d / 3600 в секунды. */
function parseDuration(raw: string, fallbackSeconds: number): number {
  const match = /^(\d+)\s*([smhd]?)$/i.exec(raw.trim());
  if (!match) return fallbackSeconds;

  const value = Number(match[1]);
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400, '': 1 }[match[2].toLowerCase()] ?? 1;
  return value * multiplier;
}
