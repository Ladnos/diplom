import { Injectable, Logger } from '@nestjs/common';
import { PermissionScope } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Проверка прав со scope. docs/architecture.md ADR-3 (часть 2), §6.2
 *
 * Право описывается тройкой «роль → ресурс+действие → область действия».
 * Область — главное отличие от плоского RBAC: руководитель утверждает
 * заявки не вообще, а только своих подчинённых, и это проверяется здесь,
 * а не в каждом доменном сервисе по-своему.
 *
 * Ключевой момент: широкая область НЕ включает узкую автоматически.
 * Грант SUBORDINATE не даёт права на собственные объекты — именно поэтому
 * руководитель не может утвердить свой отпуск сам.
 */

export interface PermissionRequest {
  userId: string;
  resource: string;
  action: string;
  resourceId?: string;
  /** employeeId владельца ресурса. Без него вернётся широчайший грант. */
  ownerId?: string;
}

export interface PermissionDecision {
  allowed: boolean;
  reason: string;
  scope: PermissionScope | 'SCOPE_UNSPECIFIED';
}

/** Порядок «широты» области — нужен, чтобы выбрать максимальный грант. */
const SCOPE_WIDTH: Record<PermissionScope, number> = {
  SELF: 1,
  SUBORDINATE: 2,
  DEPARTMENT: 3,
  GLOBAL: 4,
};

@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async check(request: PermissionRequest): Promise<PermissionDecision> {
    const user = await this.prisma.user.findUnique({
      where: { id: request.userId },
      select: { id: true, status: true, employeeId: true, roles: { select: { roleCode: true } } },
    });

    if (!user) {
      return { allowed: false, reason: 'пользователь не найден', scope: 'SCOPE_UNSPECIFIED' };
    }
    if (user.status === 'BLOCKED') {
      return { allowed: false, reason: 'учётная запись заблокирована', scope: 'SCOPE_UNSPECIFIED' };
    }

    const roleCodes = user.roles.map((r) => r.roleCode);
    if (roleCodes.length === 0) {
      return { allowed: false, reason: 'у пользователя нет ролей', scope: 'SCOPE_UNSPECIFIED' };
    }

    // '*' в ресурсе или действии — грант администратора
    const grants = await this.prisma.rolePermission.findMany({
      where: {
        roleCode: { in: roleCodes },
        AND: [
          { OR: [{ resource: request.resource }, { resource: '*' }] },
          { OR: [{ action: request.action }, { action: '*' }] },
        ],
      },
      select: { scope: true },
    });

    if (grants.length === 0) {
      return {
        allowed: false,
        reason: `нет права ${request.action} на ${request.resource}`,
        scope: 'SCOPE_UNSPECIFIED',
      };
    }

    const scopes = [...new Set(grants.map((g) => g.scope))].sort(
      (a, b) => SCOPE_WIDTH[b] - SCOPE_WIDTH[a],
    );

    // Владелец не указан: вопрос «есть ли право в принципе». Возвращаем
    // самый широкий грант, чтобы вызывающий сервис сам ограничил выборку
    // (например, показал только карточки своего отдела).
    if (!request.ownerId) {
      return { allowed: true, reason: 'право есть, область не проверялась', scope: scopes[0] };
    }

    for (const scope of scopes) {
      if (await this.scopeCovers(scope, user.employeeId, request.ownerId)) {
        return { allowed: true, reason: 'разрешено', scope };
      }
    }

    return {
      allowed: false,
      reason: `объект вне области действия (есть ${scopes.join(', ')})`,
      scope: 'SCOPE_UNSPECIFIED',
    };
  }

  /** Покрывает ли область действия конкретного владельца объекта. */
  private async scopeCovers(
    scope: PermissionScope,
    actorEmployeeId: string | null,
    ownerEmployeeId: string,
  ): Promise<boolean> {
    if (scope === 'GLOBAL') return true;

    // Все остальные области опираются на положение в оргструктуре.
    // Пока hr-service не создал профиль, такой пользователь никого,
    // кроме глобальных прав, не получает.
    if (!actorEmployeeId) return false;

    switch (scope) {
      case 'SELF':
        return actorEmployeeId === ownerEmployeeId;

      case 'SUBORDINATE':
        return this.isManagerOf(actorEmployeeId, ownerEmployeeId);

      case 'DEPARTMENT': {
        const [actor, owner] = await Promise.all([
          this.prisma.employeeRef.findUnique({
            where: { employeeId: actorEmployeeId },
            select: { departmentId: true },
          }),
          this.prisma.employeeRef.findUnique({
            where: { employeeId: ownerEmployeeId },
            select: { departmentId: true },
          }),
        ]);
        return (
          actor?.departmentId != null && actor.departmentId === owner?.departmentId
        );
      }

      default:
        return false;
    }
  }

  /**
   * Руководит ли сотрудник другим — напрямую или через цепочку.
   *
   * Плюс делегирование: на время отпуска руководитель передаёт право
   * согласования заместителю, и тот получает доступ к его подчинённым,
   * не становясь их руководителем в оргструктуре.
   */
  async isManagerOf(managerEmployeeId: string, subordinateEmployeeId: string): Promise<boolean> {
    const direct = await this.prisma.managerSubordinate.findUnique({
      where: {
        managerId_subordinateId: {
          managerId: managerEmployeeId,
          subordinateId: subordinateEmployeeId,
        },
      },
      select: { depth: true },
    });
    if (direct) return true;

    const now = new Date();
    const delegations = await this.prisma.approvalDelegation.findMany({
      where: {
        delegateId: managerEmployeeId,
        validFrom: { lte: now },
        validTo: { gte: now },
      },
      select: { managerId: true },
    });
    if (delegations.length === 0) return false;

    const viaDelegation = await this.prisma.managerSubordinate.findFirst({
      where: {
        managerId: { in: delegations.map((d) => d.managerId) },
        subordinateId: subordinateEmployeeId,
      },
      select: { managerId: true },
    });
    return viaDelegation !== null;
  }

  /** Есть ли хотя бы один подчинённый — попадает в claim токена. */
  async hasSubordinates(employeeId: string | null): Promise<boolean> {
    if (!employeeId) return false;
    const count = await this.prisma.managerSubordinate.count({
      where: { managerId: employeeId },
    });
    return count > 0;
  }
}
