import { Module } from '@nestjs/common';
import { HealthModule } from '@crm/common';
import { MessagingModule } from '@crm/messaging';
import { GrpcClientsModule } from '@crm/grpc-clients';
import { SERVICES } from '@crm/contracts';

/**
 * Корневой модуль api-gateway.
 *
 * Gateway — единственный сервис без собственной БД: всё состояние живёт
 * в Redis (сессии, карта «пользователь → инстанс» для WebSocket).
 * Зато он единственный, кто держит gRPC-клиентов ко всем доменным
 * сервисам — это и есть BFF-агрегация из ADR-3, часть 3.
 *
 * Доменные модули (auth-proxy, boards, chat, calls, dashboard) появятся
 * здесь по мере реализации.
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
})
export class AppModule {}
