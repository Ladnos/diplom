import { Global, Module } from '@nestjs/common';

export const FILE_CONFIG = Symbol('FILE_CONFIG');

export interface FileConfig {
  /** Корень хранилища. Внутри — objects/, thumbs/, tmp/ (§9.1). */
  storagePath: string;
  maxUploadBytes: number;
  /** Секрет подписи ссылок. Обязан совпадать с secure_link_md5 в nginx. */
  signedLinkSecret: string;
  signedLinkTtlSeconds: number;
  quotaPerUserBytes: number;
  /** Доля занятого места, после которой уходит file.storage.low. */
  diskAlertThreshold: number;
  /** Сколько ждать до удаления файла, который никуда не прикрепили. */
  gcGraceDays: number;
}

/**
 * Настройки file-service.
 *
 * FILE_SIGNED_LINK_SECRET обязателен и не имеет умолчания. Значение по
 * умолчанию здесь означало бы, что стенд, поднятый без переменной,
 * подписывает ссылки предсказуемым ключом, — а подпись, которую можно
 * воспроизвести, не подпись. Тот же секрет подставляется в конфигурацию
 * nginx: проверяет ссылку он, а выдаёт её этот сервис, и разойтись они
 * не могут — иначе все ссылки разом станут недействительными (§9.4).
 */
export function loadFileConfig(): FileConfig {
  const secret = process.env.FILE_SIGNED_LINK_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      'FILE_SIGNED_LINK_SECRET обязателен и должен быть не короче 16 символов: ' +
        'этим ключом подписываются ссылки на аватары и превью',
    );
  }

  return {
    storagePath: process.env.FILE_STORAGE_PATH ?? '/data/files',
    maxUploadBytes: positive(process.env.FILE_MAX_UPLOAD_BYTES, 52_428_800),
    signedLinkSecret: secret,
    signedLinkTtlSeconds: positive(process.env.FILE_SIGNED_LINK_TTL, 86_400),
    quotaPerUserBytes: positive(process.env.FILE_QUOTA_PER_USER_BYTES, 5_368_709_120),
    diskAlertThreshold: ratio(process.env.FILE_DISK_ALERT_THRESHOLD, 0.85),
    gcGraceDays: positive(process.env.FILE_GC_GRACE_DAYS, 7),
  };
}

/**
 * @Global, потому что настройки нужны и хранилищу, и контроллерам
 * загрузки и отдачи, и сборщику мусора. Провайдер в корневом модуле был
 * бы невидим из импортированных.
 */
@Global()
@Module({
  providers: [{ provide: FILE_CONFIG, useFactory: loadFileConfig }],
  exports: [FILE_CONFIG],
})
export class FileConfigModule {}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ratio(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : fallback;
}
