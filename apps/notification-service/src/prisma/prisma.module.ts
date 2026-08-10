import { Global, Module } from '@nestjs/common';
import { HEALTH_INDICATORS, type HealthIndicator } from '@crm/common';
import { PROCESSED_EVENT_STORE } from '@crm/messaging';
import { PrismaService } from './prisma.service';
import { PrismaProcessedEventStore } from './processed-event.store';
import { PrismaHealthIndicator } from './prisma-health.indicator';

/**
 * Доступ к базе сервиса.
 *
 * @Global, потому что PrismaService нужен почти каждому доменному модулю,
 * а импортировать PrismaModule в каждый — шум без пользы.
 *
 * OUTBOX_STORE здесь нет: сервис не публикует событий, и транзакционному
 * outbox нечего хранить (см. комментарий в prisma/schema.prisma).
 */
@Global()
@Module({
  providers: [
    PrismaService,
    PrismaHealthIndicator,
    { provide: PROCESSED_EVENT_STORE, useClass: PrismaProcessedEventStore },
    {
      // Подмешивает проверку БД в readiness-пробу /health/ready
      provide: HEALTH_INDICATORS,
      useFactory: (db: PrismaHealthIndicator): HealthIndicator[] => [db],
      inject: [PrismaHealthIndicator],
    },
  ],
  exports: [PrismaService, PROCESSED_EVENT_STORE, HEALTH_INDICATORS],
})
export class PrismaModule {}
