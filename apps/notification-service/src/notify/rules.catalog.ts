import {
  ApprovalEvents,
  AuthEvents,
  ChatEvents,
  FileEvents,
  HrEvents,
  TaskEvents,
  VideoEvents,
  type EventType,
  type NotificationChannel,
  type NotificationPriority,
  type PayloadOf,
} from '@crm/contracts';
import type { Contact } from '../../generated/prisma';
import type { ContactsService } from '../contacts/contacts.service';
import type { PresenceService } from '../contacts/presence.service';
import {
  Links,
  absenceTitle,
  employmentTitle,
  formatBytes,
  formatDate,
  formatMinutes,
  formatPeriod,
  formatTime,
  plural,
  requestTitle,
  roleTitle,
  truncate,
} from './templates';

/**
 * Каталог правил «событие → уведомление». docs/architecture.md §7.3
 *
 * Сервис подписан на ВЕСЬ поток системы (auth.# hr.# approval.# task.#
 * chat.# video.# file.#), но уведомлением становится не всякое событие.
 * Отсутствие правила — нормальный исход: task.card.moved нужен доске и
 * аналитике, а человеку сообщать не о чем.
 *
 * Правило возвращает список адресованных черновиков, а не «получателей и
 * текст» по отдельности, потому что одно событие часто порождает разные
 * тексты разным людям: сотруднику «ваша задача просрочена», руководителю
 * «задача сотрудника просрочена». Разделение получателей и шаблона
 * заставило бы каждое такое правило ветвиться внутри рендера, где о
 * получателе уже ничего не известно.
 */

export interface NotificationDraft {
  title: string;
  body: string;
  /** Путь в интерфейсе. Абсолютный адрес соберёт канал доставки. */
  link?: string;
  priority?: NotificationPriority;
  channels?: NotificationChannel[];
}

export interface Addressed {
  userIds: string[];
  draft: NotificationDraft;
}

export interface RuleContext {
  contacts: ContactsService;
  presence: PresenceService;
}

export type RuleFn<T> = (payload: T, context: RuleContext) => Promise<Addressed[]>;

export type RuleCatalog = {
  [K in EventType]?: RuleFn<PayloadOf<K>>;
};

// ── Наборы каналов ───────────────────────────────────────────────────────
//
// Набор задаётся правилом, а не типом события: он выражает срочность.
// Настройки пользователя потом только сужают этот набор — включить канал,
// который правило не предполагало, они не могут.

/** Видно в интерфейсе, но не дёргает. Фон: изменения, о которых полезно знать. */
const IN_APP: NotificationChannel[] = ['IN_APP'];
/** Требует внимания сейчас, но не срочно настолько, чтобы писать письмо. */
const REALTIME: NotificationChannel[] = ['IN_APP', 'WEB_PUSH'];
/** Пропустить нельзя: письмо остаётся, даже если push не дошёл. */
const IMPORTANT: NotificationChannel[] = ['IN_APP', 'WEB_PUSH', 'EMAIL'];
/** Только почта: адресат может быть не в системе — или как раз не может в неё войти. */
const EMAIL: NotificationChannel[] = ['EMAIL'];
/** Только push: сообщение чата в in-app списке превратило бы его в второй чат. */
const PUSH: NotificationChannel[] = ['WEB_PUSH'];

// ── Помощники ────────────────────────────────────────────────────────────

const NONE: Addressed[] = [];

function to(recipients: Contact[], draft: NotificationDraft): Addressed[] {
  if (recipients.length === 0) return NONE;
  return [{ userIds: recipients.map((contact) => contact.userId), draft }];
}

/**
 * Исключение инициатора.
 *
 * Уведомление о собственном действии — самый частый способ приучить
 * пользователя не читать уведомления вообще.
 */
function except(recipients: Contact[], employeeId?: string): Contact[] {
  if (!employeeId) return recipients;
  return recipients.filter((contact) => contact.employeeId !== employeeId);
}

function nameOf(contacts: Contact[], employeeId?: string): string {
  const found = contacts.find((contact) => contact.employeeId === employeeId);
  return found?.fullName || 'сотрудник';
}

// ── Каталог ──────────────────────────────────────────────────────────────

