import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Поддержание проекции оргструктуры внутри auth_db.
 *
 * auth-service обязан отвечать на вопрос «руководитель ли X для Y» за
 * единицы миллисекунд и не зависеть при этом от доступности hr-service:
 * иначе кадровый сервис становится точкой отказа всей авторизации.
 * Поэтому здесь живёт денормализованная копия дерева подчинения,
 * наполняемая событиями hr.employee.* и hr.hierarchy.changed.
 */
/**
 * Пустая строка → null для колонок типа UUID.
 *
 * Событие может прийти от издателя, который сериализует отсутствующую
 * ссылку как ''. Для PostgreSQL это некорректный UUID, вставка падает,
 * сообщение уходит в DLQ — и проекция оргструктуры молча отстаёт от
 * реальности, а вместе с ней ломаются проверки прав. Нормализация на
 * приёме дешевле, чем доверие ко всем будущим издателям.
 */
function nullableUuid(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === null || value.trim() === '' ? null : value;
}

@Injectable()
export class OrgProjectionService {
  private readonly logger = new Logger(OrgProjectionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async upsertEmployee(data: {
    employeeId: string;
    userId?: string | null;
    departmentId?: string | null;
    managerId?: string | null;
    active?: boolean;
  }): Promise<void> {
    await this.prisma.employeeRef.upsert({
      where: { employeeId: data.employeeId },
      create: {
        employeeId: data.employeeId,
        userId: nullableUuid(data.userId) ?? null,
        departmentId: nullableUuid(data.departmentId) ?? null,
        managerId: nullableUuid(data.managerId) ?? null,
        active: data.active ?? true,
      },
      update: {
        ...(data.userId !== undefined ? { userId: nullableUuid(data.userId) } : {}),
        ...(data.departmentId !== undefined
          ? { departmentId: nullableUuid(data.departmentId) }
          : {}),
        ...(data.managerId !== undefined ? { managerId: nullableUuid(data.managerId) } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
      },
    });

    // Связываем учётную запись с сотрудником: до этого момента у неё нет
    // положения в оргструктуре и работают только глобальные права.
    const userId = nullableUuid(data.userId);
    if (userId) {
      await this.prisma.user.updateMany({
        where: { id: userId, employeeId: null },
        data: { employeeId: data.employeeId },
      });
    }
  }

  async deactivateEmployee(employeeId: string): Promise<void> {
    await this.prisma.employeeRef.updateMany({
      where: { employeeId },
      data: { active: false, managerId: null },
    });
  }

  /**
   * Полный пересчёт транзитивного замыкания.
   *
   * Инкрементальное обновление поддерева выглядит эффективнее, но требует
   * аккуратной обработки переносов целых веток и легко расходится с
   * реальностью при пропущенном событии. При целевом размере организации
   * (~500 сотрудников) полный пересчёт занимает единицы миллисекунд, и
   * простота здесь важнее экономии: проекция самовосстанавливается на
   * любом событии об изменении иерархии.
   */
  async rebuildClosure(): Promise<number> {
    const employees = await this.prisma.employeeRef.findMany({
      where: { active: true },
      select: { employeeId: true, managerId: true },
    });

    const managerOf = new Map<string, string | null>();
    for (const employee of employees) {
      managerOf.set(employee.employeeId, employee.managerId);
    }

    const rows: { managerId: string; subordinateId: string; depth: number }[] = [];

    for (const employee of employees) {
      let current = managerOf.get(employee.employeeId) ?? null;
      let depth = 1;
      const visited = new Set<string>([employee.employeeId]);

      while (current && !visited.has(current)) {
        rows.push({ managerId: current, subordinateId: employee.employeeId, depth });
        visited.add(current);
        current = managerOf.get(current) ?? null;
        depth += 1;
      }

      if (current && visited.has(current)) {
        // Цикл в оргструктуре — данные некорректны, но обход обязан
        // завершиться, иначе один плохой импорт вешает авторизацию.
        this.logger.error({
          message: 'обнаружен цикл в оргструктуре, ветка обрезана',
          employeeId: employee.employeeId,
          at: current,
        });
      }
    }

    await this.prisma.$transaction([
      this.prisma.managerSubordinate.deleteMany({}),
      ...(rows.length > 0
        ? [this.prisma.managerSubordinate.createMany({ data: rows, skipDuplicates: true })]
        : []),
    ]);

    this.logger.log({ message: 'замыкание оргструктуры пересчитано', pairs: rows.length });
    return rows.length;
  }

  async setDelegation(data: {
    managerEmployeeId: string;
    delegateEmployeeId: string;
    from: Date;
    to: Date;
  }): Promise<void> {
    await this.prisma.approvalDelegation.create({
      data: {
        managerId: data.managerEmployeeId,
        delegateId: data.delegateEmployeeId,
        validFrom: data.from,
        validTo: data.to,
      },
    });
  }
}
