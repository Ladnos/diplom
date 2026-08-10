import { Controller, Get, Inject, Injectable, Module, Optional } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';

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

export const HEALTH_INDICATORS = Symbol('HEALTH_INDICATORS');

@Injectable()
export class HealthService {
  constructor(
    @Optional()
    @Inject(HEALTH_INDICATORS)
    private readonly indicators: HealthIndicator[] = [],
  ) {}

  async readiness(): Promise<{ ready: boolean; checks: HealthCheckResult[] }> {
    const checks = await Promise.all(
      (this.indicators ?? []).map(async (indicator) => {
        try {
          return await indicator.check();
        } catch (error) {
          return {
            name: indicator.name,
            healthy: false,
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    return { ready: checks.every((c) => c.healthy), checks };
  }
}

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness. Отвечает всегда, пока процесс способен обработать запрос. */
  @Get()
  live() {
    return {
      status: 'ok',
      service: process.env.SERVICE_NAME ?? 'unknown',
      uptimeSec: Math.round(process.uptime()),
    };
  }

  /** Readiness. 200 — готов, 503 — зависимости недоступны. */
  @Get('ready')
  async ready() {
    const result = await this.health.readiness();
    if (!result.ready) {
      // Бросаем объект с кодом, чтобы Nest вернул 503 без отдельного фильтра
      const error = new Error('not ready') as Error & { status?: number; response?: unknown };
      error.status = 503;
      error.response = { status: 'not_ready', checks: result.checks };
      throw error;
    }
    return { status: 'ready', checks: result.checks };
  }
}

/** Реализация стандартного grpc.health.v1.Health. */
@Controller()
export class GrpcHealthController {
  constructor(private readonly health: HealthService) {}

  @GrpcMethod('Health', 'Check')
  async check(): Promise<{ status: string }> {
    const result = await this.health.readiness();
    return { status: result.ready ? 'SERVING' : 'NOT_SERVING' };
  }
}

@Module({
  controllers: [HealthController, GrpcHealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
