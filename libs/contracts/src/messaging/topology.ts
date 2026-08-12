/**
 * Топология RabbitMQ как данные. docs/architecture.md §7.1, §7.5
 *
 * Объявляется декларативно и применяется каждым сервисом при старте через
 * @crm/common → assertTopology(). Так топология живёт в репозитории рядом
 * с кодом, а не в ручных настройках брокера, и воспроизводится на любом
 * стенде одной командой.
 *
 * ОДНА ВХОДЯЩАЯ ОЧЕРЕДЬ НА СЕРВИС. Сервис держит одно AMQP-подключение,
 * поэтому события и команды приходят в общую очередь, привязанную к двум
 * обменникам с разными паттернами. Разделение на `<svc>.events` и
 * `<svc>.commands` потребовало бы второго подключения и второго набора
 * обработчиков — сложность без выигрыша при текущих объёмах.
 */

export const Exchanges = {
  /** Доменные события в прошедшем времени. Издатель не знает подписчиков. */
  EVENTS: 'crm.events',
  /** Асинхронные команды конкретному сервису. */
  COMMANDS: 'crm.commands',
  /** Повторная доставка с задержкой (плагин x-delayed-message). */
  RETRY: 'crm.retry',
  /** Dead letter exchange для неразобранных сообщений. */
  DLX: 'crm.dlx',
} as const;

export type ExchangeName = (typeof Exchanges)[keyof typeof Exchanges];

export interface ExchangeDefinition {
  name: ExchangeName;
  type: 'topic' | 'direct' | 'fanout' | 'x-delayed-message';
  options: Record<string, unknown>;
}

export const EXCHANGE_DEFINITIONS: ExchangeDefinition[] = [
  { name: Exchanges.EVENTS, type: 'topic', options: { durable: true } },
  { name: Exchanges.COMMANDS, type: 'topic', options: { durable: true } },
  { name: Exchanges.DLX, type: 'topic', options: { durable: true } },
  {
    name: Exchanges.RETRY,
    type: 'x-delayed-message',
    options: { durable: true, arguments: { 'x-delayed-type': 'topic' } },
  },
];

/** Задержки повторов: 5 с → 30 с → 5 мин, затем окончательно в DLQ (§7.7). */
export const RETRY_DELAYS_MS = [5_000, 30_000, 300_000] as const;
export const MAX_RETRY_ATTEMPTS = RETRY_DELAYS_MS.length;

export interface QueueBinding {
  exchange: ExchangeName;
  patterns: string[];
}

export interface QueueDefinition {
  name: string;
  consumer: string;
  bindings: QueueBinding[];
  prefetch: number;
  options?: Record<string, unknown>;
  /**
   * Очередь объявляется отдельно на КАЖДЫЙ инстанс сервиса.
   * Нужно там, где сообщение должно прийти всем инстансам, а не одному
   * из пула, — иначе WS-обновление получит лишь часть клиентов (§8.1).
   */
  perInstance?: boolean;
}

