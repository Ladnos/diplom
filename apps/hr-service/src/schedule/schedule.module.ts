import { Module, forwardRef } from '@nestjs/common';
import { ScheduleService } from './schedule.service';
import { CalendarService } from './calendar.service';
import { ScheduleGrpcController } from './schedule.grpc.controller';
import { ApprovalEventsController } from './approval-events.controller';
import { TimesheetModule } from '../timesheet/timesheet.module';

/**
 * Модуль schedule: графики, смены, отсутствия, производственный календарь.
 *
 * forwardRef с timesheet — единственная взаимная зависимость внутри
 * hr-service: табель считает норму из графика, а потребитель согласований
 * живёт здесь и применяет как отсутствия, так и переработки. Разрывать её
 * третьим модулем-посредником ради формальной чистоты не стоит: связь
 * отражает предметную область, где табель и график неразделимы (ADR-1).
 */
@Module({
  imports: [forwardRef(() => TimesheetModule)],
  controllers: [ScheduleGrpcController, ApprovalEventsController],
  providers: [ScheduleService, CalendarService],
  exports: [ScheduleService, CalendarService],
})
export class ScheduleModule {}
