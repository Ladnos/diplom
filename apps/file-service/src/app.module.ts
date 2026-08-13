import { Module } from '@nestjs/common';
import { HealthModule } from '@crm/common';
import { MessagingModule } from '@crm/messaging';
import { PrismaModule } from './prisma/prisma.module';
import { FileConfigModule } from './config';
import { FilesModule } from './files/files.module';

/**
 * Корневой модуль file-service.
 *
 * Единственный сервис, привязанный к конкретному узлу: он владеет
 * каталогом на диске, и запустить его в нескольких экземплярах без
 * общего хранилища нельзя. Ограничение принято сознательно и вытекает из
 * требования «self-hosted», а не из недосмотра — §9.6 перечисляет
 * выходы, если система вырастет за пределы одного сервера.
 *
 * Байты через этот модуль не проходят. Приём идёт потоком на диск,
 * отдача — силами nginx через X-Accel-Redirect, а Node в обоих случаях
 * занимается только правами и метаданными.
 */
@Module({
  imports: [
    HealthModule,
    FileConfigModule,
    MessagingModule.forRoot({ outbox: true }),
    PrismaModule,
    FilesModule,
  ],
})
export class AppModule {}
