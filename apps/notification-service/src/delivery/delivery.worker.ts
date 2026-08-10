import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { RETRY_DELAYS_MS } from '@crm/contracts';
import { Channel, DeliveryStatus, type Prisma } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { NOTIFICATION_CONFIG, type NotificationConfig } from '../config';
import { addressee } from '../notify/templates';
import { EmailSender } from './email.sender';
import { PushSender } from './push.sender';
import type { ChannelSender, SendResult } from './sender';

type PendingDelivery = Prisma.DeliveryGetPayload<{
  include: { notification: { include: { contact: true } } };
}>;

/**
 * Воркер доставки. docs/architecture.md §7.7
 *
 * Разделение «решить и записать» / «отправить» — центральное решение
 * сервиса. Обработчик события пишет строки и подтверждает сообщение
 * брокеру за миллисекунды; отправка идёт отсюда, со своими повторами и
 * своим темпом. Иначе недоступный SMTP превращался бы в nack всего
 * события, повторную доставку и дубли по уже отработавшим каналам.
 *
 * Задержки повторов те же, что у брокера (§7.7): 5 с → 30 с → 5 мин.
 * Это не совпадение и не копипаста — правило одно и то же, и разные
 * числа в двух местах пришлось бы объяснять при каждом разборе.
 */
@Injectable()
export class DeliveryWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DeliveryWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailSender,
    private readonly push: PushSender,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule(0);
    this.logger.log({
      message: 'воркер доставки запущен',
      pollMs: this.config.deliveryPollMs,
      batch: this.config.deliveryBatchSize,
      maxAttempts: this.config.maxDeliveryAttempts,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    // Дать текущему проходу дописать результат: оборванная на середине
    // пачка оставила бы отправленные письма в статусе PENDING, и после
    // перезапуска они ушли бы повторно.
    for (let i = 0; i < 100 && this.running; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.running = true;
    let processed = 0;

    try {
      const pending = await this.claim();
      for (const delivery of pending) {
        if (this.stopped) break;
        await this.deliver(delivery);
        processed += 1;
      }
    } catch (error) {
      this.logger.error({
        message: 'ошибка прохода воркера доставки',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
      // Пачка полная — вероятно, есть ещё; идём сразу.
      this.schedule(
        processed >= this.config.deliveryBatchSize ? 0 : this.config.deliveryPollMs,
      );
    }
  }

  /**
   * Выборка готовых к отправке.
   *
   * Инкремент attempts делается СРАЗУ, до отправки, а не после ответа
   * канала. Если процесс упадёт между отправкой и записью результата,
   * попытка окажется учтённой, и письмо уйдёт максимум одним дублем,
   * а не бесконечно. Обратный порядок на падающем SMTP давал бы
   * вечный цикл с нулевым счётчиком.
   */
  private async claim(): Promise<PendingDelivery[]> {
    const now = new Date();
    const candidates = await this.prisma.delivery.findMany({
      where: { status: DeliveryStatus.PENDING, scheduledFor: { lte: now } },
      orderBy: { scheduledFor: 'asc' },
      take: this.config.deliveryBatchSize,
      include: { notification: { include: { contact: true } } },
    });
    if (candidates.length === 0) return [];

    await this.prisma.delivery.updateMany({
      where: { id: { in: candidates.map((item) => item.id) } },
      data: { attempts: { increment: 1 } },
    });

    return candidates.map((item) => ({ ...item, attempts: item.attempts + 1 }));
  }

  private async deliver(delivery: PendingDelivery): Promise<void> {
    const sender = this.senderFor(delivery.channel);
    const notification = delivery.notification;

    const result: SendResult = sender
      ? await sender.send({
          target: delivery.target,
          title: notification.title,
          body: notification.body,
          url: this.absoluteUrl(notification.link),
          recipientName: addressee(notification.contact.fullName),
          priority: notification.priority,
          notificationId: notification.id,
        })
      : { outcome: 'dropped', error: `канал ${delivery.channel} не настроен` };

    if (result.outcome === 'ok') {
      await this.prisma.delivery.update({
        where: { id: delivery.id },
        data: { status: DeliveryStatus.SENT, sentAt: new Date(), lastError: null },
      });
      return;
    }

    if (result.outcome === 'dropped') {
      await this.prisma.delivery.update({
        where: { id: delivery.id },
        data: { status: DeliveryStatus.DROPPED, lastError: result.error },
      });
      this.logger.debug({
        message: 'доставка отброшена',
        channel: delivery.channel,
        notificationId: notification.id,
        reason: result.error,
      });
      return;
    }

    const nextDelay = RETRY_DELAYS_MS[delivery.attempts - 1];
    const exhausted = delivery.attempts >= this.config.maxDeliveryAttempts || nextDelay === undefined;

    await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: exhausted
        ? { status: DeliveryStatus.FAILED, lastError: result.error }
        : {
            status: DeliveryStatus.PENDING,
            scheduledFor: new Date(Date.now() + nextDelay),
            lastError: result.error,
          },
    });

    if (exhausted) {
      // Аналог DLQ для доставки: дальше — руками. Логируется на error,
      // чтобы не потерялось среди отладочных сообщений.
      this.logger.error({
        message: 'доставка не удалась окончательно',
        channel: delivery.channel,
        target: delivery.target,
        notificationId: notification.id,
        attempts: delivery.attempts,
        error: result.error,
      });
    } else {
      this.logger.warn({
        message: 'доставка отложена до повтора',
        channel: delivery.channel,
        notificationId: notification.id,
        attempt: delivery.attempts,
        retryInMs: nextDelay,
        error: result.error,
      });
    }
  }

  private senderFor(channel: Channel): ChannelSender | null {
    if (channel === Channel.EMAIL) return this.email.available ? this.email : null;
    if (channel === Channel.WEB_PUSH) return this.push.available ? this.push : null;
    // IN_APP строкой доставки не бывает: у него нет транспорта,
    // и само уведомление в базе уже и есть доставленное сообщение.
    return null;
  }

  /** Относительный путь интерфейса в абсолютный: письмо открывают вне SPA. */
  private absoluteUrl(link: string | null): string | undefined {
    if (!link) return undefined;
    if (/^https?:\/\//i.test(link)) return link;
    return `${this.config.publicBaseUrl}${link.startsWith('/') ? '' : '/'}${link}`;
  }
}
