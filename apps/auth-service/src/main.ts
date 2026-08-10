import 'reflect-metadata';
import { SERVICES } from '@crm/contracts';
import { bootstrapService } from '@crm/common';
import { AppModule } from './app.module';

/**
 * Точка входа auth-service.
 *
 * Вся настройка транспортов (gRPC, RabbitMQ, HTTP, health, трассировка)
 * живёт в общем bootstrapService — см. libs/common/src/bootstrap.
 * Здесь остаётся только выбрать сервис из реестра и передать модуль.
 */
void bootstrapService({
  service: SERVICES.AUTH,
  module: AppModule,
});
