import { Global, Module } from '@nestjs/common';
import { HEALTH_INDICATORS, type HealthIndicator } from '@crm/common';
import { OUTBOX_STORE, PROCESSED_EVENT_STORE } from '@crm/messaging';
import { PrismaService } from './prisma.service';
import { PrismaProcessedEventStore } from './processed-event.store';
import { PrismaOutboxStore } from './outbox.store';
import { PrismaHealthIndicator } from './prisma-health.indicator';

/**
 * Доступ к базе сервиса.
 *
 * @Global, потому что PrismaService нужен почти каждому доменному модулю,
 * а импортировать PrismaModule в каждый — шум без пользы.
 */
@Global()
@Module({
  providers: [
    PrismaService,
    PrismaHealthIndicator,
    PrismaOutboxStore,
    { provide: PROCESSED_EVENT_STORE, useClass: PrismaProcessedEventStore },
    { provide: OUTBOX_STORE, useExisting: PrismaOutboxStore },
    {
      // Подмешивает проверку БД в readiness-пробу /health/ready
      provide: HEALTH_INDICATORS,
      useFactory: (db: PrismaHealthIndicator): HealthIndicator[] => [db],
      inject: [PrismaHealthIndicator],
    },
  ],
  exports: [PrismaService, PrismaOutboxStore, PROCESSED_EVENT_STORE, OUTBOX_STORE, HEALTH_INDICATORS],
})
export class PrismaModule {}
