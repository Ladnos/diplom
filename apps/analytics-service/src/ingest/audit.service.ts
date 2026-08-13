import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { Envelope } from '@crm/contracts';
import { Prisma } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Журнал аудита.
 *
 * Не отдельный механизм записи действий, а побочный продукт событийной
 * архитектуры: сервис подписан на всю шину, и всё, что кто-то сделал,
 * уже описано событием. Ни один сервис не может «забыть записать в
 * аудит» — забыть можно только опубликовать событие, но тогда о действии
 * не узнают и остальные подписчики, что заметно сразу.
 *
 * Отсюда же и его полнота: в журнале лежит то же, что получили
 * потребители, а не пересказ.
 */
@Injectable()
export class AuditService implements OnApplicationBootstrap, OnApplicationShutdown {
  private static readonly CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

  private readonly logger = new Logger(AuditService.name);
  private readonly retentionDays: number;
  private cleanup?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {
    const configured = Number(process.env.ANALYTICS_AUDIT_RETENTION_DAYS);
    this.retentionDays = Number.isFinite(configured) && configured > 0 ? configured : 365;
  }

  onApplicationBootstrap(): void {
    this.cleanup = setInterval(() => void this.prune(), AuditService.CLEANUP_INTERVAL_MS);
    this.cleanup.unref();
  }

  onApplicationShutdown(): void {
    if (this.cleanup) clearInterval(this.cleanup);
  }

  /**
   * Запись события.
   *
   * Идентификатором строки служит eventId, а не собственный ключ: при
   * повторной доставке вставка упирается в первичный ключ, и журнал не
   * задваивается даже если отметка об обработке не успела записаться.
   */
  async record(envelope: Envelope): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          eventId: envelope.eventId,
          eventType: envelope.eventType,
          producer: envelope.producer,
          actorUserId: envelope.actor?.userId ?? null,
          actorEmployeeId: envelope.actor?.employeeId ?? null,
          correlationId: envelope.correlationId,
          causationId: envelope.causationId ?? null,
          payload: (envelope.payload ?? {}) as Prisma.InputJsonValue,
          occurredAt: new Date(envelope.occurredAt),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return;
      throw error;
    }
  }

  /**
   * Удаление устаревших записей.
   *
   * Журнал растёт со скоростью всей шины и без срока хранения однажды
   * займёт больше, чем все доменные базы вместе. Год выбран как срок, за
   * который ещё разбирают инциденты; витрины при этом не страдают — они
   * материализованы отдельно и живут независимо от журнала.
   */
  async prune(): Promise<number> {
    const deadline = new Date(Date.now() - this.retentionDays * DAY_MS);
    const removed = await this.prisma.auditLog.deleteMany({
      where: { occurredAt: { lt: deadline } },
    });

    if (removed.count > 0) {
      this.logger.log({
        message: 'журнал аудита очищен',
        removed: removed.count,
        olderThan: deadline.toISOString().slice(0, 10),
      });
    }
    return removed.count;
  }

  /**
   * Постраничная выдача журнала.
   *
   * Курсор по времени, а не по смещению: журнал непрерывно пополняется, и
   * OFFSET после сотни новых событий показал бы часть предыдущей
   * страницы второй раз.
   */
  async page(input: {
    actorEmployeeId?: string;
    eventType?: string;
    from?: string;
    to?: string;
    limit: number;
    cursor?: string;
  }) {
    const limit = Math.min(Math.max(input.limit, 1), 200);
    const before = input.cursor ? new Date(Number(input.cursor)) : undefined;

    const entries = await this.prisma.auditLog.findMany({
      where: {
        ...(input.actorEmployeeId ? { actorEmployeeId: input.actorEmployeeId } : {}),
        // Префиксный поиск: «покажи всё по согласованиям» — это
        // approval.*, а не перечисление шести типов.
        ...(input.eventType ? { eventType: { startsWith: input.eventType } } : {}),
        occurredAt: {
          ...(input.from ? { gte: new Date(`${input.from}T00:00:00.000Z`) } : {}),
          ...(input.to ? { lte: new Date(`${input.to}T23:59:59.999Z`) } : {}),
          ...(before && !Number.isNaN(before.getTime()) ? { lt: before } : {}),
        },
      },
      orderBy: { occurredAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = entries.length > limit;
    const page = hasMore ? entries.slice(0, limit) : entries;
    return {
      entries: page,
      nextCursor: hasMore ? String(page[page.length - 1].occurredAt.getTime()) : '',
      hasMore,
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
