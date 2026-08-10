import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { SERVICES } from '@crm/contracts';
import { DEADLINES_MS, grpcClientToken } from '@crm/grpc-clients';
import type { TimeTrackingPolicy } from '../approval/request-types';

export interface EmployeeRef {
  employee_id: string;
  full_name: string;
  department_id: string;
  manager_id: string;
  active: boolean;
}

interface StaffGrpc {
  GetEmployee(data: { employee_id: string }): Observable<EmployeeRef>;
  GetManagerChain(data: { employee_id: string }): Observable<{ employees: EmployeeRef[] }>;
  GetEmploymentInfo(data: { employee_id: string }): Observable<{
    contract_id: string;
    type: string;
    payment_form: string;
    policy: TimeTrackingPolicy;
    rate: number;
  }>;
}

interface ScheduleGrpc {
  GetWorkContext(data: { employee_id: string; date: string }): Observable<{
    planned_shift?: { shift_id: string; starts_at: string; ends_at: string };
    absence?: { absence_id: string; type: string };
    should_be_working: boolean;
  }>;
}

/**
 * Клиент к hr-service.
 *
 * Маршрут согласования строится из ОРГСТРУКТУРЫ в момент подачи заявки,
 * а не хранится настройкой: «руководитель сотрудника» — то, что кадровый
 * сервис знает точно, а дублирующая настройка неизбежно устарела бы после
 * первого же перевода между отделами.
 */
@Injectable()
export class HrClient implements OnModuleInit {
  private staff!: StaffGrpc;
  private schedule!: ScheduleGrpc;

  constructor(@Inject(grpcClientToken(SERVICES.HR)) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.staff = this.client.getService<StaffGrpc>('StaffService');
    this.schedule = this.client.getService<ScheduleGrpc>('ScheduleService');
  }

  getEmployee(employeeId: string) {
    return firstValueFrom(
      this.staff.GetEmployee({ employee_id: employeeId }).pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  /** Цепочка руководителей снизу вверх — основа маршрута. */
  getManagerChain(employeeId: string) {
    return firstValueFrom(
      this.staff.GetManagerChain({ employee_id: employeeId }).pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  getEmploymentInfo(employeeId: string) {
    return firstValueFrom(
      this.staff
        .GetEmploymentInfo({ employee_id: employeeId })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  /** Рабочий контекст на дату — для валидации заявки при подаче. */
  getWorkContext(employeeId: string, date: string) {
    return firstValueFrom(
      this.schedule
        .GetWorkContext({ employee_id: employeeId, date })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }
}
