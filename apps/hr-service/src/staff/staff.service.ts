import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import {
  HrEvents,
  type EmployeeCreated,
  type EmployeeDeactivated,
  type EmployeeUpdated,
  type EmploymentChanged,
  type EmploymentSnapshot,
  type HierarchyChanged,
  type RequestContext,
} from '@crm/contracts';
import { getRequestContext } from '@crm/common';
import { EventPublisher } from '@crm/messaging';
import type { Employee, EmploymentContract, EmploymentType, PaymentForm, Prisma } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { outboxRow } from '../prisma/outbox.store';
import { derivePolicy } from './employment-policy';

/**
 * Тип найма по умолчанию.
 *
 * Соответствует основной массе сотрудников: трудовой договор с окладом,
 * учёт по норме графика. ГПХ и самозанятость оформляются явным переводом
 * через ChangeEmployment — молча завести исполнителю по договору подряда
 * график и табель нельзя (§3.3).
 */
const DEFAULT_EMPLOYMENT = {
  type: 'LABOR_CONTRACT' as EmploymentType,
  paymentForm: 'SALARY' as PaymentForm,
  rate: 1.0,
};

type EmployeeWithContract = Employee & { contracts: EmploymentContract[] };

@Injectable()
export class StaffService {
  private readonly logger = new Logger(StaffService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: EventPublisher,
  ) {}

  // ── Чтение ───────────────────────────────────────────────────────────

