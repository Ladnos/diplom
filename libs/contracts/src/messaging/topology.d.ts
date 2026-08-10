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
export declare const Exchanges: {
    /** Доменные события в прошедшем времени. Издатель не знает подписчиков. */
    readonly EVENTS: "crm.events";
    /** Асинхронные команды конкретному сервису. */
    readonly COMMANDS: "crm.commands";
    /** Повторная доставка с задержкой (плагин x-delayed-message). */
    readonly RETRY: "crm.retry";
    /** Dead letter exchange для неразобранных сообщений. */
    readonly DLX: "crm.dlx";
};
export type ExchangeName = (typeof Exchanges)[keyof typeof Exchanges];
export interface ExchangeDefinition {
    name: ExchangeName;
    type: 'topic' | 'direct' | 'fanout' | 'x-delayed-message';
    options: Record<string, unknown>;
}
export declare const EXCHANGE_DEFINITIONS: ExchangeDefinition[];
/** Задержки повторов: 5 с → 30 с → 5 мин, затем окончательно в DLQ (§7.7). */
export declare const RETRY_DELAYS_MS: readonly [5000, 30000, 300000];
export declare const MAX_RETRY_ATTEMPTS: 3;
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
export declare const QUEUE_DEFINITIONS: QueueDefinition[];
/** Определение очереди по имени сервиса-потребителя. */
export declare function queueForService(serviceName: string): QueueDefinition | undefined;
/** Имя DLQ для очереди: неразобранное уходит в <queue>.dlq. */
export declare function dlqName(queue: string): string;
/** Аргументы очереди, отправляющие отказы в DLX. */
export declare function withDeadLetter(queue: string): Record<string, unknown>;
//# sourceMappingURL=topology.d.ts.map