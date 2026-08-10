"use strict";
/**
 * Единый конверт для всех сообщений в RabbitMQ.
 * docs/architecture.md §7.6
 *
 * Конверт описан на TypeScript, а не в .proto, потому что сообщения в
 * RabbitMQ передаются как JSON: брокер, его management UI и DLQ должны
 * оставаться читаемыми человеком при разборе инцидентов.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CURRENT_EVENT_VERSION = void 0;
exports.isEnvelope = isEnvelope;
exports.CURRENT_EVENT_VERSION = 1;
function isEnvelope(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const v = value;
    return (typeof v.eventId === 'string' &&
        typeof v.eventType === 'string' &&
        typeof v.occurredAt === 'string' &&
        typeof v.producer === 'string' &&
        'payload' in v);
}
//# sourceMappingURL=envelope.js.map