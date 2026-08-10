import { Injectable } from '@nestjs/common';
import type { HealthCheckResult, HealthIndicator } from '@crm/common';
import { PrismaService } from './prisma.service';

/** Проверка доступности БД для readiness-пробы (/health/ready). */
@Injectable()
export class PrismaHealthIndicator implements HealthIndicator {
  readonly name = 'database';

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<HealthCheckResult> {
    await this.prisma.$queryRaw`SELECT 1`;
    return { name: this.name, healthy: true };
  }
}
