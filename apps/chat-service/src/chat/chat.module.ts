import { Module } from '@nestjs/common';
import { ChannelService } from './channel.service';
import { MessageService } from './message.service';
import { ReadCursorService } from './read-cursor.service';
import { ChatGrpcController } from './chat.grpc.controller';
import { DomainEventsController } from './domain-events.controller';

/**
 * Переписка: каналы, сообщения, прочтение.
 *
 * Сервис самодостаточен: состав канала, порядок сообщений и права на
 * запись он решает сам, а из кадрового сервиса держит минимальную
 * проекцию — имя, признак увольнения и руководителя. Переписка обязана
 * работать, даже когда hr-service недоступен.
 *
 * Индикатора набора текста и присутствия здесь нет намеренно: они идут
 * через Redis Pub/Sub мимо этого сервиса и живут в api-gateway (§5, §8.2).
 * Сообщение обязано дойти, «печатает» обязано потеряться — разные
 * гарантии, разные транспорты, разные места в коде.
 */
@Module({
  controllers: [ChatGrpcController, DomainEventsController],
  providers: [ChannelService, MessageService, ReadCursorService],
  exports: [ChannelService, MessageService, ReadCursorService],
})
export class ChatModule {}
