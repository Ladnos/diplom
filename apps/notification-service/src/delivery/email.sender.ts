import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { NOTIFICATION_CONFIG, type NotificationConfig } from '../config';
import { renderEmail } from '../notify/templates';
import type { ChannelSender, OutgoingMessage, SendResult } from './sender';

/**
 * Отправка почты по SMTP.
 *
 * Пул соединений вместо соединения на письмо: рукопожатие TLS с внешним
 * сервером стоит сотни миллисекунд, и на рассылке по отделу это
 * превращается в минуты, потраченные на переподключения.
 *
 * Ошибки разделяются по коду ответа: 4xx у SMTP означает «попробуйте
 * позже» (ящик занят, превышен лимит), 5xx — «такого адреса нет».
 * Повторять во втором случае нечего, и такие письма помечаются DROPPED,
 * а не расходуют все попытки.
 */
@Injectable()
export class EmailSender implements ChannelSender, OnApplicationShutdown {
  private readonly logger = new Logger(EmailSender.name);
  private readonly transporter: Transporter;

  readonly available = true;

  constructor(@Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig) {
    const smtp = config.smtp;
    this.transporter = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      // Без явных таймаутов зависший SMTP держит воркер доставки до
      // системного таймаута TCP, и очередь стоит всё это время.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

    this.logger.log({
      message: 'канал почты настроен',
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      authenticated: Boolean(smtp.user),
    });
  }

  onApplicationShutdown(): void {
    this.transporter.close();
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    const { html, text } = renderEmail({
      title: message.title,
      body: message.body,
      link: message.url,
      recipientName: message.recipientName,
    });

    try {
      await this.transporter.sendMail({
        from: this.config.smtp.from,
        to: message.target,
        subject: message.title,
        text,
        html,
        headers: {
          // Автоответчики и правила «нет на месте» не должны отвечать
          // на служебную почту — иначе один отпуск порождает переписку
          // системы с самой собой.
          'Auto-Submitted': 'auto-generated',
          'X-Auto-Response-Suppress': 'All',
          'X-Notification-Id': message.notificationId,
        },
      });
      return { outcome: 'ok' };
    } catch (error) {
      const smtpCode = (error as { responseCode?: number }).responseCode;
      const detail = error instanceof Error ? error.message : String(error);

      if (smtpCode !== undefined && smtpCode >= 500 && smtpCode < 600) {
        return { outcome: 'dropped', error: `SMTP ${smtpCode}: ${detail}` };
      }
      return { outcome: 'retry', error: detail };
    }
  }
}
