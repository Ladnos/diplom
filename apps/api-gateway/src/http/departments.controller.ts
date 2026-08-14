import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { HrClient, type DepartmentDto } from '../clients/hr.client';
import type { AuthenticatedUser } from '../auth/auth.guard';
import { CurrentUser, PermissionScope, RequirePermission } from '../auth/permission.guard';
import { AssignEmployeesDto, CreateDepartmentDto, UpdateDepartmentDto } from './dto';

/**
 * Справочник подразделений и состав отделов.
 *
 * Права разведены намеренно. Заводить, переименовывать и расформировывать
 * подразделения может кадровая служба (`department/write` с областью
 * GLOBAL): от отдела зависит область видимости DEPARTMENT, и создание
 * отдела — это создание границы доступа. Линейный руководитель получает
 * ту же пару ресурс-действие, но с областью DEPARTMENT, и ему доступно
 * ровно одно: перевести к себе своих подчинённых.
 *
 * Ограничение подчинёнными здесь существенно, а не для порядка. Без него
 * руководитель переводил бы в свой отдел кого угодно и по области
 * DEPARTMENT получал бы доступ к их данным — то есть повышал бы себе
 * права переводом.
 */
@Controller('api/departments')
export class DepartmentsController {
  constructor(private readonly hr: HrClient) {}

  @Get()
  @RequirePermission({ resource: 'department', action: 'read' })
  async list(@Query('search') search?: string) {
    const result = await this.hr.listDepartments(search);
    return { departments: result.departments.map(toPublicDepartment) };
  }

  @Get(':id')
  @RequirePermission({ resource: 'department', action: 'read' })
  async getOne(@Param('id', ParseUUIDPipe) id: string) {
    return toPublicDepartment(await this.hr.getDepartment(id));
  }

  /** Состав подразделения. Ограничение выборки — по области права. */
  @Get(':id/employees')
  @RequirePermission({ resource: 'employee', action: 'read' })
  async employees(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @PermissionScope() scope: string,
  ) {
    if (scope !== 'GLOBAL') {
      const self = user.employeeId ? await this.hr.getEmployee(user.employeeId) : null;
      if (self?.department_id !== id) {
        throw new ForbiddenException('состав чужого подразделения недоступен');
      }
    }

    const result = await this.hr.listByDepartment(id);
    return {
      employees: result.employees.map((employee) => ({
        employeeId: employee.employee_id,
        fullName: employee.full_name,
        position: employee.position || null,
        managerId: employee.manager_id || null,
        active: employee.active,
      })),
    };
  }

  @Post()
  @RequirePermission({ resource: 'department', action: 'write' })
  async create(@Body() dto: CreateDepartmentDto, @PermissionScope() scope: string) {
    this.requireGlobal(scope, 'заводить подразделения может кадровая служба');
    return toPublicDepartment(
      await this.hr.createDepartment({ name: dto.name, parentId: dto.parentId }),
    );
  }

  @Patch(':id')
  @RequirePermission({ resource: 'department', action: 'write' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDepartmentDto,
    @PermissionScope() scope: string,
  ) {
    this.requireGlobal(scope, 'переименовывать подразделения может кадровая служба');
    return toPublicDepartment(
      await this.hr.updateDepartment({
        departmentId: id,
        name: dto.name,
        parentId: dto.parentId,
        detachParent: dto.detachParent,
      }),
    );
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermission({ resource: 'department', action: 'write' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @PermissionScope() scope: string) {
    this.requireGlobal(scope, 'расформировывать подразделения может кадровая служба');
    await this.hr.deleteDepartment(id);
    return { removed: true };
  }

  /**
   * Перевод сотрудников в подразделение.
   *
   * Единственная операция, доступная руководителю: свой отдел, свои
   * подчинённые. Подчинённость берётся из hr-service одним вызовом на всё
   * дерево — проверять каждого отдельно значило бы делать по запросу на
   * человека при переводе целой группы.
   */
  @Post(':id/employees')
  @HttpCode(200)
  @RequirePermission({ resource: 'department', action: 'write' })
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignEmployeesDto,
    @CurrentUser() user: AuthenticatedUser,
    @PermissionScope() scope: string,
  ) {
    if (scope !== 'GLOBAL') {
      if (!user.employeeId) {
        throw new BadRequestException('профиль сотрудника ещё не создан');
      }

      const self = await this.hr.getEmployee(user.employeeId);
      if (!self.department_id) {
        throw new ForbiddenException(
          'вы не состоите ни в одном подразделении — попросите кадровую службу назначить вам отдел',
        );
      }
      if (self.department_id !== id) {
        throw new ForbiddenException('переводить можно только в собственное подразделение');
      }

      const subordinates = await this.hr.getSubordinates(user.employeeId, -1);
      const allowed = new Set(subordinates.employees.map((employee) => employee.employee_id));
      const foreign = dto.employeeIds.filter((employeeId) => !allowed.has(employeeId));
      if (foreign.length > 0) {
        throw new ForbiddenException(
          `перевести можно только своих подчинённых; вне вашего подчинения: ${foreign.length}`,
        );
      }
    }

    const result = await this.hr.assignEmployees(id, dto.employeeIds);
    return { moved: Number(result.value ?? 0) };
  }

  private requireGlobal(scope: string, message: string): void {
    if (scope !== 'GLOBAL') throw new ForbiddenException(message);
  }
}

function toPublicDepartment(department: DepartmentDto) {
  return {
    departmentId: department.department_id,
    name: department.name,
    parentId: department.parent_id || null,
    employeeCount: department.employee_count ?? 0,
    // int64 приезжает строкой: тип не помещается в number, и загрузчик
    // отдаёт его как есть.
    createdAt: new Date(Number(department.created_at)).toISOString(),
  };
}
