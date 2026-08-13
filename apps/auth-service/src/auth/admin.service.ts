import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import {
  AuthEvents,
  type RoleChanged,
  type UserBlocked,
  type UserUnblocked,
} from '@crm/contracts';
import { getRequestContext } from '@crm/common';
import { EventPublisher } from '@crm/messaging';
import { Prisma, type UserStatus } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { outboxRow } from '../prisma/outbox.store';

export const ADMIN_ROLE = 'ADMIN';
export const MANAGER_ROLE = 'MANAGER';

/**
 * Администрирование учётных записей и ролей.
 *
 * Каждая операция публикует событие в outbox — журнал аудита должен
 * отвечать на вопрос «кто и когда выдал это право», причём и для
 * автоматических изменений тоже.
 *
 * ЗАЩИТА ОТ ПОТЕРИ ДОСТУПА. Система с нулём администраторов не
 * восстанавливается через интерфейс — только правкой базы руками.
 * Поэтому три инварианта проверяются здесь, а не оставляются на
 * внимательность администратора:
 *   1. нельзя снять роль ADMIN с самого себя;
 *   2. нельзя снять роль ADMIN с последнего администратора;
 *   3. нельзя заблокировать себя или последнего администратора.
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: EventPublisher,
  ) {}

  // ── Чтение ───────────────────────────────────────────────────────────

  async listUsers(input: {
    query?: string;
    roleCode?: string;
    status?: string;
    limit: number;
    offset: number;
  }) {
    const where: Prisma.UserWhereInput = {
      ...(input.query ? { email: { contains: input.query, mode: 'insensitive' } } : {}),
      ...(input.roleCode ? { roles: { some: { roleCode: input.roleCode } } } : {}),
      ...(input.status ? { status: input.status as UserStatus } : {}),
    };

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        include: {
          roles: { select: { roleCode: true } },
          _count: { select: { sessions: { where: { revokedAt: null } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: input.limit,
        skip: input.offset,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      users: users.map((user) => ({
        userId: user.id,
        email: user.email,
        status: user.status,
        employeeId: user.employeeId ?? '',
        roles: user.roles.map((r) => r.roleCode),
        createdAt: user.createdAt.getTime(),
        activeSessions: user._count.sessions,
      })),
      total,
    };
  }

  async getUserDetails(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        roles: { include: { role: { select: { name: true } } } },
        _count: { select: { sessions: { where: { revokedAt: null } } } },
      },
    });
    if (!user) {
      throw new RpcException({
        code: GrpcStatus.NOT_FOUND,
        message: 'пользователь не найден',
      });
    }

    return {
      summary: {
        userId: user.id,
        email: user.email,
        status: user.status,
        employeeId: user.employeeId ?? '',
        roles: user.roles.map((r) => r.roleCode),
        createdAt: user.createdAt.getTime(),
        activeSessions: user._count.sessions,
      },
      grants: user.roles.map((grant) => ({
        roleCode: grant.roleCode,
        roleName: grant.role.name,
        auto: grant.auto,
        assignedBy: grant.assignedBy ?? '',
        assignedAt: grant.assignedAt.getTime(),
      })),
    };
  }

  async listRoles() {
    const roles = await this.prisma.role.findMany({
      include: {
        permissions: { select: { resource: true, action: true, scope: true } },
        _count: { select: { users: true } },
      },
      orderBy: { code: 'asc' },
    });

    return roles.map((role) => ({
      code: role.code,
      name: role.name,
      permissions: role.permissions,
      userCount: role._count.users,
    }));
  }

  async listSessions(userId: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userAgent: true,
        ip: true,
        createdAt: true,
        expiresAt: true,
      },
    });

    return sessions.map((session) => ({
      sessionId: session.id,
      userAgent: session.userAgent ?? '',
      ip: session.ip ?? '',
      createdAt: session.createdAt.getTime(),
      expiresAt: session.expiresAt.getTime(),
    }));
  }

  // ── Роли ─────────────────────────────────────────────────────────────

  async grantRole(input: { userId: string; roleCode: string; actorUserId: string }) {
    const [user, role] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: input.userId },
        select: { id: true, employeeId: true },
      }),
      this.prisma.role.findUnique({ where: { code: input.roleCode }, select: { code: true } }),
    ]);

    if (!user) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'пользователь не найден' });
    }
    if (!role) {
      throw new RpcException({
        code: GrpcStatus.NOT_FOUND,
        message: `роль ${input.roleCode} не существует`,
      });
    }

    const existing = await this.prisma.userRole.findUnique({
      where: { userId_roleCode: { userId: input.userId, roleCode: input.roleCode } },
    });
    if (existing && !existing.auto) {
      // Роль уже выдана человеком — повторная выдача ничего не меняет
      return this.getUserDetails(input.userId);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.upsert({
        where: { userId_roleCode: { userId: input.userId, roleCode: input.roleCode } },
        // Ручная выдача поверх автоматической «закрепляет» роль:
        // синхронизация оргструктуры её больше не снимет.
        create: {
          userId: input.userId,
          roleCode: input.roleCode,
          auto: false,
          assignedBy: input.actorUserId,
        },
        update: { auto: false, assignedBy: input.actorUserId, assignedAt: new Date() },
      });

      const envelope = this.publisher.wrap<RoleChanged>(
        AuthEvents.ROLE_GRANTED,
        {
          userId: input.userId,
          employeeId: user.employeeId ?? undefined,
          roleCode: input.roleCode,
          actorUserId: input.actorUserId,
          auto: false,
        },
        getRequestContext(),
      );
      await tx.outbox.create({ data: outboxRow(envelope) });
    });

    this.logger.log({
      message: 'роль выдана',
      userId: input.userId,
      roleCode: input.roleCode,
      by: input.actorUserId,
    });
    return this.getUserDetails(input.userId);
  }

  async revokeRole(input: { userId: string; roleCode: string; actorUserId: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, employeeId: true },
    });
    if (!user) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'пользователь не найден' });
    }

    if (input.roleCode === ADMIN_ROLE) {
      await this.assertAdminRemovable(input.userId, input.actorUserId);
    }

    const existing = await this.prisma.userRole.findUnique({
      where: { userId_roleCode: { userId: input.userId, roleCode: input.roleCode } },
    });
    if (!existing) return this.getUserDetails(input.userId);

    if (existing.auto) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message:
          `роль ${input.roleCode} выдана автоматически из оргструктуры и не снимается вручную; ` +
          'снимите с сотрудника подчинённых в кадровом модуле',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.delete({
        where: { userId_roleCode: { userId: input.userId, roleCode: input.roleCode } },
      });

      const envelope = this.publisher.wrap<RoleChanged>(
        AuthEvents.ROLE_REVOKED,
        {
          userId: input.userId,
          employeeId: user.employeeId ?? undefined,
          roleCode: input.roleCode,
          actorUserId: input.actorUserId,
          auto: false,
        },
        getRequestContext(),
      );
      await tx.outbox.create({ data: outboxRow(envelope) });
    });

    this.logger.log({
      message: 'роль отозвана',
      userId: input.userId,
      roleCode: input.roleCode,
      by: input.actorUserId,
    });
    return this.getUserDetails(input.userId);
  }

  // ── Блокировка ───────────────────────────────────────────────────────

  async blockUser(input: { userId: string; reason: string; actorUserId: string }) {
    if (input.userId === input.actorUserId) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'нельзя заблокировать собственную учётную запись',
      });
    }
    await this.assertAdminRemovable(input.userId, input.actorUserId, { operation: 'блокировка' });

    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, employeeId: true },
    });
    if (!user) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'пользователь не найден' });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: input.userId }, data: { status: 'BLOCKED' } });
      // Блокировка обязана обрывать доступ немедленно, а не по истечении
      // access-токена: иначе заблокированный сотрудник работает ещё
      // до пятнадцати минут.
      await tx.session.updateMany({
        where: { userId: input.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      const envelope = this.publisher.wrap<UserBlocked>(
        AuthEvents.USER_BLOCKED,
        {
          userId: input.userId,
          employeeId: user.employeeId ?? undefined,
          reason: input.reason,
          actorUserId: input.actorUserId,
        },
        getRequestContext(),
      );
      await tx.outbox.create({ data: outboxRow(envelope) });
    });

    this.logger.warn({
      message: 'учётная запись заблокирована',
      userId: input.userId,
      by: input.actorUserId,
      reason: input.reason,
    });
    return this.getUserDetails(input.userId);
  }

  async unblockUser(input: { userId: string; actorUserId: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, employeeId: true },
    });
    if (!user) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'пользователь не найден' });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: input.userId }, data: { status: 'ACTIVE' } });

      const envelope = this.publisher.wrap<UserUnblocked>(
        AuthEvents.USER_UNBLOCKED,
        {
          userId: input.userId,
          employeeId: user.employeeId ?? undefined,
          actorUserId: input.actorUserId,
        },
        getRequestContext(),
      );
      await tx.outbox.create({ data: outboxRow(envelope) });
    });

    return this.getUserDetails(input.userId);
  }

  async revokeUserSessions(input: { userId: string; reason: string; actorUserId: string }) {
    const result = await this.prisma.session.updateMany({
      where: { userId: input.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    this.logger.warn({
      message: 'сессии пользователя отозваны администратором',
      userId: input.userId,
      by: input.actorUserId,
      count: result.count,
    });
    return result.count;
  }

  // ── Инварианты доступа ───────────────────────────────────────────────

  /**
   * Проверяет, что операция не оставит систему без администратора и что
   * администратор не отбирает права у самого себя.
   *
   * Самоблокировка — самая частая причина «мы потеряли доступ к системе»
   * в самохостинге. Восстановление требует ручной правки базы, что для
   * пользователя продукта равносильно аварии.
   */
  private async assertAdminRemovable(
    userId: string,
    actorUserId: string,
    options: { operation?: string } = {},
  ): Promise<void> {
    const isAdmin = await this.prisma.userRole.findUnique({
      where: { userId_roleCode: { userId, roleCode: ADMIN_ROLE } },
      select: { userId: true },
    });
    if (!isAdmin) return;

    const operation = options.operation ?? 'снятие роли ADMIN';

    if (userId === actorUserId) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: `${operation}: нельзя лишить прав администратора самого себя — попросите другого администратора`,
      });
    }

    // Считаем администраторов, которые ОСТАНУТСЯ после операции, а не всех
    // активных. Иначе снятие роли с уже заблокированного администратора
    // отклонялось бы как «последний», хотя войти он всё равно не может
    // и на доступность системы не влияет.
    const remainingAdmins = await this.prisma.userRole.count({
      where: {
        roleCode: ADMIN_ROLE,
        userId: { not: userId },
        user: { status: 'ACTIVE' },
      },
    });
    if (remainingAdmins < 1) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: `${operation}: это последний активный администратор, система осталась бы без доступа`,
      });
    }
  }

  // ── Автоматическая роль руководителя ─────────────────────────────────

  /**
   * Синхронизирует роль MANAGER с оргструктурой.
   *
   * Вызывается после пересчёта дерева подчинения. Роль означает ровно
   * «у сотрудника есть подчинённые», поэтому выдавать её руками — значит
   * заводить второй источник истины, который неизбежно разойдётся
   * с первым. Ручные назначения (auto = false) не трогаются.
   */
  async syncManagerRoles(): Promise<{ granted: number; revoked: number }> {
    const managerEmployeeIds = await this.prisma.managerSubordinate.findMany({
      distinct: ['managerId'],
      select: { managerId: true },
    });
    const managerIds = managerEmployeeIds.map((row) => row.managerId);

    const shouldHave = managerIds.length
      ? await this.prisma.user.findMany({
          where: { employeeId: { in: managerIds } },
          select: { id: true, employeeId: true },
        })
      : [];
    const shouldHaveIds = new Set(shouldHave.map((user) => user.id));

    const currentAuto = await this.prisma.userRole.findMany({
      where: { roleCode: MANAGER_ROLE, auto: true },
      select: { userId: true },
    });
    const currentAutoIds = new Set(currentAuto.map((row) => row.userId));

    const toGrant = shouldHave.filter((user) => !currentAutoIds.has(user.id));
    const toRevoke = [...currentAutoIds].filter((id) => !shouldHaveIds.has(id));

    for (const user of toGrant) {
      // Уже выданную вручную роль перезаписывать нельзя: она переживёт
      // временное отсутствие подчинённых, что и было намерением админа.
      const existing = await this.prisma.userRole.findUnique({
        where: { userId_roleCode: { userId: user.id, roleCode: MANAGER_ROLE } },
        select: { auto: true },
      });
      if (existing) continue;

      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.userRole.create({
            data: { userId: user.id, roleCode: MANAGER_ROLE, auto: true },
          });
          const envelope = this.publisher.wrap<RoleChanged>(
            AuthEvents.ROLE_GRANTED,
            {
              userId: user.id,
              employeeId: user.employeeId ?? undefined,
              roleCode: MANAGER_ROLE,
              auto: true,
            },
            getRequestContext(),
          );
          await tx.outbox.create({ data: outboxRow(envelope) });
        });
      } catch (error) {
        // Проверка выше и вставка здесь не атомарны, а очередь читается с
        // prefetch 10: два кадровых события подряд синхронизируют роли
        // параллельно, оба видят «роли нет» и оба её создают. Проигравший
        // упирается в уникальный ключ.
        //
        // Это штатный исход гонки, а не сбой обработки: роль выдана, и
        // событие о выдаче опубликовал победитель. Без этой ветки
        // hr.employee.updated уходил в DLQ, а вместе с ним терялось и
        // обновление проекции отдела.
        if (!isUniqueViolation(error)) throw error;
        this.logger.debug({
          message: 'роль руководителя уже выдана параллельно',
          userId: user.id,
        });
      }
    }

    for (const userId of toRevoke) {
      await this.prisma.$transaction(async (tx) => {
        await tx.userRole.deleteMany({
          where: { userId, roleCode: MANAGER_ROLE, auto: true },
        });
        const envelope = this.publisher.wrap<RoleChanged>(
          AuthEvents.ROLE_REVOKED,
          { userId, roleCode: MANAGER_ROLE, auto: true },
          getRequestContext(),
        );
        await tx.outbox.create({ data: outboxRow(envelope) });
      });
    }

    if (toGrant.length || toRevoke.length) {
      this.logger.log({
        message: 'роли руководителей синхронизированы с оргструктурой',
        granted: toGrant.length,
        revoked: toRevoke.length,
      });
    }
    return { granted: toGrant.length, revoked: toRevoke.length };
  }
}

/** P2002 — нарушение уникального ключа. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
