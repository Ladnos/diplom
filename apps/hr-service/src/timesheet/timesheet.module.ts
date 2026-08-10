import { Module, forwardRef } from '@nestjs/common';
import { TimesheetService } from './timesheet.service';
import { TimesheetGrpcController } from './timesheet.grpc.controller';
import {
  PlannedTimeSource,
  TrackedTimeSource,
  WorkedTimeSourceResolver,
} from './worked-time.source';
import { ScheduleModule } from '../schedule/schedule.module';

/**
 * Модуль timesheet: расчётный табель.
 *
 * TrackedTimeSource зарегистрирован, хотя и не работает: это шов §3.4.
 * Провайдер существует, резолвер умеет его выбирать, и появление
 * attendance-service сведётся к замене тела одного метода.
 */
@Module({
  imports: [forwardRef(() => ScheduleModule)],
  controllers: [TimesheetGrpcController],
  providers: [TimesheetService, PlannedTimeSource, TrackedTimeSource, WorkedTimeSourceResolver],
  exports: [TimesheetService],
})
export class TimesheetModule {}
