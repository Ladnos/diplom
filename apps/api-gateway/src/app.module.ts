import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { HEALTH_INDICATORS, HealthModule, type HealthIndicator } from '@crm/common';
import { MessagingModule } from '@crm/messaging';
import { GrpcClientsModule } from '@crm/grpc-clients';
import { SERVICES } from '@crm/contracts';
import { AuthClient } from './clients/auth.client';
import { HrClient } from './clients/hr.client';
import { RedisService } from './cache/redis.service';
import { JwtAuthGuard } from './auth/auth.guard';
import { PermissionGuard } from './auth/permission.guard';
import { GrpcExceptionFilter } from './http/grpc-exception.filter';
import { AuthController } from './http/auth.controller';
import { EmployeesController } from './http/employees.controller';

/**
 * Корневой модуль api-gateway.
 *
 * Единственный сервис без собственной БД: всё состояние в Redis.
 * Держит gRPC-клиентов ко всем доменным сервисам и собирает из них
 * ответы для клиента — это и есть BFF-агрегация из ADR-3, часть 3.
 *
 * Порядок guard'ов важен: JwtAuthGuard заполняет request.user, на
 * который опирается PermissionGuard. Nest применяет глобальные guard'ы
 * в порядке регистрации.
 */
@Module({
  imports: [
    HealthModule,
    MessagingModule.forRoot(),
    GrpcClientsModule.register([
      SERVICES.AUTH,
      SERVICES.HR,
      SERVICES.APPROVAL,
      SERVICES.TASK,
      SERVICES.CHAT,
      SERVICES.VIDEO,
      SERVICES.FILE,
      SERVICES.NOTIFICATION,
      SERVICES.ANALYTICS,
    ]),
  ],
  controllers: [AuthController, EmployeesController],
  providers: [
    AuthClient,
    HrClient,
    RedisService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_FILTER, useClass: GrpcExceptionFilter },
    {
      // Доступность Redis попадает в readiness: без кэша gateway
      // работает, но деградировавшим — это должно быть видно снаружи.
      provide: HEALTH_INDICATORS,
      useFactory: (redis: RedisService): HealthIndicator[] => [redis],
      inject: [RedisService],
    },
  ],
})
export class AppModule {}
