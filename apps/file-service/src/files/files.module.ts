import { Module } from '@nestjs/common';
import { GrpcClientsModule } from '@crm/grpc-clients';
import { SERVICES } from '@crm/contracts';
import { StorageService } from '../storage/storage.service';
import { AuthClient } from '../auth/auth.client';
import { TokenGuard } from '../auth/token.guard';
import { FileService } from './file.service';
import { AccessService } from './access.service';
import { SignedLinkService } from './signed-link.service';
import { MaintenanceService } from './maintenance.service';
import { UploadController } from './upload.controller';
import { DownloadController } from './download.controller';
import { FileGrpcController } from './file.grpc.controller';
import { DomainEventsController } from './domain-events.controller';

/**
 * Файловое хранилище.
 *
 * Единственный сервис, который проверяет токены сам: загрузка и
 * скачивание идут в него напрямую, минуя api-gateway (§9.2). Отсюда
 * клиент к auth-service.
 *
 * Клиенты к chat и task нужны для другого — решить, кому отдавать файл.
 * Вложение принадлежит загрузившему, а видеть его должны все участники
 * канала или доски, и знает об этом только сервис-владелец сущности
 * (§9.3). Зависимость односторонняя: ни чат, ни доски файловый сервис не
 * вызывают — они лишь публикуют события об удалении своих сущностей.
 */
@Module({
  imports: [GrpcClientsModule.register([SERVICES.AUTH, SERVICES.CHAT, SERVICES.TASK])],
  controllers: [
    UploadController,
    DownloadController,
    FileGrpcController,
    DomainEventsController,
  ],
  providers: [
    StorageService,
    FileService,
    AccessService,
    SignedLinkService,
    MaintenanceService,
    AuthClient,
    TokenGuard,
  ],
  exports: [FileService, StorageService, MaintenanceService],
})
export class FilesModule {}
