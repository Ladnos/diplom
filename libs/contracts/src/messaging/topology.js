"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.QUEUE_DEFINITIONS = exports.MAX_RETRY_ATTEMPTS = exports.RETRY_DELAYS_MS = exports.EXCHANGE_DEFINITIONS = exports.Exchanges = void 0;
exports.queueForService = queueForService;
exports.dlqName = dlqName;
exports.withDeadLetter = withDeadLetter;
exports.Exchanges = {
    /** Доменные события в прошедшем времени. Издатель не знает подписчиков. */
    EVENTS: 'crm.events',
    /** Асинхронные команды конкретному сервису. */
    COMMANDS: 'crm.commands',
    /** Повторная доставка с задержкой (плагин x-delayed-message). */
    RETRY: 'crm.retry',
    /** Dead letter exchange для неразобранных сообщений. */
    DLX: 'crm.dlx',
};
exports.EXCHANGE_DEFINITIONS = [
    { name: exports.Exchanges.EVENTS, type: 'topic', options: { durable: true } },
    { name: exports.Exchanges.COMMANDS, type: 'topic', options: { durable: true } },
    { name: exports.Exchanges.DLX, type: 'topic', options: { durable: true } },
    {
        name: exports.Exchanges.RETRY,
        type: 'x-delayed-message',
        options: { durable: true, arguments: { 'x-delayed-type': 'topic' } },
    },
];
/** Задержки повторов: 5 с → 30 с → 5 мин, затем окончательно в DLQ (§7.7). */
exports.RETRY_DELAYS_MS = [5_000, 30_000, 300_000];
exports.MAX_RETRY_ATTEMPTS = exports.RETRY_DELAYS_MS.length;
exports.QUEUE_DEFINITIONS = [
    {
        // Единственная очередь на инстанс: событие должно дойти до КАЖДОГО
        // gateway, потому что WS-соединения клиентов распределены между ними.
        name: 'gateway.realtime',
        consumer: 'api-gateway',
        prefetch: 100,
        perInstance: true,
        options: { autoDelete: true, exclusive: true, durable: false },
        bindings: [
            {
                exchange: exports.Exchanges.EVENTS,
                patterns: ['task.#', 'chat.#', 'video.#', 'approval.#', 'hr.timesheet.#'],
            },
        ],
    },
    {
        name: 'auth.events',
        consumer: 'auth-service',
        prefetch: 10,
        bindings: [
            {
                exchange: exports.Exchanges.EVENTS,
                patterns: ['hr.hierarchy.changed', 'hr.employee.deactivated', 'approval.delegation.set'],
            },
        ],
    },
    {
        name: 'hr.events',
        consumer: 'hr-service',
        prefetch: 10,
        bindings: [
            {
                exchange: exports.Exchanges.EVENTS,
                patterns: ['auth.user.registered', 'approval.request.approved'],
            },
            { exchange: exports.Exchanges.COMMANDS, patterns: ['timesheet.recalculate'] },
        ],
    },
    {
        name: 'approval.events',
        consumer: 'approval-service',
        prefetch: 10,
        bindings: [
            {
                exchange: exports.Exchanges.EVENTS,
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
            { exchange: exports.Exchanges.EVENTS, patterns: ['hr.employee.#', 'hr.absence.registered'] },
        ],
    },
    {
        name: 'chat.events',
        consumer: 'chat-service',
        prefetch: 20,
        bindings: [
            {
                exchange: exports.Exchanges.EVENTS,
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
            { exchange: exports.Exchanges.EVENTS, patterns: ['hr.employee.#'] },
        ],
    },
    {
        name: 'file.events',
        consumer: 'file-service',
        prefetch: 10,
        bindings: [
            {
                exchange: exports.Exchanges.EVENTS,
                patterns: ['task.card.deleted', 'chat.message.deleted', 'video.recording.ready'],
            },
            { exchange: exports.Exchanges.COMMANDS, patterns: ['media.process', 'file.gc.run'] },
        ],
    },
    {
        name: 'notification.events',
        consumer: 'notification-service',
        prefetch: 20,
        bindings: [
            {
                exchange: exports.Exchanges.EVENTS,
                patterns: ['auth.#', 'hr.#', 'approval.#', 'task.#', 'chat.#', 'video.#', 'file.#'],
            },
            {
                exchange: exports.Exchanges.COMMANDS,
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
            { exchange: exports.Exchanges.EVENTS, patterns: ['#'] },
            { exchange: exports.Exchanges.COMMANDS, patterns: ['report.generate'] },
        ],
    },
    // Очередь attendance.events ЗАРЕЗЕРВИРОВАНА под будущий сервис
    // фактического учёта (§3.4) и сейчас не объявляется.
];
/** Определение очереди по имени сервиса-потребителя. */
function queueForService(serviceName) {
    return exports.QUEUE_DEFINITIONS.find((q) => q.consumer === serviceName);
}
/** Имя DLQ для очереди: неразобранное уходит в <queue>.dlq. */
function dlqName(queue) {
    return `${queue}.dlq`;
}
/** Аргументы очереди, отправляющие отказы в DLX. */
function withDeadLetter(queue) {
    return {
        'x-dead-letter-exchange': exports.Exchanges.DLX,
        'x-dead-letter-routing-key': dlqName(queue),
    };
}
//# sourceMappingURL=topology.js.map