import { Module } from '@nestjs/common';
import { HealthModule } from '@crm/common';
import { MessagingModule } from '@crm/messaging';
import { GrpcClientsModule } from '@crm/grpc-clients';
import { SERVICES } from '@crm/contracts';
import { PrismaModule } from './prisma/prisma.module';
import { ApprovalModule } from './approval/approval.module';

/**
 * Корневой модуль approval-service.
 *
 * Владеет ПРОЦЕССОМ согласования, но не результатом (ADR-3): публикует
 * решение, а применяет его владелец данных — hr-service. Заявка ждёт
 * подтверждающего события и только по нему переходит в APPLIED.
 *
 * Сервис-оркестратор: много спрашивает (hr, auth) и много публикует.
 * Для процесса, пересекающего несколько контекстов, это ожидаемый
 * профиль — в отличие от сервиса, выделенного по роли пользователя.
 */
@Module({
  imports: [
    HealthModule,
    MessagingModule.forRoot({ outbox: true }),
    PrismaModule,
    GrpcClientsModule.register([SERVICES.AUTH, SERVICES.HR]),
    ApprovalModule,
  ],
})
export class AppModule {}
