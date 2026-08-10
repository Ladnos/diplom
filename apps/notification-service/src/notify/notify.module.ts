import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { PreferencesService } from './preferences.service';
import { InboxService } from './inbox.service';
import { DomainEventsController } from './domain-events.controller';
import { NotificationGrpcController } from './notification.grpc.controller';

/**
 * Маршрутизация уведомлений и in-app история.
 *
 * Сервис устроен как одна дуга: очередь → правило → строки в базе →
 * воркер доставки. Здесь первые три звена; отправка живёт в
 * DeliveryModule, потому что у неё другой темп и другие отказы.
 */
@Module({
  controllers: [DomainEventsController, NotificationGrpcController],
  providers: [NotificationService, PreferencesService, InboxService],
  exports: [NotificationService, PreferencesService, InboxService],
})
export class NotifyModule {}
