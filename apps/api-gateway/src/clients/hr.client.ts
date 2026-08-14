import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { SERVICES } from '@crm/contracts';
import { DEADLINES_MS, grpcClientToken } from '@crm/grpc-clients';

export interface EmploymentDto {
  contract_id: string;
  employee_id: string;
  type: string;
  payment_form: string;
  policy: string;
  rate: number;
  valid_from: string;
  valid_to: string;
}

export interface EmployeeDto {
  employee_id: string;
  user_id: string;
  full_name: string;
  department_id: string;
  position: string;
  manager_id: string;
  active: boolean;
  employment?: EmploymentDto;
  avatar_file_id: string;
  hired_at: string;
  fired_at: string;
}

interface StaffGrpc {
  GetEmployee(data: { employee_id: string }): Observable<EmployeeDto>;
  GetEmployeesBatch(data: { ids: string[] }): Observable<{ employees: EmployeeDto[] }>;
  ListByDepartment(data: {
    department_id: string;
    include_inactive?: boolean;
  }): Observable<{ employees: EmployeeDto[] }>;
  ListEmployees(data: {
    query?: string;
    department_id?: string;
    include_inactive?: boolean;
    limit?: number;
    offset?: number;
  }): Observable<{ employees: EmployeeDto[] }>;
  GetSubordinates(data: { manager_id: string; depth: number }): Observable<{ employees: EmployeeDto[] }>;
  GetManagerChain(data: { employee_id: string }): Observable<{ employees: EmployeeDto[] }>;
  GetEmploymentInfo(data: { employee_id: string }): Observable<EmploymentDto>;
  ChangeEmployment(data: {
    employee_id: string;
    type: string;
    payment_form: string;
    rate?: number;
    valid_from?: string;
  }): Observable<EmploymentDto>;
  UpdateEmployee(data: {
    employee_id: string;
    full_name?: string;
    position?: string;
    department_id?: string;
    manager_id?: string;
    avatar_file_id?: string;
  }): Observable<EmployeeDto>;
  DeactivateEmployee(data: {
    employee_id: string;
    date?: string;
    reason?: string;
  }): Observable<EmployeeDto>;
}

export interface DepartmentDto {
  department_id: string;
  name: string;
  parent_id: string;
  employee_count: number;
  created_at: string | number;
}

interface OrgGrpc {
  ListDepartments(data: { query?: string }): Observable<{ departments: DepartmentDto[] }>;
  GetDepartment(data: { department_id: string }): Observable<DepartmentDto>;
  CreateDepartment(data: { name: string; parent_id?: string }): Observable<DepartmentDto>;
  UpdateDepartment(data: {
    department_id: string;
    name?: string;
    parent_id?: string;
    detach_parent?: boolean;
  }): Observable<DepartmentDto>;
  DeleteDepartment(data: { department_id: string }): Observable<Record<string, never>>;
  AssignEmployees(data: {
    department_id: string;
    employee_ids: string[];
  }): Observable<{ value: number }>;
}

/**
 * Клиент к hr-service: модуль staff (StaffService) и справочник
 * подразделений (OrgService). Оба сервиса объявлены в одном пакете hr и
 * живут в одном контейнере — клиент здесь один, соединение общее.
 */
@Injectable()
export class HrClient implements OnModuleInit {
  private staff!: StaffGrpc;
  private org!: OrgGrpc;

  constructor(@Inject(grpcClientToken(SERVICES.HR)) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.staff = this.client.getService<StaffGrpc>('StaffService');
    this.org = this.client.getService<OrgGrpc>('OrgService');
  }

  // ── Подразделения ────────────────────────────────────────────────────

  listDepartments(query?: string) {
    return firstValueFrom(
      this.org.ListDepartments({ query: query ?? '' }).pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  getDepartment(departmentId: string) {
    return firstValueFrom(
      this.org.GetDepartment({ department_id: departmentId }).pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  createDepartment(input: { name: string; parentId?: string }) {
    return firstValueFrom(
      this.org
        .CreateDepartment({ name: input.name, parent_id: input.parentId ?? '' })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  updateDepartment(input: {
    departmentId: string;
    name?: string;
    parentId?: string;
    detachParent?: boolean;
  }) {
    return firstValueFrom(
      this.org
        .UpdateDepartment({
          department_id: input.departmentId,
          name: input.name ?? '',
          parent_id: input.parentId ?? '',
          detach_parent: input.detachParent ?? false,
        })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  deleteDepartment(departmentId: string) {
    return firstValueFrom(
      this.org
        .DeleteDepartment({ department_id: departmentId })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  assignEmployees(departmentId: string, employeeIds: string[]) {
    return firstValueFrom(
      this.org
        .AssignEmployees({ department_id: departmentId, employee_ids: employeeIds })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  // ── Сотрудники ───────────────────────────────────────────────────────

  getEmployee(employeeId: string) {
    return firstValueFrom(
      this.staff.GetEmployee({ employee_id: employeeId }).pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  getEmployeesBatch(ids: string[]) {
    return firstValueFrom(
      this.staff.GetEmployeesBatch({ ids }).pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  listByDepartment(departmentId: string, includeInactive = false) {
    return firstValueFrom(
      this.staff
        .ListByDepartment({ department_id: departmentId, include_inactive: includeInactive })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  /** Перечень с поиском — для выпадающих списков выбора сотрудника. */
  listEmployees(input: {
    query?: string;
    departmentId?: string;
    includeInactive?: boolean;
    limit?: number;
    offset?: number;
  }) {
    return firstValueFrom(
      this.staff
        .ListEmployees({
          query: input.query ?? '',
          department_id: input.departmentId ?? '',
          include_inactive: input.includeInactive ?? false,
          limit: input.limit ?? 50,
          offset: input.offset ?? 0,
        })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  getSubordinates(managerId: string, depth = 1) {
    return firstValueFrom(
      this.staff.GetSubordinates({ manager_id: managerId, depth }).pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  getEmploymentInfo(employeeId: string) {
    return firstValueFrom(
      this.staff.GetEmploymentInfo({ employee_id: employeeId }).pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  changeEmployment(input: {
    employeeId: string;
    type: string;
    paymentForm: string;
    rate?: number;
    validFrom?: string;
  }) {
    return firstValueFrom(
      this.staff
        .ChangeEmployment({
          employee_id: input.employeeId,
          type: input.type,
          payment_form: input.paymentForm,
          rate: input.rate,
          valid_from: input.validFrom,
        })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  updateEmployee(input: {
    employeeId: string;
    fullName?: string;
    position?: string;
    departmentId?: string;
    managerId?: string;
    avatarFileId?: string;
  }) {
    return firstValueFrom(
      this.staff
        .UpdateEmployee({
          employee_id: input.employeeId,
          full_name: input.fullName,
          position: input.position,
          department_id: input.departmentId,
          manager_id: input.managerId,
          avatar_file_id: input.avatarFileId,
        })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  deactivateEmployee(employeeId: string, date?: string, reason?: string) {
    return firstValueFrom(
      this.staff
        .DeactivateEmployee({ employee_id: employeeId, date, reason })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }
}