export const RULES: RuleCatalog = {
  // ── Аутентификация ────────────────────────────────────────────────────

  /**
   * Приветственное письмо. Только почта: in-app уведомление увидит тот,
   * кто уже вошёл, а вошедшему рассказывать о создании учётной записи
   * поздно.
   */
  [AuthEvents.USER_REGISTERED]: async (payload, ctx) => {
    const recipients = await ctx.contacts.byUserIds([payload.userId]);
    return to(recipients, {
      title: 'Учётная запись в CRM создана',
      body:
        `Вход выполняется по адресу ${payload.email}.\n` +
        'Кадровая служба заполнит профиль — после этого станут доступны график работы, ' +
        'табель и подача заявок.',
      channels: EMAIL,
    });
  },

  /**
   * Сброс пароля. URGENT не ради важности, а ради тихих часов: ссылка
   * живёт минуты, и отложенное до утра письмо приходит уже мёртвым.
   */
  [AuthEvents.PASSWORD_RESET_REQUESTED]: async (payload, ctx) => {
    const recipients = await ctx.contacts.byUserIds([payload.userId]);
    const minutes = Math.max(1, Math.round(payload.ttlSeconds / 60));
    return to(recipients, {
      title: 'Восстановление пароля',
      body:
        `Ссылка действует ${plural(minutes, 'минуту', 'минуты', 'минут')}.\n` +
        'Если вы не запрашивали смену пароля, письмо можно проигнорировать: ' +
        'пароль останется прежним.',
      link: Links.passwordReset(payload.token),
      priority: 'URGENT',
      channels: EMAIL,
    });
  },

  [AuthEvents.SESSION_SUSPICIOUS]: async (payload, ctx) => {
    const recipients = await ctx.contacts.byUserIds([payload.userId]);
    return to(recipients, {
      title: 'Подозрительный вход в систему',
      body:
        `Причина: ${payload.reason}.\nАдрес: ${payload.ip}\nУстройство: ${truncate(payload.userAgent, 80)}\n\n` +
        'Если это были не вы — смените пароль и завершите остальные сеансы.',
      link: Links.security(),
      priority: 'URGENT',
      channels: IMPORTANT,
    });
  },

  /**
   * Выдача роли. Автоматическая выдача MANAGER (появился подчинённый)
   * уведомляется только в интерфейсе: письмо о том, что произошло само
   * собой, читать некому.
   */
  [AuthEvents.ROLE_GRANTED]: async (payload, ctx) => {
    const recipients = await ctx.contacts.byUserIds([payload.userId]);
    return to(recipients, {
      title: `Вам выдана роль «${roleTitle(payload.roleCode)}»`,
      body: payload.auto
        ? 'Роль назначена автоматически по вашему положению в оргструктуре: ' +
          'у вас появились подчинённые. Вместе с ней появилось право согласовывать их заявки.'
        : 'Роль назначена администратором. Набор доступных разделов изменится ' +
          'при следующем входе.',
      channels: payload.auto ? IN_APP : IMPORTANT,
    });
  },

  [AuthEvents.ROLE_REVOKED]: async (payload, ctx) => {
    const recipients = await ctx.contacts.byUserIds([payload.userId]);
    return to(recipients, {
      title: `Роль «${roleTitle(payload.roleCode)}» снята`,
      body: payload.auto
        ? 'Роль снята автоматически: подчинённых в оргструктуре за вами больше не числится.'
        : 'Роль снята администратором. Часть разделов станет недоступна.',
      channels: payload.auto ? IN_APP : IMPORTANT,
    });
  },

  /**
   * Блокировка. Контакт при этом НЕ снимается с рассылки: заблокированный
   * не может войти в систему, и единственный способ сообщить ему о
   * блокировке и о её снятии — письмо.
   */
  [AuthEvents.USER_BLOCKED]: async (payload, ctx) => {
    const [user, managers] = await Promise.all([
      ctx.contacts.byUserIds([payload.userId]),
      payload.employeeId ? ctx.contacts.managersOf([payload.employeeId]) : Promise.resolve([]),
    ]);

    return [
      ...to(user, {
        title: 'Доступ к системе заблокирован',
        body: `Причина: ${payload.reason}.\nЗа разъяснениями обратитесь к руководителю или в кадровую службу.`,
        priority: 'HIGH',
        channels: IMPORTANT,
      }),
      ...to(managers, {
        title: `Доступ сотрудника заблокирован: ${nameOf(user, payload.employeeId) || 'сотрудник'}`,
        body: `Причина: ${payload.reason}.`,
        channels: IN_APP,
      }),
    ];
  },

  [AuthEvents.USER_UNBLOCKED]: async (payload, ctx) => {
    const recipients = await ctx.contacts.byUserIds([payload.userId]);
    return to(recipients, {
      title: 'Доступ к системе восстановлен',
      body: 'Блокировка снята, вход снова доступен.',
      channels: IMPORTANT,
    });
  },

  // ── Персонал ──────────────────────────────────────────────────────────

  /**
   * Увольнение. Уведомляется руководитель, а не сам уволенный: ему
   * система уже ничего не должна, а руководителю нужно перераспределить
   * задачи и снять доступы.
   */
  [HrEvents.EMPLOYEE_DEACTIVATED]: async (payload, ctx) => {
    const managers = await ctx.contacts.managersOf([payload.employeeId]);
    const employee = await ctx.contacts.byUserIds([payload.userId]);
    return to(managers, {
      title: `Сотрудник уволен: ${employee[0]?.fullName || payload.employeeId}`,
      body:
        `Дата: ${formatDate(payload.date)}. Причина: ${payload.reason}.\n` +
        'Открытые задачи освобождены от исполнителя и ждут перераспределения.',
      link: Links.employee(payload.employeeId),
      priority: 'HIGH',
      channels: IMPORTANT,
    });
  },

  /**
   * Смена типа найма (§10.5). Меняет набор доступных заявок и методику
   * расчёта времени, поэтому уведомляются и сотрудник, и кадровая служба.
   */
  [HrEvents.EMPLOYMENT_CHANGED]: async (payload, ctx) => {
    const [employee, hr] = await Promise.all([
      ctx.contacts.byEmployeeIds([payload.employeeId]),
      ctx.contacts.byRoles(['HR']),
    ]);

    const change =
      `${employmentTitle(payload.before.type)} → ${employmentTitle(payload.after.type)}`;
    const policyChanged = payload.before.policy !== payload.after.policy;

    return [
      ...to(employee, {
        title: 'Изменён тип найма',
        body:
          `${change}, с ${formatDate(payload.validFrom)}.\n` +
          (policyChanged
            ? 'Вместе с ним изменился порядок учёта рабочего времени: набор доступных заявок будет другим.'
            : 'Порядок учёта рабочего времени не изменился.'),
        priority: 'HIGH',
        channels: IMPORTANT,
      }),
      ...to(except(hr, payload.employeeId), {
        title: `Изменён тип найма: ${employee[0]?.fullName || payload.employeeId}`,
        body: `${change}, с ${formatDate(payload.validFrom)}.`,
        link: Links.employee(payload.employeeId),
        channels: IN_APP,
      }),
    ];
  },

  // ── Графики и отсутствия ──────────────────────────────────────────────

  [HrEvents.SHIFT_ASSIGNED]: async (payload, ctx) => {
    const recipients = await ctx.contacts.byEmployeeIds([payload.employeeId]);
    const timezone = recipients[0]?.timezone ?? 'Europe/Moscow';
    return to(recipients, {
      title: `Назначена смена ${formatDate(payload.date)}`,
      body: `Время: ${formatTime(payload.startsAt, timezone)} — ${formatTime(payload.endsAt, timezone)}.`,
      link: Links.schedule(),
      channels: REALTIME,
    });
  },

  [HrEvents.SHIFT_CHANGED]: async (payload, ctx) => {
    const recipients = await ctx.contacts.byEmployeeIds([payload.employeeId]);
    const timezone = recipients[0]?.timezone ?? 'Europe/Moscow';
    const before = `${formatDate(payload.before.date)}, ${formatTime(payload.before.startsAt, timezone)} — ${formatTime(payload.before.endsAt, timezone)}`;
    const after = `${formatDate(payload.after.date)}, ${formatTime(payload.after.startsAt, timezone)} — ${formatTime(payload.after.endsAt, timezone)}`;
    return to(recipients, {
      title: 'Смена изменена',
      body: `Было: ${before}\nСтало: ${after}`,
      link: Links.schedule(),
      priority: 'HIGH',
      channels: REALTIME,
    });
  },

  [HrEvents.SHIFT_CANCELLED]: async (payload, ctx) => {
    const recipients = await ctx.contacts.byEmployeeIds([payload.employeeId]);
    return to(recipients, {
      title: `Смена ${formatDate(payload.date)} отменена`,
      body: payload.reason ? `Причина: ${payload.reason}.` : 'Смена снята с графика.',
      link: Links.schedule(),
      priority: 'HIGH',
      channels: REALTIME,
    });
  },

  /**
   * Применение шаблона графика. Событие приходит ОДНО на сотрудника
   * (§7.2), поэтому и уведомление одно — вместо двадцати двух «назначена
   * смена» подряд.
   */
  [HrEvents.SCHEDULE_APPLIED]: async (payload, ctx) => {
    const recipients = await ctx.contacts.byEmployeeIds([payload.employeeId]);
    return to(recipients, {
      title: `График на период ${formatPeriod(payload.period)}`,
      body:
        `Шаблон «${payload.templateName}»: ${plural(payload.shiftsCreated, 'смена', 'смены', 'смен')}, ` +
        `норма ${formatMinutes(payload.normMinutes)}.`,
      link: Links.schedule(),
      channels: REALTIME,
    });
  },

  [HrEvents.ABSENCE_REGISTERED]: async (payload, ctx) => {
    const recipients = await ctx.contacts.byEmployeeIds([payload.employeeId]);
    return to(recipients, {
      title: `Оформлено отсутствие: ${absenceTitle(payload.type)}`,
      body: `Период: ${formatPeriod(payload.period)}. Смены на эти дни сняты с графика.`,
      link: Links.schedule(),
      channels: IMPORTANT,
    });
  },

  /**
   * Сага согласования оборвалась на применении (§10.3): заявку утвердили,
   * а отсутствие в кадровом учёте не появилось. Молча оставлять это
   * нельзя — сотрудник уверен, что отпуск у него есть.
   */
  [HrEvents.ABSENCE_REGISTRATION_FAILED]: async (payload, ctx) => {
    const [managers, hr, employee] = await Promise.all([
      ctx.contacts.managersOf([payload.employeeId]),
      ctx.contacts.byRoles(['HR']),
      ctx.contacts.byEmployeeIds([payload.employeeId]),
    ]);

    const audience = [...managers, ...hr].filter(
      (contact, index, list) => list.findIndex((item) => item.userId === contact.userId) === index,
    );

    return to(audience, {
      title: 'Отсутствие не удалось оформить',
      body:
        `Сотрудник: ${employee[0]?.fullName || payload.employeeId}.\n` +
        `Причина: ${payload.reason}.\n\n` +
        'Заявка согласована, но в кадровом учёте отсутствие не зарегистрировано. ' +
        'Требуется ручной разбор.',
      link: Links.request(payload.requestId),
      priority: 'HIGH',
      channels: IMPORTANT,
    });
  },

  // ── Табель ────────────────────────────────────────────────────────────

  /** Закрытый период — сигнал бухгалтерии, что данные можно забирать. */
  [HrEvents.TIMESHEET_CLOSED]: async (payload, ctx) => {
    const recipients = await ctx.contacts.byRoles(['HR']);
    return to(recipients, {
      title: `Табель закрыт: ${formatPeriod(payload.period)}`,
      body: `Отработано по подразделению: ${formatMinutes(payload.totalMinutes)}.`,
      link: Links.timesheet(payload.period.from.slice(0, 7)),
      channels: IMPORTANT,
    });
  },

  [HrEvents.TIMESHEET_REOPENED]: async (payload, ctx) => {
    const recipients = await ctx.contacts.byRoles(['HR']);
    return to(recipients, {
      title: `Табель открыт заново: ${formatPeriod(payload.period)}`,
      body: `Причина: ${payload.reason}.\nВыгруженные ранее данные за период считаются недействительными.`,
      link: Links.timesheet(payload.period.from.slice(0, 7)),
      priority: 'HIGH',
      channels: IMPORTANT,
    });
  },

  // ── Согласования ──────────────────────────────────────────────────────

  [ApprovalEvents.REQUEST_CREATED]: async (payload, ctx) => {
    const [approvers, author] = await Promise.all([
      ctx.contacts.byEmployeeIds(payload.approverEmployeeIds),
      ctx.contacts.byEmployeeIds([payload.authorEmployeeId]),
    ]);

    const deadline = payload.slaDeadline
      ? `\nСрок решения: ${new Date(payload.slaDeadline).toLocaleString('ru-RU')}.`
      : '';

    return to(except(approvers, payload.authorEmployeeId), {
      title: `Заявка на согласование: ${requestTitle(payload.type)}`,
      body: `Автор: ${author[0]?.fullName || payload.authorEmployeeId}.${deadline}`,
      link: Links.request(payload.requestId),
      priority: 'HIGH',
      channels: IMPORTANT,
    });
  },

  /** Маршрут сдвинулся: ждать решения теперь очередь следующего. */
  [ApprovalEvents.REQUEST_STEP_PASSED]: async (payload, ctx) => {
    if (!payload.nextApproverEmployeeId) return NONE;

    const recipients = await ctx.contacts.byEmployeeIds([payload.nextApproverEmployeeId]);
    return to(recipients, {
      title: 'Заявка ждёт вашего решения',
      body: `Предыдущий шаг маршрута пройден (шаг ${payload.step}).`,
      link: Links.request(payload.requestId),
      priority: 'HIGH',
      channels: IMPORTANT,
    });
  },

  [ApprovalEvents.REQUEST_APPROVED]: async (payload, ctx) => {
    const recipients = await ctx.contacts.byEmployeeIds([payload.authorEmployeeId]);
    return to(recipients, {
      title: `Заявка согласована: ${requestTitle(payload.type)}`,
      body: 'Маршрут пройден полностью. Результат применяется в кадровом учёте.',
      link: Links.request(payload.requestId),
      channels: IMPORTANT,
    });
  },

  [ApprovalEvents.REQUEST_REJECTED]: async (payload, ctx) => {
    const [author, approver] = await Promise.all([
      ctx.contacts.byEmployeeIds([payload.authorEmployeeId]),
      ctx.contacts.byEmployeeIds([payload.approverEmployeeId]),
    ]);

    return to(author, {
      title: `Заявка отклонена: ${requestTitle(payload.type)}`,
      body:
        `Решение принял: ${approver[0]?.fullName || payload.approverEmployeeId}.\n` +
        `Причина: ${payload.reason || 'не указана'}.`,
      link: Links.request(payload.requestId),
      priority: 'HIGH',
      channels: IMPORTANT,
    });
  },

  /** Эскалация: истёк SLA, решение переходит к вышестоящему руководителю. */
  [ApprovalEvents.REQUEST_ESCALATED]: async (payload, ctx) => {
    const [escalatedTo, from] = await Promise.all([
      ctx.contacts.byEmployeeIds([payload.toApproverEmployeeId]),
      ctx.contacts.byEmployeeIds([payload.fromApproverEmployeeId]),
    ]);

    return to(escalatedTo, {
      title: 'Заявка передана вам по эскалации',
      body:
        `Истёк срок решения у согласующего: ${from[0]?.fullName || payload.fromApproverEmployeeId}.`,
      link: Links.request(payload.requestId),
      priority: 'HIGH',
      channels: IMPORTANT,
    });
  },

  [ApprovalEvents.DELEGATION_SET]: async (payload, ctx) => {
    const [delegate, manager] = await Promise.all([
      ctx.contacts.byEmployeeIds([payload.delegateEmployeeId]),
      ctx.contacts.byEmployeeIds([payload.managerEmployeeId]),
    ]);

    return to(delegate, {
      title: 'Вам делегировано согласование заявок',
      body:
        `Руководитель: ${manager[0]?.fullName || payload.managerEmployeeId}.\n` +
        `Период: ${formatPeriod(payload.period)}.`,
      link: Links.requestsInbox(),
      priority: 'HIGH',
      channels: IMPORTANT,
    });
  },

  // ── Задачи ────────────────────────────────────────────────────────────

  [TaskEvents.CARD_CREATED]: async (payload, ctx) => {
    if (!payload.assigneeEmployeeId || payload.assigneeEmployeeId === payload.authorEmployeeId) {
      return NONE;
    }

    const recipients = await ctx.contacts.byEmployeeIds([payload.assigneeEmployeeId]);
    return to(recipients, {
      title: 'Новая задача',
      body: truncate(payload.title, 120),
      link: Links.card(payload.boardId, payload.cardId),
      channels: REALTIME,
    });
  },

  [TaskEvents.CARD_ASSIGNED]: async (payload, ctx) => {
    if (payload.assigneeEmployeeId === payload.actorEmployeeId) return NONE;

    const [assignee, actor] = await Promise.all([
      ctx.contacts.byEmployeeIds([payload.assigneeEmployeeId]),
      ctx.contacts.byEmployeeIds([payload.actorEmployeeId]),
    ]);

    return to(assignee, {
      title: 'Вам назначена задача',
      body: `Назначил: ${actor[0]?.fullName || payload.actorEmployeeId}.`,
      link: Links.card(payload.boardId, payload.cardId),
      priority: 'HIGH',
      channels: REALTIME,
    });
  },

  /** Упоминание в комментарии — единственное, ради чего стоит дёргать. */
  [TaskEvents.CARD_COMMENTED]: async (payload, ctx) => {
    const mentioned = payload.mentions ?? [];
    if (mentioned.length === 0) return NONE;

    const [recipients, author] = await Promise.all([
      ctx.contacts.byEmployeeIds(mentioned),
      ctx.contacts.byEmployeeIds([payload.authorEmployeeId]),
    ]);

    return to(except(recipients, payload.authorEmployeeId), {
      title: 'Вас упомянули в комментарии',
      body: `Автор: ${author[0]?.fullName || payload.authorEmployeeId}.`,
      // boardId в payload события нет, поэтому ссылка идёт на карточку
      // напрямую — интерфейс сам откроет её доску.
      link: Links.cardById(payload.cardId),
      priority: 'HIGH',
      channels: REALTIME,
    });
  },

  /**
   * Просрочка. Уведомляются оба — исполнитель и его руководитель:
   * уведомление только исполнителю на просроченной задаче обычно уже
   * не работает, иначе она не была бы просрочена.
   */
  [TaskEvents.CARD_OVERDUE]: async (payload, ctx) => {
    const [assignee, managers] = await Promise.all([
      ctx.contacts.byEmployeeIds([payload.assigneeEmployeeId]),
      ctx.contacts.managersOf([payload.assigneeEmployeeId]),
    ]);

    return [
      ...to(assignee, {
        title: 'Задача просрочена',
        body: `Срок был ${formatDate(payload.dueDate)}.`,
        link: Links.card(payload.boardId, payload.cardId),
        priority: 'HIGH',
        channels: REALTIME,
      }),
      ...to(managers, {
        title: `Просрочена задача: ${assignee[0]?.fullName || payload.assigneeEmployeeId}`,
        body: `Срок был ${formatDate(payload.dueDate)}.`,
        link: Links.card(payload.boardId, payload.cardId),
        channels: IN_APP,
      }),
    ];
  },

  // ── Чат ───────────────────────────────────────────────────────────────

  [ChatEvents.CHANNEL_CREATED]: async (payload, ctx) => {
    const recipients = await ctx.contacts.byEmployeeIds(payload.memberEmployeeIds ?? []);
    return to(except(recipients, payload.creatorEmployeeId), {
      title: `Вас добавили в канал «${payload.name}»`,
      body: 'Новый канал доступен в списке переписок.',
      link: Links.channel(payload.channelId),
      channels: IN_APP,
    });
  },

  [ChatEvents.MEMBER_ADDED]: async (payload, ctx) => {
    const recipients = await ctx.contacts.byEmployeeIds([payload.employeeId]);
    return to(recipients, {
      title: 'Вас добавили в канал',
      body: 'Канал появился в списке переписок.',
      link: Links.channel(payload.channelId),
      channels: IN_APP,
    });
  },

  // chat.member.removed правила не имеет намеренно: уведомление «вас
  // исключили» без названия канала (его нет в payload) и без доступа
  // к самому каналу не сообщает ничего, кроме тревоги.

  /**
   * Сообщение в чате. Push уходит только тем, кого сейчас нет в системе:
   * тому, у кого чат открыт, сообщение и так придёт по WebSocket (§8.2).
   * In-app здесь не используется — иначе список уведомлений превратился
   * бы во второй чат.
   */
  [ChatEvents.MESSAGE_SENT]: async (payload, ctx) => {
    const recipients = except(
      await ctx.contacts.byEmployeeIds(payload.recipientEmployeeIds ?? []),
      payload.authorEmployeeId,
    );
    if (recipients.length === 0) return NONE;

    const online = await ctx.presence.filterOnline(recipients.map((contact) => contact.userId));
    const offline = recipients.filter((contact) => !online.has(contact.userId));

    return to(offline, {
      title: 'Новое сообщение',
      body: payload.hasAttachments
        ? `${truncate(payload.preview, 100)} (вложение)`
        : truncate(payload.preview, 120),
      link: Links.message(payload.channelId, payload.messageId),
      channels: PUSH,
    });
  },

  /** Упоминание доставляется независимо от присутствия — §7.3. */
  [ChatEvents.MENTION_CREATED]: async (payload, ctx) => {
    const [recipients, author] = await Promise.all([
      ctx.contacts.byEmployeeIds(payload.mentionedEmployeeIds ?? []),
      ctx.contacts.byEmployeeIds([payload.authorEmployeeId]),
    ]);

    return to(except(recipients, payload.authorEmployeeId), {
      title: 'Вас упомянули в чате',
      body: `Автор: ${author[0]?.fullName || payload.authorEmployeeId}.`,
      link: Links.message(payload.channelId, payload.messageId),
      priority: 'HIGH',
      channels: REALTIME,
    });
  },

  // ── Видеозвонки ───────────────────────────────────────────────────────

  /**
   * Приглашение в звонок. URGENT: единственное уведомление в системе,
   * которое обесценивается за минуты, — поэтому тихие часы для него
   * не действуют.
   */
  [VideoEvents.CALL_STARTED]: async (payload, ctx) => {
    const [invited, initiator] = await Promise.all([
      ctx.contacts.byEmployeeIds(payload.invitedEmployeeIds ?? []),
      ctx.contacts.byEmployeeIds([payload.initiatorEmployeeId]),
    ]);

    return to(except(invited, payload.initiatorEmployeeId), {
      title: 'Вас приглашают в звонок',
      body: `Инициатор: ${initiator[0]?.fullName || payload.initiatorEmployeeId}.`,
      link: Links.call(payload.roomId),
      priority: 'URGENT',
      channels: REALTIME,
    });
  },

  // ── Файлы ─────────────────────────────────────────────────────────────

  [FileEvents.QUOTA_EXCEEDED]: async (payload, ctx) => {
    const [owner, admins] = await Promise.all([
      ctx.contacts.byEmployeeIds([payload.ownerEmployeeId]),
      ctx.contacts.byRoles(['ADMIN']),
    ]);

    const usage = `${formatBytes(payload.usedBytes)} из ${formatBytes(payload.limitBytes)}`;
    return [
      ...to(owner, {
        title: 'Исчерпана квота на файлы',
        body: `Занято ${usage}. Загрузка новых файлов недоступна, пока не освободится место.`,
        link: Links.files(),
        priority: 'HIGH',
        channels: IMPORTANT,
      }),
      ...to(except(admins, payload.ownerEmployeeId), {
        title: `Квота исчерпана: ${owner[0]?.fullName || payload.ownerEmployeeId}`,
        body: `Занято ${usage}.`,
        link: Links.storage(),
        channels: IN_APP,
      }),
    ];
  },

  /**
   * Место на диске. Специфика self-hosted (§7.3): том конечен, и никто
   * не расширит его автоматически — предупредить нужно заранее.
   */
  [FileEvents.STORAGE_LOW]: async (payload, ctx) => {
    const recipients = await ctx.contacts.byRoles(['ADMIN']);
    const percent = Math.round(payload.usedRatio * 100);
    return to(recipients, {
      title: `Заканчивается место на диске: занято ${percent}%`,
      body:
        `Свободно ${formatBytes(payload.freeBytes)} из ${formatBytes(payload.totalBytes)}.\n` +
        'При заполнении тома загрузка файлов и запись звонков прекратятся.',
      link: Links.storage(),
      priority: 'HIGH',
      channels: IMPORTANT,
    });
  },
};

/** Есть ли правило для типа события. */
export function hasRule(eventType: string): boolean {
  return Object.prototype.hasOwnProperty.call(RULES, eventType);
}
