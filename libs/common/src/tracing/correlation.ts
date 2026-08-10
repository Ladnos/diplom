import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import type { Actor, RequestContext } from '@crm/contracts';

/**
 * Сквозная трассировка. docs/architecture.md §6.4, §7.6
 *
 * correlationId рождается на api-gateway и дальше передаётся через gRPC
 * metadata и конверты событий. Благодаря AsyncLocalStorage его не нужно
 * протаскивать параметром через каждый слой: обработчик события,
 * запущенный через три await, всё равно видит контекст своего запроса.
 */

export const CORRELATION_HEADER = 'x-correlation-id';
export const CAUSATION_HEADER = 'x-causation-id';

const storage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext {
  return storage.getStore() ?? { correlationId: randomUUID() };
}

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function newCorrelationId(): string {
  return randomUUID();
}

@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const requestContext = this.extract(context);
    return new Observable((subscriber) => {
      const subscription = runWithContext(requestContext, () =>
        next.handle().subscribe(subscriber),
      );
      return () => subscription.unsubscribe();
    });
  }

  private extract(context: ExecutionContext): RequestContext {
    switch (context.getType<'http' | 'rpc'>()) {
      case 'http': {
        const request = context.switchToHttp().getRequest<{
          headers: Record<string, string | undefined>;
          user?: Actor;
        }>();
        return {
          correlationId: request.headers[CORRELATION_HEADER] ?? newCorrelationId(),
          causationId: request.headers[CAUSATION_HEADER],
          actor: request.user,
        };
      }
      case 'rpc': {
        // Для gRPC метаданные лежат во втором аргументе, для RMQ —
        // correlationId уже внутри конверта события.
        const metadata = context.switchToRpc().getContext<{
          get?: (key: string) => unknown[];
        }>();
        const fromMetadata = metadata?.get?.(CORRELATION_HEADER)?.[0];
        return {
          correlationId:
            typeof fromMetadata === 'string' ? fromMetadata : newCorrelationId(),
        };
      }
      default:
        return { correlationId: newCorrelationId() };
    }
  }
}
