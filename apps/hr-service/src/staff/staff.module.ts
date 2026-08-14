import { Module } from '@nestjs/common';
import { StaffService } from './staff.service';
import { OrgService } from './org.service';
import { StaffGrpcController } from './staff.grpc.controller';
import { OrgGrpcController } from './org.grpc.controller';
import { AuthEventsController } from './auth-events.controller';

/**
 * Модуль staff: сотрудники, оргструктура, типы найма.
 *
 * Один из трёх модулей hr-service (ADR-1). Соседние — schedule (графики,
 * отсутствия) и timesheet (расчётный табель) — появятся рядом и НЕ будут
 * импортировать репозитории друг друга: общение только через доменные
 * сервисы, чтобы граница осталась пригодной для выделения в отдельный
 * контейнер.
 */
@Module({
  controllers: [StaffGrpcController, OrgGrpcController, AuthEventsController],
  providers: [StaffService, OrgService],
  exports: [StaffService, OrgService],
})
export class StaffModule {}
