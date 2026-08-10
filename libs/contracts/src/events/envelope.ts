/**
 * Единый конверт для всех сообщений в RabbitMQ.
 * docs/architecture.md §7.6
 *
 * Конверт описан на TypeScript, а не в .proto, потому что сообщения в
 * RabbitMQ передаются как JSON: брокер, его management UI и DLQ должны
 * оставаться читаемыми человеком при разборе инцидентов.
 */

import type { EventType } from './routing-keys';

export interface Actor {
  userId: string;
  employeeId?: string;
}

export interface Envelope<TPayload = unknown> {
  /** UUID v7. Ключ дедупликации на стороне потребителя (§7.7). */
  eventId: string;

  /** Совпадает с routing key, по которому сообщение опубликовано. */
  eventType: EventType;

  /**
   * Версия схемы payload. При несовместимом изменении вводится новый
   * routing key `<type>.v2`, старый живёт до миграции всех потребителей.
   */
  eventVersion: number;

  /** ISO-8601 с миллисекундами. */
  occurredAt: string;

  /** Имя сервиса-издателя, например 'hr-service'. */
  producer: string;

  /** Сквозной идентификатор пользовательского запроса — склейка логов. */
  correlationId: string;

  /** eventId сообщения-причины. Восстанавливает дерево последствий. */
  causationId?: string;

  /** Кто инициировал действие. Пусто для системных событий. */
  actor?: Actor;

  payload: TPayload;
}

/** Конверт с ещё не проставленными полями транспорта — то, что отдаёт домен. */
export type EnvelopeDraft<TPayload> = Pick<Envelope<TPayload>, 'eventType' | 'payload'> &
  Partial<Pick<Envelope<TPayload>, 'eventVersion' | 'causationId' | 'actor'>>;

/** Контекст запроса, из которого EventPublisher берёт correlationId и actor. */
export interface RequestContext {
  correlationId: string;
  causationId?: string;
  actor?: Actor;
}

export const CURRENT_EVENT_VERSION = 1;

export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.eventId === 'string' &&
    typeof v.eventType === 'string' &&
    typeof v.occurredAt === 'string' &&
    typeof v.producer === 'string' &&
    'payload' in v
  );
}
