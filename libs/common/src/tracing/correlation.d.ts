import { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { RequestContext } from '@crm/contracts';
/**
 * Сквозная трассировка. docs/architecture.md §6.4, §7.6
 *
 * correlationId рождается на api-gateway и дальше передаётся через gRPC
 * metadata и конверты событий. Благодаря AsyncLocalStorage его не нужно
 * протаскивать параметром через каждый слой: обработчик события,
 * запущенный через три await, всё равно видит контекст своего запроса.
 */
export declare const CORRELATION_HEADER = "x-correlation-id";
export declare const CAUSATION_HEADER = "x-causation-id";
export declare function getRequestContext(): RequestContext;
export declare function runWithContext<T>(context: RequestContext, fn: () => T): T;
export declare function newCorrelationId(): string;
export declare class CorrelationInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown>;
    private extract;
}
//# sourceMappingURL=correlation.d.ts.map