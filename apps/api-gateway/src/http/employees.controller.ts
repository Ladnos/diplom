import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { HrClient, type EmployeeDto } from '../clients/hr.client';
import type { AuthenticatedUser } from '../auth/auth.guard';
import { CurrentUser, PermissionScope, RequirePermission } from '../auth/permission.guard';
import { ChangeEmploymentDto, DeactivateEmployeeDto, UpdateEmployeeDto } from './dto';

/**
 * REST-интерфейс к кадровым данным.
 *
 * Права проверяются декларативно через @RequirePermission: контроллер не
 * содержит собственной логики «а руководитель ли он» — этот вопрос
 * целиком принадлежит auth-service (ADR-3).
 */
@Controller('api/employees')
export class EmployeesController {
  constructor(private readonly hr: HrClient) {}

  /**
   * Список сотрудников. Область действия определяет, что именно видно:
   * рядовой сотрудник — свой отдел, руководитель — подчинённых,
   * кадровик — всех. Фильтрацию делает gateway по возвращённому scope,
   * потому что сам список формирует hr-service, ничего не знающий о правах.
   */
  @Get()
  @RequirePermission({ resource: 'employee', action: 'read' })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @PermissionScope() scope: string,
    @Query('departmentId') departmentId?: string,
  ) {
    if (!user.employeeId && scope !== 'GLOBAL') {
      return { employees: [], scope, note: 'профиль сотрудника ещё не создан' };
    }

    let employees: EmployeeDto[] = [];

    if (scope === 'GLOBAL' && departmentId) {
      employees = (await this.hr.listByDepartment(departmentId)).employees;
    } else if (scope === 'SUBORDINATE') {
      employees = (await this.hr.getSubordinates(user.employeeId!, -1)).employees;
    } else if (scope === 'DEPARTMENT') {
      const self = await this.hr.getEmployee(user.employeeId!);
      employees = self.department_id
        ? (await this.hr.listByDepartment(self.department_id)).employees
        : [self];
    } else if (scope === 'SELF') {
      employees = [await this.hr.getEmployee(user.employeeId!)];
    } else if (scope === 'GLOBAL') {
      // Без departmentId глобальная выборка потребовала бы постраничного
      // метода, которого пока нет в контракте
      return { employees: [], scope, note: 'укажите departmentId' };
    }

    return { employees: employees.map(toPublicEmployee), scope };
  }

  @Get(':id')
  @RequirePermission({ resource: 'employee', action: 'read', ownerFrom: { param: 'id' } })
  async getOne(@Param('id', ParseUUIDPipe) id: string) {
    return toPublicEmployee(await this.hr.getEmployee(id));
  }

  @Patch(':id')
  @RequirePermission({ resource: 'employee', action: 'write', ownerFrom: { param: 'id' } })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateEmployeeDto) {
    return toPublicEmployee(await this.hr.updateEmployee({ employeeId: id, ...dto }));
  }

  /**
   * Перевод на другой тип найма (§10.5).
   *
   * Право employment/write выдано только роли HR: смена ГПХ на штат
   * меняет применимость целых подсистем — графика, табеля, отпусков, —
   * и не должна быть доступна линейному руководителю.
   */
  @Patch(':id/employment')
  @RequirePermission({ resource: 'employment', action: 'write', ownerFrom: { param: 'id' } })
  async changeEmployment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeEmploymentDto,
  ) {
    const contract = await this.hr.changeEmployment({ employeeId: id, ...dto });
    return {
      contractId: contract.contract_id,
      type: contract.type,
      paymentForm: contract.payment_form,
      policy: contract.policy,
      rate: contract.rate,
      validFrom: contract.valid_from,
    };
  }

  @Post(':id/deactivate')
  @RequirePermission({ resource: 'employee', action: 'write', ownerFrom: { param: 'id' } })
  async deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeactivateEmployeeDto,
  ) {
    const employee = await this.hr.deactivateEmployee(id, dto.date, dto.reason);
    return {
      ...toPublicEmployee(employee),
      message: 'увольнение оформлено; сессии, задачи и каналы будут закрыты асинхронно',
    };
  }
}

/** Наружу отдаются camelCase-поля: snake_case — деталь gRPC-контракта. */
function toPublicEmployee(employee: EmployeeDto) {
  return {
    employeeId: employee.employee_id,
    userId: employee.user_id,
    fullName: employee.full_name,
    departmentId: employee.department_id || null,
    managerId: employee.manager_id || null,
    active: employee.active,
    avatarFileId: employee.avatar_file_id || null,
    hiredAt: employee.hired_at || null,
    firedAt: employee.fired_at || null,
    employment: employee.employment
      ? {
          type: employee.employment.type,
          paymentForm: employee.employment.payment_form,
          policy: employee.employment.policy,
          rate: employee.employment.rate,
          validFrom: employee.employment.valid_from,
        }
      : null,
  };
}