  async getEmployee(employeeId: string): Promise<EmployeeWithContract> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      include: { contracts: { orderBy: { validFrom: 'desc' }, take: 1 } },
    });
    if (!employee) {
      throw new RpcException({
        code: GrpcStatus.NOT_FOUND,
        message: `сотрудник ${employeeId} не найден`,
      });
    }
    return employee;
  }

  /** Батчевый метод против N+1: доска на 50 карточек — один вызов. */
  async getEmployeesBatch(ids: string[]): Promise<EmployeeWithContract[]> {
    if (ids.length === 0) return [];
    return this.prisma.employee.findMany({
      where: { id: { in: ids } },
      include: { contracts: { orderBy: { validFrom: 'desc' }, take: 1 } },
    });
  }

  async listByDepartment(
    departmentId: string,
    includeInactive: boolean,
  ): Promise<EmployeeWithContract[]> {
    return this.prisma.employee.findMany({
      where: { departmentId, ...(includeInactive ? {} : { active: true }) },
      include: { contracts: { orderBy: { validFrom: 'desc' }, take: 1 } },
      orderBy: { fullName: 'asc' },
    });
  }

  /** Цепочка руководителей снизу вверх — маршрут согласования (§10.3). */
  async getManagerChain(employeeId: string): Promise<EmployeeWithContract[]> {
    const chain: EmployeeWithContract[] = [];
    const visited = new Set<string>([employeeId]);

    let current = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { managerId: true },
    });

    while (current?.managerId && !visited.has(current.managerId)) {
      const manager = await this.prisma.employee.findUnique({
        where: { id: current.managerId },
        include: { contracts: { orderBy: { validFrom: 'desc' }, take: 1 } },
      });
      if (!manager) break;

      chain.push(manager);
      visited.add(manager.id);
      current = { managerId: manager.managerId };
    }

    return chain;
  }

  /** depth = 1 — прямые подчинённые, depth < 0 — всё дерево. */
  async getSubordinates(managerId: string, depth: number): Promise<EmployeeWithContract[]> {
    const collected: EmployeeWithContract[] = [];
    let frontier = [managerId];
    let level = 0;

    while (frontier.length > 0 && (depth < 0 || level < depth)) {
      const batch = await this.prisma.employee.findMany({
        where: { managerId: { in: frontier }, active: true },
        include: { contracts: { orderBy: { validFrom: 'desc' }, take: 1 } },
      });
      if (batch.length === 0) break;

      collected.push(...batch);
      frontier = batch.map((employee) => employee.id);
      level += 1;
    }

    return collected;
  }

  async isManagerOf(managerId: string, employeeId: string): Promise<boolean> {
    const visited = new Set<string>();
    let current = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { managerId: true },
    });

    while (current?.managerId && !visited.has(current.managerId)) {
      if (current.managerId === managerId) return true;
      visited.add(current.managerId);
      current = await this.prisma.employee.findUnique({
        where: { id: current.managerId },
        select: { managerId: true },
      });
    }
    return false;
  }

  async existsAndActive(employeeId: string): Promise<boolean> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { active: true },
    });
    return employee?.active === true;
  }

  async getContacts(ids: string[]): Promise<{ employeeId: string; email: string; phone: string }[]> {
    if (ids.length === 0) return [];
    const employees = await this.prisma.employee.findMany({
      where: { id: { in: ids } },
      select: { id: true, email: true, phone: true },
    });
    return employees.map((employee) => ({
      employeeId: employee.id,
      email: employee.email,
      phone: employee.phone ?? '',
    }));
  }

  async getEmploymentInfo(employeeId: string): Promise<EmploymentContract> {
    const contract = await this.prisma.employmentContract.findFirst({
      where: { employeeId },
      orderBy: { validFrom: 'desc' },
    });
    if (!contract) {
      throw new RpcException({
        code: GrpcStatus.NOT_FOUND,
        message: `у сотрудника ${employeeId} нет действующего договора`,
      });
    }
    return contract;
  }

  // ── Запись ───────────────────────────────────────────────────────────

  /**
   * Создание профиля по событию регистрации (§10.1).
   *
   * Идемпотентно по userId: повторная доставка auth.user.registered не
   * создаст второго сотрудника. Дедупликация по eventId это тоже
   * покрывает, но полагаться на один механизм в операции, которую нельзя
   * откатить, недостаточно.
   */
  async createFromRegistration(input: {
    userId: string;
    email: string;
    fullName: string;
  }): Promise<Employee | null> {
    const existing = await this.prisma.employee.findUnique({
      where: { userId: input.userId },
      select: { id: true },
    });
    if (existing) {
      this.logger.debug({ message: 'профиль уже создан, пропуск', userId: input.userId });
      return null;
    }

    return this.createEmployee(
      {
        userId: input.userId,
        email: input.email,
        fullName: input.fullName || input.email,
        ...DEFAULT_EMPLOYMENT,
      },
      getRequestContext(),
    );
  }

  async createEmployee(
    input: {
      userId: string;
      email: string;
      fullName: string;
      departmentId?: string;
      positionId?: string;
      managerId?: string;
      type?: EmploymentType;
      paymentForm?: PaymentForm;
      rate?: number;
      hiredAt?: string;
    },
    context: RequestContext = getRequestContext(),
  ): Promise<Employee> {
    const type = input.type ?? DEFAULT_EMPLOYMENT.type;
    const paymentForm = input.paymentForm ?? DEFAULT_EMPLOYMENT.paymentForm;
    const policy = derivePolicy(type, paymentForm);
    const validFrom = input.hiredAt ? new Date(input.hiredAt) : new Date();

    return this.prisma.$transaction(async (tx) => {
      const employee = await tx.employee.create({
        data: {
          userId: input.userId,
          email: input.email.trim().toLowerCase(),
          fullName: input.fullName,
          departmentId: input.departmentId ?? null,
          positionId: input.positionId ?? null,
          managerId: input.managerId ?? null,
          hiredAt: validFrom,
          contracts: {
            create: {
              type,
              paymentForm,
              policy,
              rate: input.rate ?? DEFAULT_EMPLOYMENT.rate,
              validFrom,
            },
          },
        },
      });

      const envelope = this.publisher.wrap<EmployeeCreated>(
        HrEvents.EMPLOYEE_CREATED,
        {
          employeeId: employee.id,
          userId: employee.userId,
          fullName: employee.fullName,
          departmentId: employee.departmentId ?? undefined,
          position: employee.positionId ?? undefined,
          managerId: employee.managerId ?? undefined,
          employment: { type, paymentForm, policy, rate: input.rate ?? 1 },
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      this.logger.log({
        message: 'создан профиль сотрудника',
        employeeId: employee.id,
        type,
        policy,
      });
      return employee;
    });
  }

  async updateEmployee(
    input: {
      employeeId: string;
      fullName?: string;
      departmentId?: string;
      positionId?: string;
      managerId?: string;
      avatarFileId?: string;
    },
    context: RequestContext = getRequestContext(),
  ): Promise<Employee> {
    const before = await this.getEmployee(input.employeeId);

    const changed: EmployeeUpdated['changed'] = {};
    const data: Prisma.EmployeeUpdateInput = {};

    if (input.fullName !== undefined && input.fullName !== before.fullName) {
      data.fullName = input.fullName;
      changed.fullName = input.fullName;
    }
    if (input.departmentId !== undefined && input.departmentId !== before.departmentId) {
      data.department = input.departmentId ? { connect: { id: input.departmentId } } : { disconnect: true };
      changed.departmentId = input.departmentId;
    }
    if (input.positionId !== undefined && input.positionId !== before.positionId) {
      data.position = input.positionId ? { connect: { id: input.positionId } } : { disconnect: true };
    }
    if (input.avatarFileId !== undefined && input.avatarFileId !== before.avatarFileId) {
      data.avatarFileId = input.avatarFileId;
      changed.avatarFileId = input.avatarFileId;
    }

    const managerChanged =
      input.managerId !== undefined && input.managerId !== before.managerId;
    if (managerChanged) {
      if (input.managerId === input.employeeId) {
        throw new RpcException({
          code: GrpcStatus.INVALID_ARGUMENT,
          message: 'сотрудник не может быть собственным руководителем',
        });
      }
      // Назначение подчинённого руководителем своего же начальника
      // замкнуло бы дерево в цикл, и обход иерархии перестал бы завершаться.
      if (input.managerId && (await this.isManagerOf(input.employeeId, input.managerId))) {
        throw new RpcException({
          code: GrpcStatus.FAILED_PRECONDITION,
          message: 'назначение создаёт цикл в оргструктуре',
        });
      }
      data.manager = input.managerId ? { connect: { id: input.managerId } } : { disconnect: true };
      changed.managerId = input.managerId;
    }

    if (Object.keys(data).length === 0) return before;

    return this.prisma.$transaction(async (tx) => {
      const employee = await tx.employee.update({ where: { id: input.employeeId }, data });

      const updated = this.publisher.wrap<EmployeeUpdated>(
        HrEvents.EMPLOYEE_UPDATED,
        { employeeId: employee.id, changed },
        context,
      );
      await tx.outbox.create({ data: outboxRow(updated) });

      // Смена руководителя — отдельное событие: по нему auth-service
      // перестраивает дерево подчинения и сбрасывает кэш прав, а
      // approval-service пересчитывает маршруты открытых заявок.
      if (managerChanged) {
        const hierarchy = this.publisher.wrap<HierarchyChanged>(
          HrEvents.HIERARCHY_CHANGED,
          {
            employeeId: employee.id,
            oldManagerId: before.managerId ?? undefined,
            newManagerId: employee.managerId ?? undefined,
          },
          context,
        );
        await tx.outbox.create({ data: outboxRow(hierarchy) });
      }

      return employee;
    });
  }

  /**
   * Перевод на другой тип найма (§10.5).
   *
   * Прежний договор закрывается датой, новый открывается — история
   * сохраняется, потому что расчёт закрытых периодов должен опираться
   * на условия, действовавшие тогда, а не на текущие.
   */
  async changeEmployment(
    input: {
      employeeId: string;
      type: EmploymentType;
      paymentForm: PaymentForm;
      rate?: number;
      validFrom?: string;
    },
    context: RequestContext = getRequestContext(),
  ): Promise<EmploymentContract> {
    const current = await this.getEmploymentInfo(input.employeeId);
    const policy = derivePolicy(input.type, input.paymentForm);
    const validFrom = input.validFrom ? new Date(input.validFrom) : new Date();

    const before: EmploymentSnapshot = {
      type: current.type,
      paymentForm: current.paymentForm,
      policy: current.policy,
      rate: Number(current.rate),
    };
    const after: EmploymentSnapshot = {
      type: input.type,
      paymentForm: input.paymentForm,
      policy,
      rate: input.rate ?? Number(current.rate),
    };

    return this.prisma.$transaction(async (tx) => {
      await tx.employmentContract.update({
        where: { id: current.id },
        data: { validTo: validFrom },
      });

      const contract = await tx.employmentContract.create({
        data: {
          employeeId: input.employeeId,
          type: input.type,
          paymentForm: input.paymentForm,
          policy,
          rate: after.rate,
          validFrom,
        },
      });

      const envelope = this.publisher.wrap<EmploymentChanged>(
        HrEvents.EMPLOYMENT_CHANGED,
        {
          employeeId: input.employeeId,
          before,
          after,
          validFrom: validFrom.toISOString().slice(0, 10),
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      this.logger.log({
        message: 'тип найма изменён',
        employeeId: input.employeeId,
        from: `${before.type}/${before.paymentForm}/${before.policy}`,
        to: `${after.type}/${after.paymentForm}/${after.policy}`,
      });
      return contract;
    });
  }

  /**
   * Увольнение (§10.6).
   *
   * Снятие с руководства подчинёнными — часть ТОЙ ЖЕ транзакции: оставить
   * дерево с ссылкой на уволенного значит сломать маршруты согласования.
   * Всё остальное (сессии, карточки, каналы) сервисы делают сами по
   * событию hr.employee.deactivated.
   */
  async deactivateEmployee(
    input: { employeeId: string; date?: string; reason?: string },
    context: RequestContext = getRequestContext(),
  ): Promise<Employee> {
    const employee = await this.getEmployee(input.employeeId);
    const firedAt = input.date ? new Date(input.date) : new Date();

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.employee.update({
        where: { id: input.employeeId },
        data: { active: false, firedAt, managerId: null },
      });

      // Подчинённые переходят к руководителю уволенного
      await tx.employee.updateMany({
        where: { managerId: input.employeeId },
        data: { managerId: employee.managerId },
      });

      const envelope = this.publisher.wrap<EmployeeDeactivated>(
        HrEvents.EMPLOYEE_DEACTIVATED,
        {
          employeeId: updated.id,
          userId: updated.userId,
          date: firedAt.toISOString().slice(0, 10),
          reason: input.reason ?? '',
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      this.logger.log({ message: 'сотрудник уволен', employeeId: updated.id });
      return updated;
    });
  }
}
