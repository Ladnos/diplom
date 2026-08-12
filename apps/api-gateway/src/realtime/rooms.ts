import type { AuthenticatedUser } from '../auth/auth.guard';

/**
 * Комнаты WebSocket. docs/architecture.md §8.1
 *
 * Комната — единица адресации: доменное событие раскладывается по комнатам,
 * и сокет получает только то, на что подписан. Имя комнаты строится из
 * префикса и идентификатора, поэтому одно и то же событие адресуется
 * одинаково на любом инстансе gateway, без общего состояния между ними.
 *
 * ДВЕ ЛИЧНЫЕ КОМНАТЫ, А НЕ ОДНА. Доменные события несут employeeId —
 * идентификатор карточки сотрудника, а лента уведомлений и права
 * принадлежат учётной записи с userId. Это разные идентификаторы, и у
 * части пользователей (администратор без карточки) employeeId нет вовсе.
 * Сокет знает оба, потому что оба лежат в claims токена, — поэтому он
 * входит сразу в две личные комнаты, и проекция «userId ↔ employeeId»
 * на стороне gateway не нужна.
 */
export const Rooms = {
  user: (userId: string) => `user:${userId}`,
  employee: (employeeId: string) => `employee:${employeeId}`,
  board: (boardId: string) => `board:${boardId}`,
  channel: (channelId: string) => `channel:${channelId}`,
  /** Лента руководителя: события по его подчинённым. */
  team: (managerEmployeeId: string) => `team:${managerEmployeeId}`,
  department: (departmentId: string) => `department:${departmentId}`,
  /**
   * Присутствие КОНКРЕТНОГО сотрудника, а не общий реестр онлайна.
   *
   * Одна комната на всех была бы проще, но раздавала бы каждому
   * подписчику активность всей компании — в обход `employee:read` со
   *scope DEPARTMENT, который прямо ограничивает сотрудника его отделом.
   * Проверять же право на каждого участника при каждом изменении
   * присутствия — это запрос в auth-service на пару «получатель ×
   * событие».
   *
   * Адресная комната переносит проверку на момент подписки, где она
   * делается один раз и с указанием владельца: клиент подписывается на
   * тех, кого показывает (собеседники, участники доски), и получает
   * ровно их.
   */
  presence: (employeeId: string) => `presence:${employeeId}`,
} as const;

/** Максимум комнат на соединение: защита от клиента, подписавшегося на всё. */
export const MAX_ROOMS_PER_SOCKET = 200;

/**
 * Кто решает, пускать ли соединение в комнату.
 *
 * Три разных ответа, и разница между ними принципиальна.
 *
 * `own` — комната самого пользователя. Спрашивать не у кого: она задана
 * его же токеном.
 *
 * `permission` — вопрос уходит в auth-service. Годится там, где доступ
 * определяется положением человека в оргструктуре: свой отдел, свои
 * подчинённые, коллеги в реестре присутствия.
 *
 * `membership` — вопрос уходит СЕРВИСУ-ВЛАДЕЛЬЦУ объекта. Права в
 * auth-service отвечают, может ли человек работать с досками вообще; на
 * вопрос про КОНКРЕТНУЮ доску отвечает только список её участников, и
 * живёт он в task-service (board.service.ts, assertMember). Проверки
 * одним auth-service здесь мало: без владельца объекта он возвращает
 * «право есть, область не проверялась», и любой сотрудник, знающий
 * идентификатор чужой доски, читал бы её изменения в реальном времени.
 */
export type RoomAccess =
  | { kind: 'own'; allowed: boolean }
  | { kind: 'permission'; resource: string; action: string; ownerId?: string }
  | { kind: 'membership'; authority: MembershipAuthority; id: string }
  | { kind: 'rejected'; reason: string };

/** Сервис, владеющий составом участников объекта. */
export type MembershipAuthority = 'task' | 'chat';

/**
 * Идентификаторы приходят от клиента, поэтому проверяются до того, как
 * попадут в запрос к доменному сервису.
 *
 * Условие именно UUID, а не «безопасные символы»: все идентификаторы в
 * системе — UUID, и строка вроде `board:brd-1` доходила бы до Prisma,
 * который отвечает на неё «Inconsistent column data» и записью уровня
 * ERROR в журнал task-service. Клиентский мусор не должен выглядеть как
 * сбой сервиса — отказ обязан случиться здесь и называться отказом.
 */
const ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Правило доступа к комнате.
 *
 * Разбор и проверка разделены намеренно: здесь только решение, КАКОЙ вопрос
 * задать, а сам вызов auth-service делает шлюз. Так правило можно прочитать
 * целиком в одном месте и убедиться, что незакрытых префиксов не осталось.
 */
export function accessRuleFor(room: string, user: AuthenticatedUser): RoomAccess {
  const separator = room.indexOf(':');
  if (separator <= 0) return { kind: 'rejected', reason: 'имя комнаты без префикса' };

  const prefix = room.slice(0, separator);
  const id = room.slice(separator + 1);
  if (!ID_PATTERN.test(id)) {
    return { kind: 'rejected', reason: 'недопустимый идентификатор в имени комнаты' };
  }

  switch (prefix) {
    case 'user':
      return { kind: 'own', allowed: id === user.userId };

    case 'employee':
      return { kind: 'own', allowed: !!user.employeeId && id === user.employeeId };

    case 'board':
      return { kind: 'membership', authority: 'task', id };

    case 'channel':
      return { kind: 'membership', authority: 'chat', id };

    case 'team':
      // ownerId — руководитель, чью ленту просят. auth-service сам решит:
      // себе можно по SELF, чужую команду увидит только обладатель
      // SUBORDINATE или GLOBAL.
      return { kind: 'permission', resource: 'employee', action: 'read', ownerId: id };

    case 'presence':
      // Тот же вопрос, что и о карточке сотрудника: кто не видит человека
      // в оргструктуре, тому нечего знать и о его активности. Владелец
      // указан явно, поэтому auth-service проверит именно область
      // действия, а не только наличие права.
      return { kind: 'permission', resource: 'employee', action: 'read', ownerId: id };

    case 'department':
      return { kind: 'permission', resource: 'timesheet', action: 'read' };

    default:
      return { kind: 'rejected', reason: `неизвестный тип комнаты «${prefix}»` };
  }
}

/** Личные комнаты, в которые соединение входит сразу после рукопожатия. */
export function personalRooms(user: AuthenticatedUser): string[] {
  const rooms = [Rooms.user(user.userId)];
  if (user.employeeId) rooms.push(Rooms.employee(user.employeeId));
  return rooms;
}
