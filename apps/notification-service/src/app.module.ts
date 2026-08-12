import { Module } from '@nestjs/common';
import { HealthModule } from '@crm/common';
import { MessagingModule } from '@crm/messaging';
import { GrpcClientsModule } from '@crm/grpc-clients';
import { SERVICES } from '@crm/contracts';
import { PrismaModule } from './prisma/prisma.module';
import { ContactsModule } from './contacts/contacts.module';
import { NotifyModule } from './notify/notify.module';
import { DeliveryModule } from './delivery/delivery.module';
import { NotificationConfigModule } from './config';

/**
 * Корневой модуль notification-service.
 *
 * Сервис — конечная точка потока событий (§2.1): он подписан на всю шину
 * и почти не имеет входящих вызовов. Отсюда две особенности по сравнению
 * с остальными доменными сервисами.
 *
 * Первая: MessagingModule подключён БЕЗ outbox. Публикует сервис ровно
 * одно событие — notification.created, подсказку открытому окну поднять
 * счётчик (§8.1). Его потеря стоит одного неподнятого счётчика: лента
 * уже в базе и будет прочитана запросом. Заводить ради этого таблицу
 * outbox и воркер, опрашивающий её раз в секунду в каждом контейнере,
 * дороже последствий.
 *
 * Вторая: единственный gRPC-клиент — к hr-service, и только как fallback
 * для контактов (§6.3). Штатно проекция наполняется событиями, и
 * рассылка не зависит от доступности кадрового сервиса.
 */
@Module({
  imports: [
    HealthModule,
    NotificationConfigModule,
    MessagingModule.forRoot(),
    PrismaModule,
    GrpcClientsModule.register([SERVICES.HR]),
    ContactsModule,
    NotifyModule,
    DeliveryModule,
  ],
})
export class AppModule {}
