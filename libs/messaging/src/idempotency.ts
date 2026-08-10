import { Envelope } from '@crm/contracts';

/**
 * Идемпотентность потребителя. docs/architecture.md §7.7
 *
 * RabbitMQ гарантирует at-least-once: одно и то же сообщение может прийти
 * дважды при переподключении консьюмера или повторе после nack. Для
 * начисления переработки или списания квоты повтор — это ошибка в данных,
 * поэтому потребитель обязан отбрасывать уже обработанные eventId.
 *
 * Реализация принадлежит сервису, а не библиотеке: запись о том, что
 * событие обработано, должна лежать в ТОЙ ЖЕ транзакции, что и результат
 * обработки, иначе между ними остаётся окно для повторного применения.
 * Отсюда интерфейс здесь и Prisma-реализация в каждом сервисе.
 */
export interface ProcessedEventStore {
  /** Уже обрабатывали это событие? */
  seen(eventId: string, consumer: string): Promise<boolean>;

  /** Отметить обработанным. Вызывать в транзакции вместе с результатом. */
  mark(eventId: string, consumer: string, eventType: string): Promise<void>;
}

/**
 * Транзакционный outbox. docs/architecture.md §7.7
 *
 * Событие пишется в таблицу outbox в одной транзакции с изменением данных,
 * а отдельный воркер публикует его в брокер и помечает отправленным. Без
 * этого падение процесса между COMMIT и publish() теряет событие
 * безвозвратно: данные изменились, а мир об этом не узнал.
 */
export interface OutboxStore {
  /** Сохранить событие для последующей публикации. */
  enqueue(envelope: Envelope): Promise<void>;

  /** Забрать неотправленные для публикации. */
  pullUnsent(limit: number): Promise<Envelope[]>;

  /** Отметить успешно опубликованным. */
  markSent(eventIds: string[]): Promise<void>;
}

/**
 * Заглушка на память — только для локального запуска и тестов.
 * Не использовать в продакшене: при перезапуске процесса дедупликация
 * обнуляется, и события применятся повторно.
 */
export class InMemoryProcessedEventStore implements ProcessedEventStore {
  private readonly seenKeys = new Set<string>();

  async seen(eventId: string, consumer: string): Promise<boolean> {
    return this.seenKeys.has(`${consumer}:${eventId}`);
  }

  async mark(eventId: string, consumer: string): Promise<void> {
    this.seenKeys.add(`${consumer}:${eventId}`);
  }
}
