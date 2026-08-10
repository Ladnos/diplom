import { AuthEvents, HrEvents, type EventType, type PayloadOf } from '@crm/contracts';
import type { ContactsService } from '../contacts/contacts.service';

/**
 * Каталог обновлений проекции контактов. docs/architecture.md §7.5
 *
 * Отделён от каталога правил намеренно и применяется ДО него: событие
 * hr.employee.created сначала создаёт контакт, и только потом по нему
 * можно кому-то что-то отправить. Смешать эти два занятия в одном
 * обработчике означало бы зависеть от порядка строк внутри функции —
 * и однажды его переставить.
 *
 * Здесь же видно, почему сервису вообще нужна своя копия: он обязан
 * уметь разослать уведомление в момент, когда hr-service недоступен, —
 * а это ровно тот момент, когда уведомления и нужны.
 */

export type ProjectionCatalog = {
  [K in EventType]?: (payload: PayloadOf<K>, contacts: ContactsService) => Promise<void>;
};

export const PROJECTIONS: ProjectionCatalog = {
  /** Первое, что система узнаёт о человеке: логин и адрес почты. */
  [AuthEvents.USER_REGISTERED]: async (payload, contacts) => {
    await contacts.upsertFromUser({
      userId: payload.userId,
      email: payload.email,
      roles: payload.roles,
    });
  },

  /**
   * Восстановление пароля. Контакт здесь тоже создаётся: письмо со
   * ссылкой обязано уйти даже если проекция пуста — например, сервис
   * уведомлений развернули позже остальных.
   */
  [AuthEvents.PASSWORD_RESET_REQUESTED]: async (payload, contacts) => {
    await contacts.ensureByEmail(payload.userId, payload.email);
  },

  [AuthEvents.ROLE_GRANTED]: async (payload, contacts) => {
    await contacts.changeRole(payload.userId, payload.roleCode, true);
  },

  [AuthEvents.ROLE_REVOKED]: async (payload, contacts) => {
    await contacts.changeRole(payload.userId, payload.roleCode, false);
  },

  /** Кадровая карточка заведена: появляются employeeId, ФИО, отдел, руководитель. */
  [HrEvents.EMPLOYEE_CREATED]: async (payload, contacts) => {
    await contacts.upsertFromEmployee({
      userId: payload.userId,
      employeeId: payload.employeeId,
      fullName: payload.fullName,
      departmentId: payload.departmentId,
      managerEmployeeId: payload.managerId,
      active: true,
    });
  },

  [HrEvents.EMPLOYEE_UPDATED]: async (payload, contacts) => {
    await contacts.patchByEmployee(payload.employeeId, {
      fullName: payload.changed.fullName,
      departmentId: payload.changed.departmentId,
      managerEmployeeId: payload.changed.managerId,
    });
  },

  /** Уволенный остаётся в таблице, но перестаёт быть адресатом. */
  [HrEvents.EMPLOYEE_DEACTIVATED]: async (payload, contacts) => {
    await contacts.setActiveByUser(payload.userId, false);
  },

  /**
   * Смена руководителя. Без этого «уведомить руководителя» продолжало бы
   * писать прежнему — тому, кто уже не отвечает за этого человека.
   */
  [HrEvents.HIERARCHY_CHANGED]: async (payload, contacts) => {
    await contacts.patchByEmployee(payload.employeeId, {
      managerEmployeeId: payload.newManagerId ?? null,
    });
  },
};

/** Есть ли обновление проекции для типа события. */
export function hasProjection(eventType: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROJECTIONS, eventType);
}
