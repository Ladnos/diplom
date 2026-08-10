"use strict";
/**
 * @crm/contracts — единый источник истины по межсервисным интерфейсам.
 *
 * Содержит:
 *   • proto/          — gRPC-контракты (загружаются в рантайме)
 *   • events/         — конверт, каталог routing key и типы payload
 *   • messaging/      — декларативная топология RabbitMQ
 *   • services/       — реестр сервисов: порты, proto-пакеты, базы
 *
 * Именно ради этого пакета выбран монорепозиторий: контракты обязаны быть
 * едиными для всех сервисов, а при отдельных репозиториях потребовался бы
 * приватный npm-registry (docs/architecture.md §11.3).
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./proto-path"), exports);
__exportStar(require("./events/envelope"), exports);
__exportStar(require("./events/routing-keys"), exports);
__exportStar(require("./events/payloads"), exports);
__exportStar(require("./messaging/topology"), exports);
__exportStar(require("./services/registry"), exports);
//# sourceMappingURL=index.js.map