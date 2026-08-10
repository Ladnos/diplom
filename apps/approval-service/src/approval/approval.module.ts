import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ApprovalService } from './approval.service';
import { SagaService } from './saga.service';
import { ApprovalGrpcController } from './approval.grpc.controller';
import { HrEventsController } from './hr-events.controller';
import { HrClient } from '../clients/hr.client';
import { AuthClient } from '../clients/auth.client';

/**
 * Процесс согласования.
 *
 * ScheduleModule нужен для двух фоновых сторожей (см. SagaService):
 * таймера зависших саг и эскалации по истечении срока рассмотрения.
 * Без первого заявка может навсегда остаться в APPROVED — сотрудник
 * считает отпуск согласованным, а в кадровом сервисе его нет.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [ApprovalGrpcController, HrEventsController],
  providers: [ApprovalService, SagaService, HrClient, AuthClient],
  exports: [ApprovalService],
})
export class ApprovalModule {}
