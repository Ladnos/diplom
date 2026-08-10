/**
 * Health-проверки сервиса.
 *
 * Две независимые точки, потому что отвечают на разные вопросы:
 *   /health       — жив ли процесс (liveness). Никогда не ходит во внешние
 *                   системы: недоступная БД не повод убивать контейнер.
 *   /health/ready — готов ли принимать нагрузку (readiness). Проверяет
 *                   зависимости, поэтому используется оркестратором для
 *                   depends_on: service_healthy.
 *
 * Плюс gRPC Health Checking Protocol (docs/architecture.md §6.4) — им
 * пользуются межсервисные клиенты, а не Docker: в образе нет бинарника
 * grpc_health_probe, поэтому HEALTHCHECK в Dockerfile ходит по HTTP.
 */
export interface HealthCheckResult {
    name: string;
    healthy: boolean;
    detail?: string;
}
export interface HealthIndicator {
    readonly name: string;
    check(): Promise<HealthCheckResult>;
}
export declare const HEALTH_INDICATORS: unique symbol;
export declare class HealthService {
    private readonly indicators;
    constructor(indicators?: HealthIndicator[]);
    readiness(): Promise<{
        ready: boolean;
        checks: HealthCheckResult[];
    }>;
}
export declare class HealthController {
    private readonly health;
    constructor(health: HealthService);
    /** Liveness. Отвечает всегда, пока процесс способен обработать запрос. */
    live(): {
        status: string;
        service: string;
        uptimeSec: number;
    };
    /** Readiness. 200 — готов, 503 — зависимости недоступны. */
    ready(): Promise<{
        status: string;
        checks: HealthCheckResult[];
    }>;
}
/** Реализация стандартного grpc.health.v1.Health. */
export declare class GrpcHealthController {
    private readonly health;
    constructor(health: HealthService);
    check(): Promise<{
        status: string;
    }>;
}
export declare class HealthModule {
}
//# sourceMappingURL=health.module.d.ts.map