import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NOTIFICATION_CONFIG, type NotificationConfig } from '../config';

/**
 * Очистка истории.
 *
 * Сервису это нужнее, чем остальным: он подписан на весь поток системы,
 * и его таблицы растут со скоростью всей активности пользователей —
 * каждое сообщение чата оставляет строку уведомления с записью о push.
 * Без очистки база уведомлений однажды становится самой большой в
 * системе, а ценность годовалого «вам назначена смена» нулевая.
 *
 * Отдельного планировщика в системе нет (§7.4 упоминает его только как
 * отправителя команд), поэтому уборка идёт таймером внутри сервиса —
 * раз в час, с первым проходом через минуту после старта, чтобы не
 * конкурировать с наполнением очередей при развёртывании.
 */
@Injectable()
export class RetentionWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private static readonly INTERVAL_MS = 60 * 60 * 1000;
  private static readonly FIRST_RUN_DELAY_MS = 60 * 1000;

  private readonly logger = new Logger(RetentionWorker.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule(RetentionWorker.FIRST_RUN_DELAY_MS);
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;

    try {
      const notificationsBefore = daysAgo(this.config.notificationRetentionDays);
      const processedBefore = daysAgo(this.config.processedEventRetentionDays);

      // Строки доставки уходят каскадом вместе с уведомлением —
      // отдельного удаления не требуется.
      const notifications = await this.prisma.notification.deleteMany({
        where: { createdAt: { lt: notificationsBefore } },
      });

      // Отметки об обработанных событиях живут заметно меньше:
      // повторная доставка из RabbitMQ приходит в пределах минут, а не
      // недель, и хранить их дольше — просто занимать место.
      const processed = await this.prisma.processedEvent.deleteMany({
        where: { processedAt: { lt: processedBefore } },
      });

      if (notifications.count > 0 || processed.count > 0) {
        this.logger.log({
          message: 'история очищена',
          notifications: notifications.count,
          processedEvents: processed.count,
        });
      }
    } catch (error) {
      this.logger.error({
        message: 'ошибка очистки истории',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.schedule(RetentionWorker.INTERVAL_MS);
    }
  }
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
