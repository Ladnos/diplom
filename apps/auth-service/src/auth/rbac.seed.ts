import { Injectable, Logger } from '@nestjs/common';
import { PermissionScope } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Роли и матрица прав. docs/architecture.md ADR-3 (часть 2)
 *
 * Матрица лежит в коде, а не в админке: это часть контракта системы, её
 * изменение должно проходить ревью и попадать в историю git, а не
 * применяться кликом в интерфейсе. Раздача ролей пользователям — наоборот,
 * операционная задача и живёт в данных.
 *
 * Роли складываются. Руководитель получает MANAGER В ДОПОЛНЕНИЕ к EMPLOYEE,
 * и его права — объединение обоих наборов.
 */

interface Grant {
  resource: string;
  action: string;
  scope: PermissionScope;
}

const ROLES: { code: string; name: string; grants: Grant[] }[] = [
  {
    code: 'EMPLOYEE',
    name: 'Сотрудник',
    grants: [
      // Коллег по отделу видно, чтобы работали доски, чат и упоминания
      { resource: 'employee', action: 'read', scope: 'DEPARTMENT' },
      { resource: 'employee', action: 'write', scope: 'SELF' },
      { resource: 'shift', action: 'read', scope: 'SELF' },
      { resource: 'absence', action: 'read', scope: 'SELF' },
      { resource: 'timesheet', action: 'read', scope: 'SELF' },
      { resource: 'request', action: 'create', scope: 'SELF' },
      { resource: 'request', action: 'read', scope: 'SELF' },
      { resource: 'request', action: 'cancel', scope: 'SELF' },
      { resource: 'board', action: 'read', scope: 'DEPARTMENT' },
      { resource: 'card', action: 'write', scope: 'DEPARTMENT' },
      { resource: 'channel', action: 'read', scope: 'DEPARTMENT' },
      { resource: 'channel', action: 'write', scope: 'DEPARTMENT' },
      { resource: 'file', action: 'read', scope: 'SELF' },
      { resource: 'file', action: 'write', scope: 'SELF' },
      // Производственный календарь виден всем: по нему сотрудник
      // понимает, какие дни рабочие и почему пятница короче.
      { resource: 'calendar', action: 'read', scope: 'GLOBAL' },
      // Уведомления и настройки подписок — всегда только свои. Область
      // SELF здесь не ограничение выборки, а утверждение: операции
      // «прочитать чужие уведомления» в системе не существует, адресат
      // берётся из токена и в запрос не передаётся.
      { resource: 'notification', action: 'read', scope: 'SELF' },
      { resource: 'notification', action: 'write', scope: 'SELF' },
      // Звонки. Область SELF означает «свои звонки»: кто в них участник,
      // решает не RBAC, а состав комнаты в video-service — как участие в
      // доске и в канале. Право здесь отвечает лишь на вопрос, может ли
      // человек звонить вообще.
      { resource: 'call', action: 'read', scope: 'SELF' },
      { resource: 'call', action: 'write', scope: 'SELF' },
    ],
  },
  {
    code: 'MANAGER',
    name: 'Руководитель',
    grants: [
      { resource: 'employee', action: 'read', scope: 'SUBORDINATE' },
      { resource: 'shift', action: 'write', scope: 'SUBORDINATE' },
      { resource: 'absence', action: 'read', scope: 'SUBORDINATE' },
      { resource: 'timesheet', action: 'read', scope: 'SUBORDINATE' },
      // Ключевой грант: утверждать заявки ПОДЧИНЁННЫХ. Область
      // SUBORDINATE не покрывает собственные объекты, поэтому
      // руководитель не может утвердить свой отпуск сам.
      { resource: 'request', action: 'approve', scope: 'SUBORDINATE' },
      { resource: 'request', action: 'read', scope: 'SUBORDINATE' },
      { resource: 'report', action: 'read', scope: 'SUBORDINATE' },
      { resource: 'card', action: 'write', scope: 'SUBORDINATE' },
    ],
  },
  {
    code: 'HR',
    name: 'Кадровая служба',
    grants: [
      { resource: 'employee', action: 'read', scope: 'GLOBAL' },
      { resource: 'employee', action: 'write', scope: 'GLOBAL' },
      { resource: 'employment', action: 'write', scope: 'GLOBAL' },
      { resource: 'shift', action: 'write', scope: 'GLOBAL' },
      { resource: 'absence', action: 'write', scope: 'GLOBAL' },
      { resource: 'timesheet', action: 'read', scope: 'GLOBAL' },
      { resource: 'timesheet', action: 'write', scope: 'GLOBAL' },
      { resource: 'request', action: 'approve', scope: 'GLOBAL' },
      { resource: 'request', action: 'read', scope: 'GLOBAL' },
      { resource: 'report', action: 'read', scope: 'GLOBAL' },
      // Правка производственного календаря: переносы выходных
      // устанавливаются постановлением и вводятся кадровой службой.
      { resource: 'calendar', action: 'write', scope: 'GLOBAL' },
    ],
  },
  {
    code: 'ADMIN',
    name: 'Администратор системы',
    // '*' сопоставляется с любым ресурсом и действием в PermissionService
    grants: [{ resource: '*', action: '*', scope: 'GLOBAL' }],
  },
];

@Injectable()
export class RbacSeed {
  private readonly logger = new Logger(RbacSeed.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Идемпотентно приводит роли и гранты в БД к состоянию из кода. */
  async sync(): Promise<void> {
    for (const role of ROLES) {
      await this.prisma.role.upsert({
        where: { code: role.code },
        create: { code: role.code, name: role.name },
        update: { name: role.name },
      });

      for (const grant of role.grants) {
        await this.prisma.rolePermission.upsert({
          where: {
            roleCode_resource_action: {
              roleCode: role.code,
              resource: grant.resource,
              action: grant.action,
            },
          },
          create: { roleCode: role.code, ...grant },
          update: { scope: grant.scope },
        });
      }

      // Гранты, удалённые из кода, убираются и из БД — иначе отозванное
      // право продолжало бы действовать до ручной чистки.
      await this.prisma.rolePermission.deleteMany({
        where: {
          roleCode: role.code,
          NOT: role.grants.map((g) => ({ resource: g.resource, action: g.action })),
        },
      });
    }

    const total = ROLES.reduce((sum, role) => sum + role.grants.length, 0);
    this.logger.log({ message: 'матрица прав синхронизирована', roles: ROLES.length, grants: total });
  }
}
