import {
  ApprovalEvents,
  ChatEvents,
  HrEvents,
  NotificationEvents,
  TaskEvents,
  VideoEvents,
  type EventType,
  type PayloadOf,
} from '@crm/contracts';
import { Rooms } from './rooms';

/**
 * Разложение доменного события по комнатам. docs/architecture.md §8.1
 *
 * Каждая запись отвечает на два вопроса: КОМУ адресовано событие и ЧТО
 * из него увидит клиент.
 *
 * Второй вопрос не формальность. Доменный payload собран для сервисов и
 * содержит лишнее для браузера: chat.message.sent несёт полный список
 * получателей, approval.request.approved — тело заявки. Отправить конверт
 * как есть означало бы раздать всей комнате данные, которые каждому её
 * участнику по отдельности видеть можно, а вместе — не обязательно.
 * Поэтому наружу уходит проекция: идентификаторы и минимум для отрисовки,
 * а подробности клиент дочитывает обычным запросом (§8.2).
 *
 * Событие без записи в этой карте подтверждается и никуда не рассылается.
 * Это не ошибка: очередь gateway привязана широкими паттернами (task.#,
 * chat.# и так далее), и часть событий предназначена другим потребителям.
 */

export interface Fanout {
  /** Комнаты-адресаты. Пустой список — событие не для WebSocket. */
  rooms: string[];
  /** То, что увидит клиент. Не сам payload. */
  data: Record<string, unknown>;
}

type FanoutFn<K extends EventType> = (payload: PayloadOf<K>) => Fanout;

type FanoutMap = { [K in EventType]?: FanoutFn<K> };

/** Пустая рассылка: событие относится к контексту, но окну знать о нём нечего. */
const SILENT: Fanout = { rooms: [], data: {} };

