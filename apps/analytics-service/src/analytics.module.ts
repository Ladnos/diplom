import { Module } from '@nestjs/common';
import { AuditService } from './ingest/audit.service';
import { IngestController } from './ingest/ingest.controller';
import { ProjectionsService } from './projections/projections.service';
import { ReportsService } from './reports/reports.service';
import { ExportService } from './reports/export.service';
import { AnalyticsGrpcController } from './reports/analytics.grpc.controller';

/**
 * Отчётность и журнал аудита.
 *
 * Разделение на две стороны — это и есть CQRS в чистом виде: слева поток
 * событий, наполняющий витрины, справа чтение готовых агрегатов. Между
 * ними нет общего кода записи и чтения, потому что у них разные формы
 * данных: писать удобно по событию, читать — по периоду и команде.
 */
@Module({
  controllers: [IngestController, AnalyticsGrpcController],
  providers: [AuditService, ProjectionsService, ReportsService, ExportService],
  exports: [ReportsService, ExportService, AuditService],
})
export class AnalyticsModule {}
