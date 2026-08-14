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
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('relation') relation?: string,
  ) {
    if (!user.employeeId && scope !== 'GLOBAL') {
      return { employees: [], scope, note: 'профиль сотрудника ещё не создан' };
    }

    const query = (search ?? '').trim();
    const parsed = Number.parseInt(limit ?? '', 10);
    const take = Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
    let employees: EmployeeDto[] = [];

    /**
     * Явный запрос подчинённых.
     *
     * Область действия возвращается самая широкая из имеющихся, а
     * DEPARTMENT шире, чем SUBORDINATE, — и у руководителя, у которого
     * есть обе, список подчинённых иначе недостижим: выборка всегда
     * сводилась бы к его отделу. Но подчинённый не обязан быть в том же
     * отделе — как раз его туда и переводят.
     *
     * Ограничение не ослабляется: выборку строит hr-service от
     * employeeId из токена, и никого, кроме собственных подчинённых,
     * вернуть не может. У сотрудника без подчинённых ответ пуст.
     */
    if (relation === 'subordinates') {
      employees = (await this.hr.getSubordinates(user.employeeId!, -1)).employees;
    } else if (scope === 'GLOBAL') {
      // Отдел здесь — необязательный фильтр, а не обязательный ключ:
      // кадровику список нужен целиком, в том числе чтобы назначить
      // отдел тому, у кого его ещё нет.
      employees = (await this.hr.listEmployees({ query, departmentId, limit: take })).employees;
    } else if (scope === 'SUBORDINATE') {
      employees = (await this.hr.getSubordinates(user.employeeId!, -1)).employees;
    } else if (scope === 'DEPARTMENT') {
      const self = await this.hr.getEmployee(user.employeeId!);
      employees = self.department_id
        ? (
            await this.hr.listEmployees({
              query,
              departmentId: self.department_id,
              limit: take,
            })
          ).employees
        : [self];
    } else if (scope === 'SELF') {
      employees = [await this.hr.getEmployee(user.employeeId!)];
    }

    // Область SUBORDINATE и вырожденные случаи выше приходят без поиска:
    // выборка ограничена подчинёнными и заведомо мала, поэтому дешевле
    // отфильтровать здесь, чем заводить отдельный вызов.
    if (query && (relation === 'subordinates' || (scope !== 'GLOBAL' && scope !== 'DEPARTMENT'))) {
      const needle = query.toLowerCase();
      employees = employees.filter(
        (employee) =>
          employee.full_name.toLowerCase().includes(needle) ||
          (employee.position ?? '').toLowerCase().includes(needle),
      );
    }

    return { employees: await this.withDepartments(employees), scope };
  }

  /**
   * Подстановка названий подразделений.
   *
   * Справочник берётся целиком одним вызовом, а не по идентификатору на
   * каждого сотрудника: отделов в компании десятки, а строк в списке —
   * сотни, и запрос на строку превратил бы открытие списка в N+1. Отказ
   * справочника не ломает выдачу — останется идентификатор без названия.
   */
  private async withDepartments(employees: EmployeeDto[]) {
    const rows = employees.map(toPublicEmployee);
    if (!rows.some((row) => row.departmentId)) return rows;

    const names = await this.hr
      .listDepartments()
      .then(
        (result) =>
          new Map(result.departments.map((item) => [item.department_id, item.name])),
      )
      .catch(() => new Map<string, string>());

    return rows.map((row) => ({
      ...row,
      departmentName: row.departmentId ? (names.get(row.departmentId) ?? null) : null,
    }));
  }

  @Get(':id')
  @RequirePermission({ resource: 'employee', action: 'read', ownerFrom: { param: 'id' } })
  async getOne(@Param('id', ParseUUIDPipe) id: string) {
    const [employee] = await this.withDepartments([await this.hr.getEmployee(id)]);
    return employee;
  }

  /**
   * Правка карточки сотрудника.
   *
   * Право employee/write есть и у рядового сотрудника, но со scope SELF —
   * это «редактировать свой профиль», а не «назначить себе руководителя».
   * Подчинённость и отдел определяют маршрут согласования и видимость
   * данных, поэтому в области SELF эти поля отбрасываются: иначе автор
   * заявки мог бы выбрать себе удобного согласующего.
   */
  @Patch(':id')
  @RequirePermission({ resource: 'employee', action: 'write', ownerFrom: { param: 'id' } })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployeeDto,
    @PermissionScope() scope: string,
  ) {
    const patch = scope === 'SELF' ? { ...dto, departmentId: undefined, managerId: undefined } : dto;
    return toPublicEmployee(await this.hr.updateEmployee({ employeeId: id, ...patch }));
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
    position: employee.position || null,
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
