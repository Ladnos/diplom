import { Module } from '@nestjs/common';
import { HealthModule } from '@crm/common';
import { MessagingModule } from '@crm/messaging';
import { PrismaModule } from './prisma/prisma.module';
import { ChatModule } from './chat/chat.module';

/**
 * Корневой модуль chat-service.
 *
 * Самый нагруженный по записи сервис (ADR-5): каждое сообщение — это
 * строка, инкремент номера в канале и запись в outbox одной транзакцией.
 * Отсюда outbox: сообщение, сохранённое в базе, но не доставленное ни в
 * одно открытое окно и не породившее push, потеряно для всех, кроме
 * отправителя.
 *
 * gRPC-клиентов нет. Кадровые данные приходят событиями в собственную
 * проекцию, вложения проверяет file-service при загрузке, а звонок
 * создаёт api-gateway — чату остаётся только принять событие о его
 * завершении. Переписка не должна останавливаться из-за чужой
 * недоступности.
 */
@Module({
  imports: [
    HealthModule,
    MessagingModule.forRoot({ outbox: true }),
    PrismaModule,
    ChatModule,
  ],
})
export class AppModule {}
