"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CorrelationInterceptor = exports.CAUSATION_HEADER = exports.CORRELATION_HEADER = void 0;
exports.getRequestContext = getRequestContext;
exports.runWithContext = runWithContext;
exports.newCorrelationId = newCorrelationId;
const node_async_hooks_1 = require("node:async_hooks");
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const rxjs_1 = require("rxjs");
/**
 * Сквозная трассировка. docs/architecture.md §6.4, §7.6
 *
 * correlationId рождается на api-gateway и дальше передаётся через gRPC
 * metadata и конверты событий. Благодаря AsyncLocalStorage его не нужно
 * протаскивать параметром через каждый слой: обработчик события,
 * запущенный через три await, всё равно видит контекст своего запроса.
 */
exports.CORRELATION_HEADER = 'x-correlation-id';
exports.CAUSATION_HEADER = 'x-causation-id';
const storage = new node_async_hooks_1.AsyncLocalStorage();
function getRequestContext() {
    return storage.getStore() ?? { correlationId: (0, node_crypto_1.randomUUID)() };
}
function runWithContext(context, fn) {
    return storage.run(context, fn);
}
function newCorrelationId() {
    return (0, node_crypto_1.randomUUID)();
}
let CorrelationInterceptor = class CorrelationInterceptor {
    intercept(context, next) {
        const requestContext = this.extract(context);
        return new rxjs_1.Observable((subscriber) => {
            const subscription = runWithContext(requestContext, () => next.handle().subscribe(subscriber));
            return () => subscription.unsubscribe();
        });
    }
    extract(context) {
        switch (context.getType()) {
            case 'http': {
                const request = context.switchToHttp().getRequest();
                return {
                    correlationId: request.headers[exports.CORRELATION_HEADER] ?? newCorrelationId(),
                    causationId: request.headers[exports.CAUSATION_HEADER],
                    actor: request.user,
                };
            }
            case 'rpc': {
                // Для gRPC метаданные лежат во втором аргументе, для RMQ —
                // correlationId уже внутри конверта события.
                const metadata = context.switchToRpc().getContext();
                const fromMetadata = metadata?.get?.(exports.CORRELATION_HEADER)?.[0];
                return {
                    correlationId: typeof fromMetadata === 'string' ? fromMetadata : newCorrelationId(),
                };
            }
            default:
                return { correlationId: newCorrelationId() };
        }
    }
};
exports.CorrelationInterceptor = CorrelationInterceptor;
exports.CorrelationInterceptor = CorrelationInterceptor = __decorate([
    (0, common_1.Injectable)()
], CorrelationInterceptor);
//# sourceMappingURL=correlation.js.map