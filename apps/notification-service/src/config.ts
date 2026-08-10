import { Global, Module } from '@nestjs/common';
import { booleanEnv, numberEnv, optionalEnv } from '@crm/common';

/**
 * Конфигурация каналов доставки.
 *
 * Читается один раз при старте, а не при каждой отправке: настройки SMTP
 * и VAPID меняются вместе с развёртыванием, и перечитывание окружения
 * в горячем пути только маскировало бы момент, когда конфигурация
 * фактически изменилась.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface NotificationConfig {
  /**
   * Базовый адрес интерфейса. Ссылки в письме и в push обязаны быть
   * абсолютными: письмо открывают в почтовом клиенте, где относительный
   * путь никуда не ведёт.
   */
  publicBaseUrl: string;
  smtp: SmtpConfig;
  /**
   * null, если ключи VAPID не заданы. Web Push тогда не отправляется, и
   * это видно в ответе GetVapidKey — интерфейс не предлагает включить
   * подписку, которая всё равно не сработает.
   */
  vapid: VapidConfig | null;

  /** Интервал опроса очереди доставки. */
  deliveryPollMs: number;
  deliveryBatchSize: number;
  /** Сколько раз повторять отправку до FAILED. Совпадает с §7.7. */
  maxDeliveryAttempts: number;

  /** Хранение in-app истории и отметок обработанных событий. */
  notificationRetentionDays: number;
  processedEventRetentionDays: number;
}

export function loadNotificationConfig(): NotificationConfig {
  const vapidPublic = optionalEnv('VAPID_PUBLIC_KEY', '');
  const vapidPrivate = optionalEnv('VAPID_PRIVATE_KEY', '');

  return {
    publicBaseUrl: optionalEnv('PUBLIC_BASE_URL', 'http://localhost:8080').replace(/\/+$/, ''),
    smtp: {
      host: optionalEnv('SMTP_HOST', 'mailhog'),
      port: numberEnv('SMTP_PORT', 1025),
      secure: booleanEnv('SMTP_SECURE', false),
      user: process.env.SMTP_USER || undefined,
      password: process.env.SMTP_PASSWORD || undefined,
      from: optionalEnv('SMTP_FROM', 'CRM <noreply@example.local>'),
    },
    vapid:
      vapidPublic && vapidPrivate
        ? {
            publicKey: vapidPublic,
            privateKey: vapidPrivate,
            subject: optionalEnv('VAPID_SUBJECT', 'mailto:admin@example.local'),
          }
        : null,

    deliveryPollMs: numberEnv('DELIVERY_POLL_MS', 2_000),
    deliveryBatchSize: numberEnv('DELIVERY_BATCH_SIZE', 50),
    maxDeliveryAttempts: numberEnv('DELIVERY_MAX_ATTEMPTS', 4),

    notificationRetentionDays: numberEnv('NOTIFICATION_RETENTION_DAYS', 90),
    processedEventRetentionDays: numberEnv('PROCESSED_EVENT_RETENTION_DAYS', 7),
  };
}

export const NOTIFICATION_CONFIG = Symbol('NOTIFICATION_CONFIG');

/**
 * Конфигурация как провайдер, а не как вызов loadNotificationConfig()
 * в конструкторе каждого класса: так она читается один раз, и тест
 * может подменить её, не трогая process.env всего процесса.
 */
@Global()
@Module({
  providers: [{ provide: NOTIFICATION_CONFIG, useFactory: loadNotificationConfig }],
  exports: [NOTIFICATION_CONFIG],
})
export class NotificationConfigModule {}
