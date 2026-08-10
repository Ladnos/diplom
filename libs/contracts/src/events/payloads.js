"use strict";
/**
 * Payload доменных событий. docs/architecture.md §7.3
 *
 * Карта EventPayloadMap внизу файла связывает routing key с типом payload,
 * благодаря чему publish() и @EventPattern получают проверку типов:
 * опечатка в имени события или несоответствие payload ломают сборку,
 * а не продакшен.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const routing_keys_1 = require("./routing-keys");
//# sourceMappingURL=payloads.js.map