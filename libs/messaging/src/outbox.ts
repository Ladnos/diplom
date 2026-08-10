import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, Optional } from '@nestjs/common';
import { Envelope } from '@crm/contracts';
import { EventPublisher } from './event-publisher';
import { OUTBOX_STORE } from './tokens';
import { OutboxStore } from './idempotency';

/**
 * Воркер транзакционного outbox. docs/architecture.md §7.7
 *
 * Доменный код НЕ публикует события напрямую: он пишет их в таблицу outbox
 * в одной транзакции с изменением данных. Этот воркер забирает записи и
 * отправляет в брокер.
 *
 * Зачем так. Прямой publish() после COMMIT оставляет окно: процесс упал
 * между коммитом и отправкой — данные изменились, а мир об этом не узнал,
 * и recovery невозможен, потому что событие нигде не сохранилось. Outbox
 * переносит это окно внутрь транзакции, где атомарность гарантирует БД.
 *
 * Цена — доставка становится at-least-once: воркер может успеть отправить
 * и упасть до markSent, тогда событие уйдёт повторно. Именно поэтому
 * потребители обязаны быть идемпотентны (ProcessedEventStore).
 */
@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(
    @Optional() @Inject(OUTBOX_STORE) private readonly store: OutboxStore | undefined,
    private readonly publisher: EventPublisher,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.store) {
      this.logger.warn({
        message: 'OUTBOX_STORE не зарегистрирован, воркер не запущен',
      });
      return;
    }
    this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    // Дать текущему проходу завершиться, чтобы не оборвать публикацию
    // на середине пачки и не оставить события без markSent.
    for (let i = 0; i < 50 && this.running; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private schedule(delayMs = OutboxWorker.POLL_INTERVAL_MS): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    // unref: незавершённый таймер не должен держать процесс при выходе
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped || !this.store) return;
    this.running = true;
    let publishedCount = 0;

    try {
      const pending = await this.store.pullUnsent(OutboxWorker.BATCH_SIZE);
      if (pending.length > 0) {
        const sent: string[] = [];
        for (const envelope of pending) {
          try {
            this.publisher.publishEnvelope(envelope);
            sent.push(envelope.eventId);
          } catch (error) {
            // Одно плохое событие не должно блокировать пачку:
            // остальные уйдут, а это попадёт в следующий проход.
            this.logger.error({
              message: 'не удалось опубликовать событие из outbox',
              eventId: envelope.eventId,
              eventType: envelope.eventType,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (sent.length > 0) {
          await this.store.markSent(sent);
          publishedCount = sent.length;
          this.logger.debug({ message: 'outbox опубликован', count: publishedCount });
        }
      }
    } catch (error) {
      this.logger.error({
        message: 'ошибка прохода outbox',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
      // Пачка оказалась полной — вероятно, есть ещё; идём сразу.
      this.schedule(
        publishedCount >= OutboxWorker.BATCH_SIZE ? 0 : OutboxWorker.POLL_INTERVAL_MS,
      );
    }
  }

  /** Интервал опроса. Задержка публикации события — до этого значения. */
  static readonly POLL_INTERVAL_MS = 1000;
  static readonly BATCH_SIZE = 100;
}

/**
 * Строка outbox в том виде, в каком её хранит Prisma.
 * Общая для всех сервисов: схема таблицы одинакова везде.
 */
export interface OutboxRow {
  eventId: string;
  eventType: string;
  eventVersion: number;
  payload: unknown;
  correlationId: string;
  causationId: string | null;
  actorUserId: string | null;
  actorEmployeeId: string | null;
  occurredAt: Date;
}

/** Преобразование строки таблицы в конверт для публикации. */
export function rowToEnvelope(row: OutboxRow, producer: string): Envelope {
  return {
    eventId: row.eventId,
    eventType: row.eventType as Envelope['eventType'],
    eventVersion: row.eventVersion,
    occurredAt: row.occurredAt.toISOString(),
    producer,
    correlationId: row.correlationId,
    causationId: row.causationId ?? undefined,
    actor: row.actorUserId
      ? { userId: row.actorUserId, employeeId: row.actorEmployeeId ?? undefined }
      : undefined,
    payload: row.payload,
  };
}
