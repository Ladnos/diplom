import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { VIDEO_CONFIG, type VideoConfig } from '../config';

export interface JoinClaims {
  roomId: string;
  employeeId: string;
  /** Момент истечения, секунды эпохи. */
  exp: number;
}

/**
 * Пропуск в комнату звонка.
 *
 * Сигналинг идёт МИМО api-gateway напрямую в этот сервис (§8.3), поэтому
 * обычный access-токен здесь неудобен: его пришлось бы проверять вызовом
 * auth-service на каждое открытие соединения, добавляя круг ожидания там,
 * где важна задержка. Вместо этого gateway, уже проверив права, просит
 * IssueJoinToken, а сигналинг проверяет подпись локально.
 *
 * Формат намеренно простой: payload в base64url и HMAC-SHA256 от него.
 * Полноценный JWT здесь дал бы только заголовок с алгоритмом — то есть
 * ровно то поле, подмена которого исторически и ломала разборщики.
 * Токен живёт минуту и не отзывается: он нужен на один вход.
 */
@Injectable()
export class JoinTokenService {
  constructor(@Inject(VIDEO_CONFIG) private readonly config: VideoConfig) {}

  issue(roomId: string, employeeId: string): { token: string; expiresAt: number } {
    const exp = Math.floor(Date.now() / 1000) + this.config.joinTokenTtlSeconds;
    const payload = base64url(JSON.stringify({ roomId, employeeId, exp } satisfies JoinClaims));
    return { token: `${payload}.${this.sign(payload)}`, expiresAt: exp * 1000 };
  }

  /** null — подпись не сошлась, срок истёк или содержимое не разобрано. */
  verify(token: string): JoinClaims | null {
    const separator = token.lastIndexOf('.');
    if (separator <= 0) return null;

    const payload = token.slice(0, separator);
    const signature = token.slice(separator + 1);

    const expected = Buffer.from(this.sign(payload));
    const actual = Buffer.from(signature);
    // Сравнение за постоянное время: обычное === выходит на первом
    // несовпавшем байте, и по времени ответа подпись подбирается
    // побайтово.
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as JoinClaims;
      if (!claims.roomId || !claims.employeeId) return null;
      if (claims.exp * 1000 < Date.now()) return null;
      return claims;
    } catch {
      return null;
    }
  }

  /**
   * ICE-серверы для клиента.
   *
   * STUN обычно достаточно, но не всегда: за симметричным NAT прямое
   * соединение не устанавливается вовсе, и без TURN звонок из корпоративной
   * сети просто не состоится. Учётные данные TURN отдаются вместе с
   * пропуском — coturn в этой сборке настроен на статическую пару.
   */
  iceServers(): { urls: string; username: string; credential: string }[] {
    const { host, port, user, password } = this.config.turn;
    return [
      { urls: `stun:${host}:${port}`, username: '', credential: '' },
      { urls: `turn:${host}:${port}?transport=udp`, username: user, credential: password },
      { urls: `turn:${host}:${port}?transport=tcp`, username: user, credential: password },
    ];
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.config.joinTokenSecret).update(payload).digest('base64url');
  }
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}
