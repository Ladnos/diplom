import { Module } from '@nestjs/common';
import { HealthModule } from '@crm/common';
import { MessagingModule } from '@crm/messaging';
import { PrismaModule } from './prisma/prisma.module';
import { AnalyticsModule } from './analytics.module';

/**
 * Корневой модуль analytics-service.
 *
 * Единственный сервис, подписанный на ВЕСЬ поток событий системы:
 * очередь привязана к `#`. Из этого следуют обе его функции — журнал
 * аудита получается сам собой, а витрины материализуются заранее, чтобы
 * тяжёлые агрегирующие запросы не конкурировали с оперативной нагрузкой
 * владельцев данных (§2.1).
 *
 * gRPC-клиентов нет, хотя матрица §12 допускает точечные обращения за
 * справочными данными. Они не понадобились: всё, чем отчёт подписывает
 * строки, — имена, отделы, руководители — приезжает теми же событиями и
 * лежит в собственной проекции. Отчёт строится и когда источники
 * недоступны.
 */
@Module({
  imports: [
    HealthModule,
    MessagingModule.forRoot({ outbox: true }),
    PrismaModule,
    AnalyticsModule,
  ],
})
export class AppModule {}
