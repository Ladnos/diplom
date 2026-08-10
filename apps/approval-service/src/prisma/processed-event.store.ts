import { Injectable } from '@nestjs/common';
import type { ProcessedEventStore } from '@crm/messaging';
import { PrismaService } from './prisma.service';

/**
 * Реализация идемпотентности потребителя поверх таблицы processed_events.
 *
 * Живёт в сервисе, а не в библиотеке, намеренно: отметку «событие
 * обработано» нужно писать в ТОЙ ЖЕ транзакции, что и результат обработки.
 * Общая реализация с собственным подключением к БД такой гарантии дать
 * не может (см. libs/messaging/src/idempotency.ts).
 */
@Injectable()
export class PrismaProcessedEventStore implements ProcessedEventStore {
  constructor(private readonly prisma: PrismaService) {}

  async seen(eventId: string, consumer: string): Promise<boolean> {
    const found = await this.prisma.processedEvent.findUnique({
      where: { eventId_consumer: { eventId, consumer } },
      select: { eventId: true },
    });
    return found !== null;
  }

  async mark(eventId: string, consumer: string, eventType: string): Promise<void> {
    await this.prisma.processedEvent.create({
      data: { eventId, consumer, eventType },
    });
  }
}
