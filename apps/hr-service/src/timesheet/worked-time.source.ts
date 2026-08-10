import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { TimeTrackingPolicy } from '../../generated/prisma';
import { ScheduleService } from '../schedule/schedule.service';
import { shiftDurationMinutes, toIsoDate, type IsoDate } from '../schedule/date.util';

/**
 * ШОВ ПОД ФАКТИЧЕСКИЙ УЧЁТ ВРЕМЕНИ. docs/architecture.md §3.4, ADR-2
 *
 * Табель считается от нормы графика, потому что при окладной оплате
 * фактическое время прихода не влияет ни на одно решение. Но сотрудники
 * с почасовой оплатой (политика FACT_BASED) появятся, и тогда источником
 * данных станет attendance-service.
 *
 * Чтобы это не потребовало переписывать табель, расчёт обращается не к
 * графику напрямую, а к абстракции WorkedTimeSource. Сегодня работает
 * одна реализация; появление второй сведётся к написанию gRPC-клиента —
 * ни формат ответа, ни события, ни согласования не изменятся.
 */

export interface WorkedTime {
  date: IsoDate;
  minutes: number;
  /** Откуда взято значение. Поле есть в контракте с самого начала. */
  source: 'PLAN' | 'FACT';
}

export interface WorkedTimeSource {
  readonly kind: 'PLAN' | 'FACT';
  getWorkedMinutes(employeeId: string, from: IsoDate, to: IsoDate): Promise<WorkedTime[]>;
}

/**
 * Реализация по графику: норма рабочего времени из назначенных смен.
 * Единственная работающая сегодня.
 */
@Injectable()
export class PlannedTimeSource implements WorkedTimeSource {
  readonly kind = 'PLAN' as const;

  constructor(private readonly schedule: ScheduleService) {}

  async getWorkedMinutes(employeeId: string, from: IsoDate, to: IsoDate): Promise<WorkedTime[]> {
    const shifts = await this.schedule.getShiftsForPeriod([employeeId], from, to);
    return shifts.map((shift) => ({
      date: toIsoDate(shift.date),
      minutes: shiftDurationMinutes(shift.startsAt, shift.endsAt, shift.breakMinutes),
      source: 'PLAN',
    }));
  }
}

/**
 * Реализация по факту — ЗАГЛУШКА.
 *
 * Здесь будет gRPC-клиент к attendance-service (контракт уже описан в
 * libs/contracts/proto/attendance.proto, порт 50060 зарезервирован).
 * Метод намеренно не возвращает пустой массив: молчаливый ноль дал бы
 * почасовому сотруднику пустой табель и выглядел бы как нормальная
 * работа. Явная ошибка UNIMPLEMENTED говорит, чего именно не хватает.
 */
@Injectable()
export class TrackedTimeSource implements WorkedTimeSource {
  readonly kind = 'FACT' as const;
  private readonly logger = new Logger(TrackedTimeSource.name);

  async getWorkedMinutes(employeeId: string): Promise<WorkedTime[]> {
    this.logger.warn({
      message: 'запрошен фактический учёт времени, но attendance-service не развёрнут',
      employeeId,
    });
    throw new RpcException({
      code: GrpcStatus.UNIMPLEMENTED,
      message:
        'у сотрудника почасовая оплата (политика FACT_BASED), для расчёта табеля ' +
        'нужен фактический учёт времени. Сервис attendance-service не реализован — ' +
        'см. docs/architecture.md §3.4',
    });
  }
}

/** Выбор источника по политике учёта сотрудника. */
@Injectable()
export class WorkedTimeSourceResolver {
  constructor(
    private readonly planned: PlannedTimeSource,
    private readonly tracked: TrackedTimeSource,
  ) {}

  resolve(policy: TimeTrackingPolicy): WorkedTimeSource {
    switch (policy) {
      case 'NORM_BASED':
        return this.planned;
      case 'FACT_BASED':
        return this.tracked;
      default:
        // NONE и DELIVERABLE_BASED до источника не доходят: табель для
        // них не ведётся, и TimesheetService отсекает их раньше.
        throw new RpcException({
          code: GrpcStatus.FAILED_PRECONDITION,
          message: `табель не ведётся для политики учёта ${policy}`,
        });
    }
  }
}
