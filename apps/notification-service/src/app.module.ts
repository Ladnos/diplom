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
 * Сервис — конечная точка потока событий (§2.1): он подписан на всю шину,
 * ничего не публикует и почти не имеет входящих вызовов. Отсюда две
 * особенности по сравнению с остальными доменными сервисами.
 *
 * Первая: MessagingModule подключён БЕЗ outbox. Транзакционный outbox
 * нужен издателю событий, а издавать здесь нечего — таблица осталась бы
 * пустой, а воркер опрашивал бы её раз в секунду в каждом контейнере.
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