const FANOUT: FanoutMap = {
  // ── task: доска Kanban ──────────────────────────────────────────────────
  //
  // Почти всё адресовано комнате доски: она открыта у всех, кто на неё
  // смотрит, и именно там изменение должно появиться без перезагрузки.
  // Личная комната добавляется там, где событие касается человека лично и
  // могло произойти на доске, которую он сейчас не открывал.

  [TaskEvents.BOARD_CREATED]: (p) => ({
    rooms: [Rooms.employee(p.createdByEmployeeId)],
    data: { boardId: p.boardId, name: p.name, departmentId: p.departmentId },
  }),

  [TaskEvents.BOARD_MEMBER_ADDED]: (p) => ({
    rooms: [Rooms.board(p.boardId), Rooms.employee(p.employeeId)],
    data: { boardId: p.boardId, employeeId: p.employeeId, role: p.role },
  }),

  [TaskEvents.CARD_CREATED]: (p) => ({
    rooms: [Rooms.board(p.boardId), ...optionalEmployee(p.assigneeEmployeeId)],
    data: {
      cardId: p.cardId,
      boardId: p.boardId,
      columnId: p.columnId,
      title: p.title,
      assigneeEmployeeId: p.assigneeEmployeeId,
    },
  }),

  [TaskEvents.CARD_MOVED]: (p) => ({
    rooms: [Rooms.board(p.boardId)],
    // version обязателен на клиенте: перетаскивание отправляет своё
    // изменение оптимистично, и пришедшее следом эхо с меньшей версией
    // нужно отбросить, иначе карточка прыгнет назад (§10.2 по аналогии).
    data: {
      cardId: p.cardId,
      boardId: p.boardId,
      fromColumnId: p.fromColumnId,
      toColumnId: p.toColumnId,
      version: p.version,
      actorEmployeeId: p.actorEmployeeId,
    },
  }),

  [TaskEvents.CARD_ASSIGNED]: (p) => ({
    rooms: [Rooms.board(p.boardId), Rooms.employee(p.assigneeEmployeeId)],
    data: {
      cardId: p.cardId,
      boardId: p.boardId,
      assigneeEmployeeId: p.assigneeEmployeeId,
      actorEmployeeId: p.actorEmployeeId,
    },
  }),

  [TaskEvents.CARD_COMMENTED]: (p) => ({
    rooms: [Rooms.board(p.boardId), ...p.mentions.map(Rooms.employee)],
    // Текста комментария здесь нет: упомянутый получит событие, даже если
    // доска ему недоступна, и содержимое он увидит, только открыв карточку.
    data: {
      cardId: p.cardId,
      boardId: p.boardId,
      commentId: p.commentId,
      authorEmployeeId: p.authorEmployeeId,
      mentioned: p.mentions.length > 0,
    },
  }),

  [TaskEvents.CARD_CLOSED]: (p) => ({
    rooms: [Rooms.board(p.boardId), ...optionalEmployee(p.assigneeEmployeeId)],
    data: { cardId: p.cardId, boardId: p.boardId, closedAt: p.closedAt },
  }),

  [TaskEvents.CARD_OVERDUE]: (p) => ({
    rooms: [Rooms.board(p.boardId), Rooms.employee(p.assigneeEmployeeId)],
    data: { cardId: p.cardId, boardId: p.boardId, dueDate: p.dueDate },
  }),

  [TaskEvents.CARD_DELETED]: (p) => ({
    rooms: [Rooms.board(p.boardId)],
    data: { cardId: p.cardId, boardId: p.boardId },
  }),

  // ── approval: движение заявки по маршруту ───────────────────────────────
  //
  // Комнаты доски здесь нет: заявка не привязана к общему экрану, её
  // видят автор и согласующие. Поэтому адресация только личная.

  [ApprovalEvents.REQUEST_CREATED]: (p) => ({
    rooms: [Rooms.employee(p.authorEmployeeId), ...p.approverEmployeeIds.map(Rooms.employee)],
    data: { requestId: p.requestId, type: p.type, slaDeadline: p.slaDeadline },
  }),

  [ApprovalEvents.REQUEST_STEP_PASSED]: (p) => ({
    rooms: [
      Rooms.employee(p.approverEmployeeId),
      ...optionalEmployee(p.nextApproverEmployeeId),
    ],
    data: { requestId: p.requestId, step: p.step },
  }),

  [ApprovalEvents.REQUEST_APPROVED]: (p) => ({
    rooms: [Rooms.employee(p.authorEmployeeId)],
    // Тело заявки (p.payload) не пересылается: клиент откроет карточку
    // заявки запросом и получит её целиком вместе с текущим состоянием.
    data: { requestId: p.requestId, type: p.type },
  }),

  [ApprovalEvents.REQUEST_REJECTED]: (p) => ({
    rooms: [Rooms.employee(p.authorEmployeeId), Rooms.employee(p.approverEmployeeId)],
    data: { requestId: p.requestId, type: p.type, reason: p.reason },
  }),

  [ApprovalEvents.REQUEST_ESCALATED]: (p) => ({
    rooms: [
      Rooms.employee(p.fromApproverEmployeeId),
      Rooms.employee(p.toApproverEmployeeId),
    ],
    data: { requestId: p.requestId },
  }),

  [ApprovalEvents.DELEGATION_SET]: (p) => ({
    rooms: [
      Rooms.team(p.managerEmployeeId),
      Rooms.employee(p.managerEmployeeId),
      Rooms.employee(p.delegateEmployeeId),
    ],
    data: {
      managerEmployeeId: p.managerEmployeeId,
      delegateEmployeeId: p.delegateEmployeeId,
      period: p.period,
    },
  }),

  // ── hr: табель ──────────────────────────────────────────────────────────
  //
  // Из всего контекста hr в живое окно попадает только табель: остальное
  // (кадровые изменения, графики) меняется редко и клиент читает его при
  // открытии раздела. Это же зафиксировано в привязке hr.timesheet.#.

  [HrEvents.OVERTIME_REGISTERED]: (p) => ({
    rooms: [Rooms.employee(p.employeeId)],
    data: { employeeId: p.employeeId, date: p.date, minutes: p.minutes },
  }),

  [HrEvents.TIMESHEET_CORRECTED]: (p) => ({
    rooms: [Rooms.employee(p.employeeId)],
    data: {
      employeeId: p.employeeId,
      date: p.date,
      beforeMinutes: p.beforeMinutes,
      afterMinutes: p.afterMinutes,
    },
  }),

  [HrEvents.TIMESHEET_CLOSED]: (p) => ({
    rooms: [Rooms.department(p.departmentId)],
    data: { periodId: p.periodId, departmentId: p.departmentId, period: p.period },
  }),

  [HrEvents.TIMESHEET_REOPENED]: (p) => ({
    rooms: [Rooms.department(p.departmentId)],
    data: {
      periodId: p.periodId,
      departmentId: p.departmentId,
      period: p.period,
      reason: p.reason,
    },
  }),

  // ── chat ────────────────────────────────────────────────────────────────
  //
  // Заработает вместе с chat-service. Карта заполнена заранее, потому что
  // привязка chat.# уже существует, а событие без записи молча теряется —
  // отлаживать это потом дороже, чем описать сейчас.

  [ChatEvents.CHANNEL_CREATED]: (p) => ({
    rooms: p.memberEmployeeIds.map(Rooms.employee),
    data: { channelId: p.channelId, name: p.name, type: p.type },
  }),

  [ChatEvents.MEMBER_ADDED]: (p) => ({
    rooms: [Rooms.channel(p.channelId), Rooms.employee(p.employeeId)],
    data: { channelId: p.channelId, employeeId: p.employeeId, joined: true },
  }),

  [ChatEvents.MEMBER_REMOVED]: (p) => ({
    rooms: [Rooms.channel(p.channelId), Rooms.employee(p.employeeId)],
    data: { channelId: p.channelId, employeeId: p.employeeId, joined: false },
  }),

  [ChatEvents.MESSAGE_SENT]: (p) => ({
    // Комната канала — тем, у кого он открыт; личные комнаты получателей —
    // чтобы счётчик непрочитанного вырос и у тех, кто сейчас в другом
    // канале. Сокет, попавший в оба списка, получит сообщение один раз:
    // Socket.IO считает объединение сокетов, а не сумму комнат.
    rooms: [Rooms.channel(p.channelId), ...p.recipientEmployeeIds.map(Rooms.employee)],
    // recipientEmployeeIds наружу не уходит: состав получателей — это
    // состав канала, и раздавать его вместе с каждым сообщением незачем.
    data: {
      messageId: p.messageId,
      channelId: p.channelId,
      authorEmployeeId: p.authorEmployeeId,
      seq: p.seq,
      preview: p.preview,
      threadRootId: p.threadRootId,
      hasAttachments: p.hasAttachments,
    },
  }),

  [ChatEvents.MESSAGE_EDITED]: (p) => ({
    rooms: [Rooms.channel(p.channelId)],
    data: { messageId: p.messageId, channelId: p.channelId, seq: p.seq },
  }),

  [ChatEvents.MESSAGE_DELETED]: (p) => ({
    rooms: [Rooms.channel(p.channelId)],
    data: { messageId: p.messageId, channelId: p.channelId, seq: p.seq },
  }),

  [ChatEvents.MENTION_CREATED]: (p) => ({
    rooms: p.mentionedEmployeeIds.map(Rooms.employee),
    data: {
      messageId: p.messageId,
      channelId: p.channelId,
      authorEmployeeId: p.authorEmployeeId,
    },
  }),

  [ChatEvents.REACTION_ADDED]: (p) => ({
    rooms: [Rooms.channel(p.channelId)],
    data: {
      messageId: p.messageId,
      channelId: p.channelId,
      employeeId: p.employeeId,
      emoji: p.emoji,
    },
  }),

  // ── video ───────────────────────────────────────────────────────────────
  //
  // Через gateway идёт только то, что видно ВНЕ звонка: приглашение и
  // отметка о завершении. Ход самого звонка — вход и выход участников —
  // приходит клиенту напрямую от video-service по отдельному соединению
  // сигналинга, и дублировать его здесь значило бы доставить то же самое
  // дважды и с разной задержкой (§8.3).

  [VideoEvents.CALL_STARTED]: (p) => ({
    rooms: [
      Rooms.employee(p.initiatorEmployeeId),
      ...p.invitedEmployeeIds.map(Rooms.employee),
      ...optionalChannel(p.channelId),
    ],
    data: {
      roomId: p.roomId,
      initiatorEmployeeId: p.initiatorEmployeeId,
      channelId: p.channelId,
      cardId: p.cardId,
    },
  }),

  [VideoEvents.PARTICIPANT_JOINED]: () => SILENT,
  [VideoEvents.PARTICIPANT_LEFT]: () => SILENT,

  [VideoEvents.CALL_ENDED]: (p) => ({
    rooms: [...p.participantEmployeeIds.map(Rooms.employee), ...optionalChannel(p.channelId)],
    data: {
      roomId: p.roomId,
      durationSec: p.durationSec,
      channelId: p.channelId,
      recorded: p.recorded,
    },
  }),

  // Запись готова — забота file-service и уведомлений, окну обновлять нечего.
  [VideoEvents.RECORDING_READY]: () => SILENT,

  // ── notification ────────────────────────────────────────────────────────

  [NotificationEvents.CREATED]: (p) => ({
    // Единственное событие, адресованное по userId: лента принадлежит
    // учётной записи, а не карточке сотрудника.
    rooms: [Rooms.user(p.userId)],
    data: {
      notificationId: p.notificationId,
      title: p.title,
      body: p.body,
      link: p.link,
      priority: p.priority,
      sourceEventType: p.sourceEventType,
    },
  }),
};

/**
 * Разложить событие. Возвращает null, если тип не описан в карте, —
 * вызывающий подтвердит сообщение и ничего не отправит.
 */
export function fanoutFor(eventType: string, payload: unknown): Fanout | null {
  const build = FANOUT[eventType as EventType] as
    | ((p: unknown) => Fanout)
    | undefined;
  if (!build) return null;

  const result = build(payload);
  const rooms = [...new Set(result.rooms.filter(hasId))];
  return rooms.length > 0 ? { rooms, data: result.data } : null;
}

/** Известен ли тип события шлюзу — для диагностики, не для маршрутизации. */
export function isKnownRealtimeEvent(eventType: string): boolean {
  return eventType in FANOUT;
}

/** Имя комнаты с пустым идентификатором адресует всех подряд — отбрасываем. */
function hasId(room: string): boolean {
  return room.length > room.indexOf(':') + 1;
}

function optionalEmployee(employeeId?: string): string[] {
  return employeeId ? [Rooms.employee(employeeId)] : [];
}

function optionalChannel(channelId?: string): string[] {
  return channelId ? [Rooms.channel(channelId)] : [];
}
