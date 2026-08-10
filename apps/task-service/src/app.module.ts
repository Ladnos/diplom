import { Module } from '@nestjs/common';
import { HealthModule } from '@crm/common';
import { MessagingModule } from '@crm/messaging';
import { PrismaModule } from './prisma/prisma.module';
import { BoardModule } from './board/board.module';

/**
 * Корневой модуль task-service.
 *
 * Kanban-доски с WIP-лимитами, дробными позициями карточек и
 * оптимистической блокировкой при перетаскивании.
 *
 * Исходящих gRPC-клиентов нет: всё, что нужно от кадрового сервиса,
 * приходит событиями в локальную проекцию доступности. Отрисовка доски
 * не зависит от доступности других сервисов.
 */
@Module({
  imports: [
    HealthModule,
    MessagingModule.forRoot({ outbox: true }),
    PrismaModule,
    BoardModule,
  ],
})
export class AppModule {}
