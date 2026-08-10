import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Employee, EmploymentContract, EmploymentType, PaymentForm } from '../../generated/prisma';
import { StaffService } from './staff.service';

type EmployeeWithContract = Employee & { contracts: EmploymentContract[] };

/** Дата в БД хранится как DATE; наружу отдаём ISO без времени. */
function toIsoDate(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : '';
}

function mapContract(contract: EmploymentContract | undefined) {
  if (!contract) return undefined;
  return {
    contract_id: contract.id,
    employee_id: contract.employeeId,
    type: contract.type,
    payment_form: contract.paymentForm,
    policy: contract.policy,
    rate: Number(contract.rate),
    valid_from: toIsoDate(contract.validFrom),
    valid_to: toIsoDate(contract.validTo),
  };
}

/**
 * proto3 не отличает «поле не задано» от нуля: для скалярных типов на
 * проводе передаётся значение по умолчанию, и загрузчик с defaults: true
 * отдаёт rate = 0 там, где клиент ничего не присылал. Без этой поправки
 * перевод сотрудника на другой тип найма молча обнулял бы ставку.
 */
function optionalRate(rate: number | undefined): number | undefined {
  return rate !== undefined && rate > 0 ? rate : undefined;
}

function mapEmployee(employee: EmployeeWithContract) {
  return {
    employee_id: employee.id,
    user_id: employee.userId,
    full_name: employee.fullName,
    department_id: employee.departmentId ?? '',
    position: employee.positionId ?? '',
    manager_id: employee.managerId ?? '',
    active: employee.active,
    employment: mapContract(employee.contracts?.[0]),
    avatar_file_id: employee.avatarFileId ?? '',
    hired_at: toIsoDate(employee.hiredAt),
    fired_at: toIsoDate(employee.firedAt),
  };
}

/**
 * gRPC-интерфейс модуля staff (libs/contracts/proto/hr.proto).
 *
 * Обратите внимание: это ОДИН из трёх сервисов пакета hr — StaffService,
 * ScheduleService и TimesheetService объявлены в общем контракте, но
 * представляют разные модули одного контейнера (ADR-1). Границы между
 * ними зафиксированы на уровне контракта, чтобы выделение любого из них
 * в отдельный сервис свелось к смене URL у клиента.
 */
@Controller()
export class StaffGrpcController {
  constructor(private readonly staff: StaffService) {}

  @GrpcMethod('StaffService', 'GetEmployee')
  async getEmployee(data: { employee_id: string }) {
    return mapEmployee(await this.staff.getEmployee(data.employee_id));
  }

  @GrpcMethod('StaffService', 'GetEmployeesBatch')
  async getEmployeesBatch(data: { ids: string[] }) {
    const employees = await this.staff.getEmployeesBatch(data.ids ?? []);
    return { employees: employees.map(mapEmployee) };
  }

  @GrpcMethod('StaffService', 'ListByDepartment')
  async listByDepartment(data: { department_id: string; include_inactive?: boolean }) {
    const employees = await this.staff.listByDepartment(
      data.department_id,
      data.include_inactive ?? false,
    );
    return { employees: employees.map(mapEmployee) };
  }

  @GrpcMethod('StaffService', 'GetManagerChain')
  async getManagerChain(data: { employee_id: string }) {
    const chain = await this.staff.getManagerChain(data.employee_id);
    return { employees: chain.map(mapEmployee) };
  }

  @GrpcMethod('StaffService', 'GetSubordinates')
  async getSubordinates(data: { manager_id: string; depth?: number }) {
    const subordinates = await this.staff.getSubordinates(data.manager_id, data.depth ?? 1);
    return { employees: subordinates.map(mapEmployee) };
  }

  @GrpcMethod('StaffService', 'IsManagerOf')
  async isManagerOf(data: { manager_id: string; employee_id: string }) {
    const value = await this.staff.isManagerOf(data.manager_id, data.employee_id);
    return { value, reason: value ? '' : 'не является руководителем' };
  }

  @GrpcMethod('StaffService', 'ExistsAndActive')
  async existsAndActive(data: { employee_id: string }) {
    const value = await this.staff.existsAndActive(data.employee_id);
    return { value, reason: value ? '' : 'сотрудник не найден или уволен' };
  }

  @GrpcMethod('StaffService', 'GetContacts')
  async getContacts(data: { ids: string[] }) {
    const contacts = await this.staff.getContacts(data.ids ?? []);
    return {
      contacts: contacts.map((contact) => ({
        employee_id: contact.employeeId,
        email: contact.email,
        phone: contact.phone,
      })),
    };
  }

  @GrpcMethod('StaffService', 'GetEmploymentInfo')
  async getEmploymentInfo(data: { employee_id: string }) {
    return mapContract(await this.staff.getEmploymentInfo(data.employee_id));
  }

  @GrpcMethod('StaffService', 'ChangeEmployment')
  async changeEmployment(data: {
    employee_id: string;
    type: EmploymentType;
    payment_form: PaymentForm;
    rate?: number;
    valid_from?: string;
  }) {
    const contract = await this.staff.changeEmployment({
      employeeId: data.employee_id,
      type: data.type,
      paymentForm: data.payment_form,
      rate: optionalRate(data.rate),
      validFrom: data.valid_from || undefined,
    });
    return mapContract(contract);
  }

  @GrpcMethod('StaffService', 'CreateEmployee')
  async createEmployee(data: {
    user_id: string;
    full_name: string;
    department_id?: string;
    position?: string;
    manager_id?: string;
    employment_type?: EmploymentType;
    payment_form?: PaymentForm;
    rate?: number;
    hired_at?: string;
  }) {
    const employee = await this.staff.createEmployee({
      userId: data.user_id,
      // Контракт CreateEmployeeCmd не несёт email: он приходит событием
      // регистрации. Прямое создание используется кадровиком, когда
      // учётная запись уже существует.
      email: `${data.user_id}@placeholder.local`,
      fullName: data.full_name,
      departmentId: data.department_id || undefined,
      managerId: data.manager_id || undefined,
      type: data.employment_type,
      paymentForm: data.payment_form,
      rate: optionalRate(data.rate),
      hiredAt: data.hired_at || undefined,
    });
    return mapEmployee({ ...employee, contracts: [] });
  }

  @GrpcMethod('StaffService', 'UpdateEmployee')
  async updateEmployee(data: {
    employee_id: string;
    full_name?: string;
    department_id?: string;
    position?: string;
    manager_id?: string;
    avatar_file_id?: string;
  }) {
    const employee = await this.staff.updateEmployee({
      employeeId: data.employee_id,
      fullName: data.full_name || undefined,
      departmentId: data.department_id || undefined,
      managerId: data.manager_id || undefined,
      avatarFileId: data.avatar_file_id || undefined,
    });
    return mapEmployee({ ...employee, contracts: [] });
  }

  @GrpcMethod('StaffService', 'DeactivateEmployee')
  async deactivateEmployee(data: { employee_id: string; date?: string; reason?: string }) {
    const employee = await this.staff.deactivateEmployee({
      employeeId: data.employee_id,
      date: data.date || undefined,
      reason: data.reason || undefined,
    });
    return mapEmployee({ ...employee, contracts: [] });
  }
}
