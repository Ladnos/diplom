import { Module } from '@nestjs/common';
import { HealthModule } from '@crm/common';
import { MessagingModule } from '@crm/messaging';
import { PrismaModule } from './prisma/prisma.module';
import { VideoConfigModule } from './config';
import { RoomsModule } from './rooms/rooms.module';

/**
 * Корневой модуль video-service.
 *
 * Единственный сервис с тремя разными транспортами наружу: gRPC для
 * управления, WebSocket для сигналинга и UDP для медиа — причём
 * последний идёт мимо Node вовсе, через нативные воркеры mediasoup.
 *
 * gRPC-клиентов нет. Кадровые данные приходят событиями в собственную
 * проекцию, звонок из канала заводит api-gateway, а системную запись о
 * завершении кладёт chat-service по событию video.call.ended: звонок не
 * должен зависеть от доступности переписки.
 */
@Module({
  imports: [
    HealthModule,
    VideoConfigModule,
    MessagingModule.forRoot({ outbox: true }),
    PrismaModule,
    RoomsModule,
  ],
})
export class AppModule {}
