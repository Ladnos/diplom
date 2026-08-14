import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import {
  HrEvents,
  type EmployeeUpdated,
  type RequestContext,
} from '@crm/contracts';
import { getRequestContext } from '@crm/common';
import { EventPublisher } from '@crm/messaging';
import type { Department, Prisma } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { outboxRow } from '../prisma/outbox.store';

export type DepartmentWithCount = Department & { employeeCount: number };

/**
 * Справочник подразделений. §3.1
 *
 * Дерево, а не плоский список: у отдела бывает родитель, и по этому
 * дереву строится административное деление. Подчинённость сотрудников при
 * этом хранится отдельно (Employee.managerId) и с деревом отделов не
 * связана — руководитель проекта может собирать людей из нескольких
 * подразделений, а начальник отдела не обязан быть руководителем каждого
 * в нём. Смешивать эти две иерархии нельзя: маршрут согласования идёт по
 * подчинённости, а область видимости DEPARTMENT — по отделу.
 */
@Injectable()
export class OrgService {
  private readonly logger = new Logger(OrgService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: EventPublisher,
  ) {}

  async listDepartments(query?: string): Promise<DepartmentWithCount[]> {
    const trimmed = (query ?? '').trim();

    const departments = await this.prisma.department.findMany({
      where: trimmed ? { name: { contains: trimmed, mode: 'insensitive' } } : {},
      orderBy: { name: 'asc' },
      include: { _count: { select: { employees: true } } },
    });

    return departments.map(({ _count, ...department }) => ({
      ...department,
      employeeCount: _count.employees,
    }));
  }

  async getDepartment(departmentId: string): Promise<DepartmentWithCount> {
    const department = await this.prisma.department.findUnique({
      where: { id: departmentId },
      include: { _count: { select: { employees: true } } },
    });
    if (!department) {
      throw new RpcException({
        code: GrpcStatus.NOT_FOUND,
        message: `подразделение ${departmentId} не найдено`,
      });
    }

    const { _count, ...rest } = department;
    return { ...rest, employeeCount: _count.employees };
  }

  async createDepartment(input: { name: string; parentId?: string }): Promise<DepartmentWithCount> {
    const name = input.name.trim();
    if (!name) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'название подразделения не может быть пустым',
      });
    }

    if (input.parentId) await this.getDepartment(input.parentId);

    const department = await this.prisma.department.create({
      data: { name, parentId: input.parentId ?? null },
    });

    this.logger.log({ message: 'подразделение создано', departmentId: department.id, name });
    return { ...department, employeeCount: 0 };
  }

  async updateDepartment(input: {
    departmentId: string;
    name?: string;
    parentId?: string;
    detachParent?: boolean;
  }): Promise<DepartmentWithCount> {
    const before = await this.getDepartment(input.departmentId);
    const data: Prisma.DepartmentUpdateInput = {};

    const name = input.name?.trim();
    if (name !== undefined && name !== '' && name !== before.name) {
      data.name = name;
    }

    if (input.detachParent) {
      data.parent = { disconnect: true };
    } else if (input.parentId && input.parentId !== before.parentId) {
      if (input.parentId === input.departmentId) {
        throw new RpcException({
          code: GrpcStatus.INVALID_ARGUMENT,
          message: 'подразделение не может быть вложено само в себя',
        });
      }
      await this.assertNotDescendant(input.departmentId, input.parentId);
      data.parent = { connect: { id: input.parentId } };
    }

    if (Object.keys(data).length === 0) return before;

    const department = await this.prisma.department.update({
      where: { id: input.departmentId },
      data,
    });
    return { ...department, employeeCount: before.employeeCount };
  }

  /**
   * Защита от цикла в дереве.
   *
   * Подъём подразделения под собственного потомка замкнул бы ветку в
   * кольцо: обход дерева перестал бы завершаться, а само подразделение
   * исчезло бы из выдачи — у него больше не было бы пути до корня.
   */
  private async assertNotDescendant(departmentId: string, candidateParentId: string) {
    const visited = new Set<string>();
    let cursor: string | null = candidateParentId;

    while (cursor && !visited.has(cursor)) {
      if (cursor === departmentId) {
        throw new RpcException({
          code: GrpcStatus.INVALID_ARGUMENT,
          message: 'нельзя подчинить подразделение собственному потомку',
        });
      }
      visited.add(cursor);
      const parent: { parentId: string | null } | null =
        await this.prisma.department.findUnique({
          where: { id: cursor },
          select: { parentId: true },
        });
      cursor = parent?.parentId ?? null;
    }
  }

  /**
   * Удаление.
   *
   * Отказ вместо каскада: люди и вложенные подразделения не должны
   * молча оставаться без отдела или переезжать наверх — куда их деть,
   * решает кадровая служба, а не операция удаления.
   */
  async deleteDepartment(departmentId: string): Promise<void> {
    const [employees, children] = await Promise.all([
      this.prisma.employee.count({ where: { departmentId } }),
      this.prisma.department.count({ where: { parentId: departmentId } }),
    ]);

    if (employees > 0) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: `в подразделении числится сотрудников: ${employees}; сначала переведите их`,
      });
    }
    if (children > 0) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: `у подразделения есть вложенные: ${children}; сначала перенесите их`,
      });
    }

    await this.prisma.department.delete({ where: { id: departmentId } });
    this.logger.log({ message: 'подразделение удалено', departmentId });
  }

  /**
   * Перевод сотрудников в подразделение.
   *
   * Событие на каждого переведённого, а не одно на команду: подписчики —
   * auth-service со своей проекцией оргструктуры, notification и
   * analytics — обрабатывают сотрудника поштучно, и групповое событие
   * заставило бы каждого из них разворачивать список самостоятельно.
   * Записи в outbox идут той же транзакцией, что и сам перевод.
   */
  async assignEmployees(
    departmentId: string,
    employeeIds: string[],
    context: RequestContext = getRequestContext(),
  ): Promise<number> {
    await this.getDepartment(departmentId);

    const unique = [...new Set(employeeIds.filter(Boolean))];
    if (unique.length === 0) return 0;

    const employees = await this.prisma.employee.findMany({
      where: { id: { in: unique } },
      select: { id: true, departmentId: true },
    });

    const missing = unique.filter((id) => !employees.some((employee) => employee.id === id));
    if (missing.length > 0) {
      throw new RpcException({
        code: GrpcStatus.NOT_FOUND,
        message: `сотрудники не найдены: ${missing.join(', ')}`,
      });
    }

    // Уже числящиеся в этом подразделении пропускаются: иначе перевод
    // отдела целиком порождал бы событие «изменён» на каждого, у кого
    // ничего не изменилось.
    const moving = employees.filter((employee) => employee.departmentId !== departmentId);
    if (moving.length === 0) return 0;

    await this.prisma.$transaction(async (tx) => {
      await tx.employee.updateMany({
        where: { id: { in: moving.map((employee) => employee.id) } },
        data: { departmentId },
      });

      for (const employee of moving) {
        const envelope = this.publisher.wrap<EmployeeUpdated>(
          HrEvents.EMPLOYEE_UPDATED,
          { employeeId: employee.id, changed: { departmentId } },
          context,
        );
        await tx.outbox.create({ data: outboxRow(envelope) });
      }
    });

    this.logger.log({
      message: 'сотрудники переведены',
      departmentId,
      moved: moving.length,
      requested: unique.length,
    });
    return moving.length;
  }
}
