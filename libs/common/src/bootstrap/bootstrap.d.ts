import { INestApplication } from '@nestjs/common';
import { ServiceDescriptor } from '@crm/contracts';
/**
 * Общий bootstrap сервиса.
 *
 * Каждый сервис — гибридное приложение: gRPC-сервер для входящих вызовов,
 * RabbitMQ-консьюмер для событий и HTTP под health/metrics (у api-gateway
 * HTTP — это ещё и публичный API с WebSocket).
 *
 * Вынесение сюда даёт две вещи: main.ts каждого сервиса умещается в десять
 * строк, и настройки транспортов (prefetch, DLX, loader) невозможно
 * случайно расстроить между сервисами.
 *
 * docs/architecture.md §6.1, §7.1
 */
export interface BootstrapOptions {
    /** Описание сервиса из реестра @crm/contracts. */
    service: ServiceDescriptor;
    /** Корневой модуль приложения. */
    module: unknown;
    /** Слушать HTTP на 0.0.0.0 — обязательно внутри контейнера. */
    httpHost?: string;
    /** Не подключать потребителя RabbitMQ, даже если очередь описана. */
    skipRmq?: boolean;
}
export declare function bootstrapService(options: BootstrapOptions): Promise<INestApplication>;
//# sourceMappingURL=bootstrap.d.ts.map