export const QUEUE_DEFINITIONS: QueueDefinition[] = [
  {
    // Единственная очередь на инстанс: событие должно дойти до КАЖДОГО
    // gateway, потому что WS-соединения клиентов распределены между ними.
    name: 'gateway.realtime',
    consumer: 'api-gateway',
    prefetch: 100,
    perInstance: true,
    // autoDelete — очередь исчезает, когда отписался последний потребитель,
    // то есть когда инстанс gateway остановлен. durable не нужен: realtime-
    // обновления не имеют смысла после перезапуска, клиент дочитает
    // состояние обычным запросом.
    //
    // exclusive здесь использовать НЕЛЬЗЯ: такая очередь привязана к
    // объявившему её подключению и удаляется вместе с ним, а объявление
    // идёт отдельным коротким подключением assertTopology. Потребитель
    // подключился бы уже к несуществующей очереди.
    options: { autoDelete: true, durable: false },
    bindings: [
      {
        exchange: Exchanges.EVENTS,
        patterns: [
          'task.#',
          'chat.#',
          'video.#',
          'approval.#',
          'hr.timesheet.#',
          // Не 'notification.#': из всего контекста уведомлений в живое
          // окно идёт только появление записи в ленте. Отметки о
          // прочтении и результаты отправки писем клиенту не нужны, а
          // широкий паттерн затянул бы их вместе с будущими событиями.
          'notification.created',
        ],
      },
    ],
  },
  {
    name: 'auth.events',
    consumer: 'auth-service',
    prefetch: 10,
    bindings: [
      {
        exchange: Exchanges.EVENTS,
        patterns: [
          // hr.employee.# — не только deactivated: по hr.employee.created
          // auth связывает учётную запись с сотрудником (проставляет
          // employeeId), а по updated поддерживает проекцию отдела.
          // Без created пользователь навсегда остаётся без положения в
          // оргструктуре, и все проверки со scope, кроме GLOBAL, для него
          // не проходят.
          'hr.employee.#',
          'hr.hierarchy.changed',
          'approval.delegation.set',
        ],
      },
    ],
  },
  {
    name: 'hr.events',
    consumer: 'hr-service',
    prefetch: 10,
    bindings: [
      {
        exchange: Exchanges.EVENTS,
        patterns: ['auth.user.registered', 'approval.request.approved'],
      },
      { exchange: Exchanges.COMMANDS, patterns: ['timesheet.recalculate'] },
    ],
  },
  {
    name: 'approval.events',
    consumer: 'approval-service',
    prefetch: 10,
    bindings: [
      {
        exchange: Exchanges.EVENTS,
        patterns: [
          // Подтверждающие события саги согласования (§10.3)
          'hr.absence.registered',
          'hr.absence.registration_failed',
          'hr.timesheet.#',
          // Пересчёт маршрутов и применимости типов заявок
          'hr.hierarchy.changed',
          'hr.employment.changed',
          'hr.employee.deactivated',
        ],
      },
    ],
  },
  {
    name: 'task.events',
    consumer: 'task-service',
    prefetch: 10,
    bindings: [
      { exchange: Exchanges.EVENTS, patterns: ['hr.employee.#', 'hr.absence.registered'] },
    ],
  },
  {
    name: 'chat.events',
    consumer: 'chat-service',
    prefetch: 20,
    bindings: [
      {
        exchange: Exchanges.EVENTS,
        patterns: ['hr.employee.#', 'video.call.ended', 'task.card.assigned'],
      },
    ],
  },
  {
    name: 'video.events',
    consumer: 'video-service',
    prefetch: 10,
    bindings: [
      // Денормализованные копии ФИО и аватаров участников звонка (§7.3)
      { exchange: Exchanges.EVENTS, patterns: ['hr.employee.#'] },
    ],
  },
  {
    name: 'file.events',
    consumer: 'file-service',
    prefetch: 10,
    bindings: [
      {
        exchange: Exchanges.EVENTS,
        patterns: ['task.card.deleted', 'chat.message.deleted', 'video.recording.ready'],
      },
      { exchange: Exchanges.COMMANDS, patterns: ['media.process', 'file.gc.run'] },
    ],
  },
  {
    name: 'notification.events',
    consumer: 'notification-service',
    prefetch: 20,
    bindings: [
      {
        exchange: Exchanges.EVENTS,
        patterns: ['auth.#', 'hr.#', 'approval.#', 'task.#', 'chat.#', 'video.#', 'file.#'],
      },
      {
        exchange: Exchanges.COMMANDS,
        patterns: ['notification.send', 'notification.broadcast'],
      },
    ],
  },
  {
    // Одна очередь на аналитику и аудит: обе строятся из полного потока
    // событий, а два binding'а с '#' на один процесс означали бы просто
    // двойную доставку одного и того же сообщения.
    name: 'analytics.events',
    consumer: 'analytics-service',
    prefetch: 50,
    bindings: [
      { exchange: Exchanges.EVENTS, patterns: ['#'] },
      { exchange: Exchanges.COMMANDS, patterns: ['report.generate'] },
    ],
  },
  // Очередь attendance.events ЗАРЕЗЕРВИРОВАНА под будущий сервис
  // фактического учёта (§3.4) и сейчас не объявляется.
];

/** Определение очереди по имени сервиса-потребителя. */
export function queueForService(serviceName: string): QueueDefinition | undefined {
  return QUEUE_DEFINITIONS.find((q) => q.consumer === serviceName);
}

/** Имя DLQ для очереди: неразобранное уходит в <queue>.dlq. */
export function dlqName(queue: string): string {
  return `${queue}.dlq`;
}

/** Аргументы очереди, отправляющие отказы в DLX. */
export function withDeadLetter(queue: string): Record<string, unknown> {
  return {
    'x-dead-letter-exchange': Exchanges.DLX,
    'x-dead-letter-routing-key': dlqName(queue),
  };
}
