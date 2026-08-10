import { Module } from '@nestjs/common';
import { HealthModule } from '@crm/common';
import { MessagingModule } from '@crm/messaging';
import { GrpcClientsModule } from '@crm/grpc-clients';
import { SERVICES } from '@crm/contracts';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';

/**
 * Корневой модуль auth-service.
 *
 * Точка безопасности системы: выдаёт токены и отвечает на вопрос
 * «можно ли этому пользователю сделать это с этим объектом».
 * Оргструктуру держит в собственной проекции, наполняемой событиями
 * hr.* — чтобы проверка прав не зависела от доступности hr-service.
 */
@Module({
  imports: [
    HealthModule,
    MessagingModule.forRoot({ outbox: true }),
    PrismaModule,
    GrpcClientsModule.register([SERVICES.HR]),
    AuthModule,
  ],
})
export class AppModule {}
