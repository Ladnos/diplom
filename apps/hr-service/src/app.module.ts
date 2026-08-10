import { Module } from '@nestjs/common';
import { HealthModule } from '@crm/common';
import { MessagingModule } from '@crm/messaging';
import { PrismaModule } from './prisma/prisma.module';
import { StaffModule } from './staff/staff.module';

/**
 * Корневой модуль hr-service.
 *
 * Мастер-данные о персонале и его рабочем времени: сотрудники,
 * оргструктура, типы найма, графики и расчётный табель (ADR-1, ADR-2).
 *
 * Исходящих gRPC-клиентов у сервиса нет — он ни у кого ничего не
 * спрашивает, только отвечает и публикует события. Это делает его
 * независимым от доступности остальных сервисов.
 */
@Module({
  imports: [
    HealthModule,
    MessagingModule.forRoot({ outbox: true }),
    PrismaModule,
    StaffModule,
  ],
})
export class AppModule {}
