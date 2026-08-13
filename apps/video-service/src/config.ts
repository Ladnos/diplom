import { Global, Module } from '@nestjs/common';

export const VIDEO_CONFIG = Symbol('VIDEO_CONFIG');

export interface VideoConfig {
  /**
   * Адрес, который SFU объявляет клиентам в ICE-кандидатах.
   *
   * Именно ПУБЛИЧНЫЙ адрес сервера, а не адрес контейнера: внутренний IP
   * Docker-сети клиенту недоступен, и кандидат с ним не подключится
   * никогда — соединение будет молча висеть в состоянии checking.
   */
  announcedIp: string;
  rtcMinPort: number;
  rtcMaxPort: number;
  /** Сколько воркеров SFU поднимать. По умолчанию — по числу ядер. */
  workers: number;
  /** Секрет подписи токенов сигналинга. */
  joinTokenSecret: string;
  joinTokenTtlSeconds: number;
  /** Адрес, по которому клиент открывает соединение сигналинга. */
  signalingUrl: string;
  turn: { host: string; port: number; user: string; password: string };
}

/**
 * Настройки video-service.
 *
 * Секрет токена входа обязателен и не имеет умолчания: токеном
 * открывается доступ к чужому разговору, и предсказуемый ключ здесь
 * означает возможность войти в любую комнату.
 */
export function loadVideoConfig(): VideoConfig {
  const secret = process.env.VIDEO_JOIN_TOKEN_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      'VIDEO_JOIN_TOKEN_SECRET обязателен и должен быть не короче 16 символов: ' +
        'этим ключом подписываются пропуска в комнаты звонков',
    );
  }

  return {
    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP ?? '127.0.0.1',
    rtcMinPort: positive(process.env.MEDIASOUP_RTC_MIN_PORT, 40_000),
    rtcMaxPort: positive(process.env.MEDIASOUP_RTC_MAX_PORT, 40_100),
    workers: positive(process.env.MEDIASOUP_WORKERS, 0),
    joinTokenSecret: secret,
    // Минуты хватает: токен нужен ровно на то, чтобы открыть соединение
    // сигналинга. Долгий срок превращает пропуск в постоянный ключ,
    // который остаётся действительным и после выхода из звонка.
    joinTokenTtlSeconds: positive(process.env.VIDEO_JOIN_TOKEN_TTL, 60),
    signalingUrl: process.env.VIDEO_SIGNALING_URL ?? '/signaling',
    turn: {
      host: process.env.TURN_HOST ?? '127.0.0.1',
      port: positive(process.env.TURN_PORT, 3478),
      user: process.env.TURN_USER ?? 'crm',
      password: process.env.TURN_PASSWORD ?? 'crm',
    },
  };
}

@Global()
@Module({
  providers: [{ provide: VIDEO_CONFIG, useFactory: loadVideoConfig }],
  exports: [VIDEO_CONFIG],
})
export class VideoConfigModule {}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
