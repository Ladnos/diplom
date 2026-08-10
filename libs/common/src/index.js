"use strict";
/**
 * @crm/common — инфраструктурный код, одинаковый для всех сервисов:
 * конфигурация, логирование, health-проверки, трассировка, объявление
 * топологии RabbitMQ и bootstrap.
 *
 * Доменной логики здесь нет и быть не должно: всё, что появляется в этой
 * библиотеке, автоматически становится зависимостью всех десяти сервисов.
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
__exportStar(require("./config/env"), exports);
__exportStar(require("./logging/logger"), exports);
__exportStar(require("./health/health.module"), exports);
__exportStar(require("./tracing/correlation"), exports);
__exportStar(require("./messaging/assert-topology"), exports);
__exportStar(require("./bootstrap/bootstrap"), exports);
//# sourceMappingURL=index.js.map