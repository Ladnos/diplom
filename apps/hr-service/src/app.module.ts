import { Module } from '@nestjs/common';
import { HealthModule } from '@crm/common';
import { MessagingModule } from '@crm/messaging';
import { PrismaModule } from './prisma/prisma.module';
import { StaffModule } from './staff/staff.module';
import { ScheduleModule } from './schedule/schedule.module';
import { TimesheetModule } from './timesheet/timesheet.module';

/**
 * Корневой модуль hr-service.
 *
 * Мастер-данные о персонале и его рабочем времени. Три модуля с чёткими
 * границами (ADR-1):
 *   staff     — сотрудники, оргструктура, типы найма
 *   schedule  — шаблоны графиков, смены, отсутствия, произв. календарь
 *   timesheet — расчётный табель, переработки, закрытие периода
 *
 * Границы зафиксированы и на уровне контракта: в пакете hr объявлены три
 * отдельных gRPC-сервиса, поэтому выделение любого модуля в собственный
 * контейнер сведётся к смене URL у клиента.
 *
 * Исходящих gRPC-клиентов у сервиса нет — он ни у кого ничего не
 * спрашивает, только отвечает и публикует события.
 */
@Module({
  imports: [
    HealthModule,
    MessagingModule.forRoot({ outbox: true }),
    PrismaModule,
    StaffModule,
    ScheduleModule,
    TimesheetModule,
  ],
})
export class AppModule {}
