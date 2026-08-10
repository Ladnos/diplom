import { Global, Module } from '@nestjs/common';
import { ContactsService } from './contacts.service';
import { HrContactsClient } from './hr-contacts.client';
import { PresenceService } from './presence.service';

/**
 * Проекция контактов и присутствие.
 *
 * @Global, потому что получателя разрешают и правила уведомлений, и
 * обработчики команд, и gRPC-контроллер — то есть почти всё.
 *
 * Redis намеренно НЕ попадает в readiness-пробу, в отличие от api-gateway.
 * Там без кэша ломается проверка токена, здесь — теряется только различие
 * «онлайн/офлайн», и уведомление всё равно уходит. Сервис, объявляющий
 * себя неготовым из-за необязательной зависимости, перестаёт делать
 * работу, которую вполне мог бы делать.
 */
@Global()
@Module({
  providers: [ContactsService, HrContactsClient, PresenceService],
  exports: [ContactsService, PresenceService],
})
export class ContactsModule {}
