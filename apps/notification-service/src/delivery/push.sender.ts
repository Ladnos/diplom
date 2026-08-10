import { Inject, Injectable, Logger } from '@nestjs/common';
import webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';
import { NOTIFICATION_CONFIG, type NotificationConfig } from '../config';
import { truncate } from '../notify/templates';
import type { ChannelSender, OutgoingMessage, SendResult } from './sender';

/**
 * Web Push через VAPID.
 *
 * Ключи не генерируются на лету: сгенерированная при старте пара
 * означала бы, что после перезапуска контейнера все существующие
 * подписки браузеров становятся недействительными, а пользователь об
 * этом не узнаёт — push просто перестаёт приходить. Ключи задаются
 * переменными окружения и переживают развёртывание.
 *
 * Тело push ограничено ~4 КБ на шлюзах, поэтому в него кладётся минимум
 * для показа и ссылка; подробности пользователь увидит, перейдя по ней.
 */
@Injectable()
export class PushSender implements ChannelSender {
  private readonly logger = new Logger(PushSender.name);
  readonly available: boolean;

  constructor(
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
    private readonly prisma: PrismaService,
  ) {
    this.available = config.vapid !== null;

    if (config.vapid) {
      webpush.setVapidDetails(
        config.vapid.subject,
        config.vapid.publicKey,
        config.vapid.privateKey,
      );
      this.logger.log({ message: 'канал Web Push настроен' });
    } else {
      this.logger.warn({
        message: 'VAPID_PUBLIC_KEY и VAPID_PRIVATE_KEY не заданы, Web Push отключён',
      });
    }
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.config.vapid) {
      return { outcome: 'dropped', error: 'ключи VAPID не настроены' };
    }

    const subscription = await this.prisma.pushSubscription.findUnique({
      where: { endpoint: message.target },
    });
    if (!subscription) {
      // Пользователь отозвал подписку между постановкой и отправкой —
      // штатный исход, а не сбой.
      return { outcome: 'dropped', error: 'подписка удалена' };
    }

    const payload = JSON.stringify({
      title: message.title,
      body: truncate(message.body, 200),
      url: message.url,
      priority: message.priority,
      notificationId: message.notificationId,
    });

    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        payload,
        {
          // URGENT доставляется немедленно даже спящему устройству;
          // остальное шлюз вправе придержать до пробуждения ради батареи.
          urgency: message.priority === 'URGENT' ? 'high' : 'normal',
          TTL: message.priority === 'URGENT' ? 300 : 86_400,
        },
      );

      await this.prisma.pushSubscription.update({
        where: { endpoint: subscription.endpoint },
        data: { lastSentAt: new Date() },
      });
      return { outcome: 'ok' };
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      const detail = error instanceof Error ? error.message : String(error);

      // 404/410 от push-шлюза — подписка мертва: браузер удалён,
      // разрешение отозвано, устройство сброшено. Такую подписку нужно
      // убрать, иначе она будет тратить попытки на каждом уведомлении.
      if (statusCode === 404 || statusCode === 410) {
        await this.prisma.pushSubscription
          .delete({ where: { endpoint: subscription.endpoint } })
          .catch(() => undefined);
        this.logger.debug({
          message: 'протухшая push-подписка удалена',
          userId: subscription.userId,
          statusCode,
        });
        return { outcome: 'dropped', error: `push-шлюз вернул ${statusCode}` };
      }

      // 400 и 413 — наша ошибка в запросе или слишком большое тело.
      // Повтор даст тот же результат.
      if (statusCode === 400 || statusCode === 413) {
        return { outcome: 'dropped', error: `push-шлюз вернул ${statusCode}: ${detail}` };
      }

      return { outcome: 'retry', error: detail };
    }
  }
}
