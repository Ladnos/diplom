import { Injectable, Logger } from '@nestjs/common';
import type { Contact } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { HrContactsClient } from './hr-contacts.client';

/**
 * Проекция контактов и разрешение получателей (§7.5).
 *
 * Здесь два разных занятия, и они намеренно вместе: события наполняют
 * проекцию, правила уведомлений из неё читают. Разнести их — значит
 * получить два места, каждое из которых знает половину правды о том,
 * кто такой получатель.
 *
 * Все методы разрешения возвращают ТОЛЬКО активных: писать уволенному
 * или заблокированному не нужно, а фильтровать это в каждом правиле
 * означало бы рано или поздно забыть.
 */
@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hr: HrContactsClient,
  ) {}

  // ── Наполнение проекции ──────────────────────────────────────────────

  /**
   * Учётная запись создана. Первое, что мы вообще узнаём о человеке:
   * employeeId появится позже, когда hr-service заведёт карточку.
   */
  async upsertFromUser(input: {
    userId: string;
    email: string;
    roles?: string[];
  }): Promise<Contact> {
    return this.prisma.contact.upsert({
      where: { userId: input.userId },
      create: {
        userId: input.userId,
        email: input.email,
        roles: input.roles ?? [],
      },
      // Роли не перезаписываются пустым массивом: auth.user.registered
      // приходит один раз, а auth.role.granted — сколько угодно, и
      // повторная обработка регистрации не должна их обнулять.
      update: {
        email: input.email,
        ...(input.roles && input.roles.length > 0 ? { roles: input.roles } : {}),
      },
    });
  }

  /**
   * Кадровая карточка заведена или изменена.
   *
   * Ключ по-прежнему userId — он есть в payload hr.employee.created.
   * E-mail в этом событии не передаётся (§7.3), поэтому строка может
   * появиться с пустым адресом; его подставит fallback GetContacts
   * при первой же попытке что-то отправить.
   */
  async upsertFromEmployee(input: {
    userId: string;
    employeeId: string;
    fullName?: string;
    departmentId?: string;
    managerEmployeeId?: string;
    email?: string;
    active?: boolean;
  }): Promise<Contact> {
    const data = {
      employeeId: input.employeeId,
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
      ...(input.managerEmployeeId !== undefined
        ? { managerEmployeeId: input.managerEmployeeId }
        : {}),
      ...(input.email ? { email: input.email } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    };

    return this.prisma.contact.upsert({
      where: { userId: input.userId },
      create: { userId: input.userId, email: input.email ?? '', ...data },
      update: data,
    });
  }

  /** Точечное изменение по employeeId — событий с userId в payload меньше. */
  async patchByEmployee(
    employeeId: string,
    data: {
      fullName?: string;
      departmentId?: string;
      managerEmployeeId?: string | null;
      active?: boolean;
      timezone?: string;
    },
  ): Promise<void> {
    const result = await this.prisma.contact.updateMany({ where: { employeeId }, data });
    if (result.count === 0) {
      // Не ошибка: событие могло прийти раньше hr.employee.created или
      // относиться к сотруднику без учётной записи. Проекция дособерётся
      // при первой отправке через fallback.
      this.logger.debug({ message: 'контакт для обновления не найден', employeeId });
    }
  }

  async setActiveByUser(userId: string, active: boolean): Promise<void> {
    await this.prisma.contact.updateMany({ where: { userId }, data: { active } });
  }

  /** Роль выдана или снята. Список ролей — часть адресации уведомлений. */
  async changeRole(userId: string, roleCode: string, granted: boolean): Promise<void> {
    const contact = await this.prisma.contact.findUnique({
      where: { userId },
      select: { roles: true },
    });
    if (!contact) return;

    const roles = new Set(contact.roles);
    if (granted) roles.add(roleCode);
    else roles.delete(roleCode);

    await this.prisma.contact.update({ where: { userId }, data: { roles: [...roles] } });
  }

  // ── Разрешение получателей ───────────────────────────────────────────

  async byUserIds(userIds: string[]): Promise<Contact[]> {
    const unique = distinct(userIds);
    if (unique.length === 0) return [];
    return this.prisma.contact.findMany({ where: { userId: { in: unique }, active: true } });
  }

  /**
   * Контакты по идентификаторам сотрудников.
   *
   * Недостающие и потерявшие адрес добираются из hr-service и тут же
   * оседают в проекции: следующая отправка тому же человеку пойдёт уже
   * без синхронного вызова.
   */
  async byEmployeeIds(employeeIds: string[]): Promise<Contact[]> {
    const unique = distinct(employeeIds);
    if (unique.length === 0) return [];

    const found = await this.prisma.contact.findMany({ where: { employeeId: { in: unique } } });
    const complete = found.filter((contact) => contact.email !== '');

    const missing = unique.filter(
      (id) => !complete.some((contact) => contact.employeeId === id),
    );
    if (missing.length > 0) {
      const restored = await this.restoreFromHr(missing);
      complete.push(...restored);
    }

    return complete.filter((contact) => contact.active);
  }

  /** Руководители перечисленных сотрудников — «уведомить руководителя». */
  async managersOf(employeeIds: string[]): Promise<Contact[]> {
    const unique = distinct(employeeIds);
    if (unique.length === 0) return [];

    const employees = await this.prisma.contact.findMany({
      where: { employeeId: { in: unique } },
      select: { managerEmployeeId: true },
    });
    const managerIds = employees
      .map((employee) => employee.managerEmployeeId)
      .filter((id): id is string => id !== null);

    return this.byEmployeeIds(managerIds);
  }

  /** Носители роли: бухгалтерия при закрытии табеля, админ при нехватке места. */
  async byRoles(roleCodes: string[]): Promise<Contact[]> {
    const unique = distinct(roleCodes);
    if (unique.length === 0) return [];
    return this.prisma.contact.findMany({
      where: { active: true, roles: { hasSome: unique } },
    });
  }

  async byDepartments(departmentIds: string[]): Promise<Contact[]> {
    const unique = distinct(departmentIds);
    if (unique.length === 0) return [];
    return this.prisma.contact.findMany({
      where: { active: true, departmentId: { in: unique } },
    });
  }

  /** Все активные — рассылка на компанию (notification.broadcast). */
  async everyone(): Promise<Contact[]> {
    return this.prisma.contact.findMany({ where: { active: true } });
  }

  async byUserId(userId: string): Promise<Contact | null> {
    return this.prisma.contact.findUnique({ where: { userId } });
  }

  /**
   * Контакт для отправки по адресу из payload события.
   *
   * Нужен ровно там, где локальной проекции может не быть по построению:
   * приветственное письмо и сброс пароля адресованы человеку, которого
   * система только что увидела впервые.
   */
  async ensureByEmail(userId: string, email: string): Promise<Contact> {
    return this.upsertFromUser({ userId, email });
  }

  private async restoreFromHr(employeeIds: string[]): Promise<Contact[]> {
    const fetched = await this.hr.fetch(employeeIds);
    if (fetched.length === 0) return [];

    const restored: Contact[] = [];
    for (const contact of fetched) {
      restored.push(
        await this.upsertFromEmployee({
          userId: contact.userId,
          employeeId: contact.employeeId,
          fullName: contact.fullName,
          email: contact.email,
          active: contact.active,
        }),
      );
    }

    this.logger.log({
      message: 'проекция контактов дособрана из hr-service',
      requested: employeeIds.length,
      restored: restored.length,
    });
    return restored;
  }
}

function distinct(values: (string | undefined | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
