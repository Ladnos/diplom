import { Injectable } from '@nestjs/common';
import type { Envelope } from '@crm/contracts';
import { rowToEnvelope, type OutboxStore } from '@crm/messaging';
import { PrismaService } from './prisma.service';

/**
 * Поля строки outbox из конверта.
 *
 * Вынесено отдельной функцией, потому что доменный код записывает событие
 * ВНУТРИ своей транзакции — через tx.outbox.create(), а не через сервис:
 *
 *   await this.prisma.$transaction(async (tx) => {
 *     const user = await tx.user.create({ ... });
 *     await tx.outbox.create({ data: outboxRow(envelope) });
 *   });
 *
 * Только так изменение данных и факт события становятся атомарными
 * (docs/architecture.md §7.7).
 */
export function outboxRow(envelope: Envelope) {
  return {
    eventId: envelope.eventId,
    eventType: envelope.eventType,
    eventVersion: envelope.eventVersion,
    payload: envelope.payload as object,
    correlationId: envelope.correlationId,
    causationId: envelope.causationId ?? null,
    actorUserId: envelope.actor?.userId ?? null,
    actorEmployeeId: envelope.actor?.employeeId ?? null,
    occurredAt: new Date(envelope.occurredAt),
  };
}

/** Хранилище outbox поверх таблицы outbox базы сервиса. */
@Injectable()
export class PrismaOutboxStore implements OutboxStore {
  constructor(private readonly prisma: PrismaService) {}

  /** Публикация вне транзакции. Для событий без изменения данных. */
  async enqueue(envelope: Envelope): Promise<void> {
    await this.prisma.outbox.create({ data: outboxRow(envelope) });
  }

  async pullUnsent(limit: number): Promise<Envelope[]> {
    const rows = await this.prisma.outbox.findMany({
      where: { sentAt: null },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    const producer = process.env.SERVICE_NAME ?? 'unknown';
    return rows.map((row) => rowToEnvelope(row, producer));
  }

  async markSent(eventIds: string[]): Promise<void> {
    await this.prisma.outbox.updateMany({
      where: { eventId: { in: eventIds } },
      data: { sentAt: new Date() },
    });
  }
}
