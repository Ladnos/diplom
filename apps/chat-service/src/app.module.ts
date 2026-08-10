import { Module } from '@nestjs/common';
import { HealthModule } from '@crm/common';
import { MessagingModule } from '@crm/messaging';
import { GrpcClientsModule } from '@crm/grpc-clients';
import { SERVICES } from '@crm/contracts';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Корневой модуль chat-service.
 *
 * Пока подключена только инфраструктура: health, обмен сообщениями,
 * доступ к БД и gRPC-клиенты к сервисам, которые нужны по §6.3.
 * Доменные модули добавляются сюда по мере реализации.
 */
@Module({
  imports: [
    HealthModule,
    MessagingModule.forRoot(),
    PrismaModule,
    GrpcClientsModule.register([SERVICES.AUTH, SERVICES.HR, SERVICES.FILE, SERVICES.VIDEO]),
  ],
})
export class AppModule {}
