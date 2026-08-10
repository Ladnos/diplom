/**
 * Payload доменных событий. docs/architecture.md §7.3
 *
 * Карта EventPayloadMap внизу файла связывает routing key с типом payload,
 * благодаря чему publish() и @EventPattern получают проверку типов:
 * опечатка в имени события или несоответствие payload ломают сборку,
 * а не продакшен.
 */

import type { CommandType, EventType } from './routing-keys';
import { AuthEvents, HrEvents, ApprovalEvents, TaskEvents, ChatEvents, VideoEvents, FileEvents, AnalyticsEvents, Commands } from './routing-keys';

// ── Общие типы модели найма (зеркало enum'ов из hr.proto) ───────────────────

export type EmploymentType =
  | 'LABOR_CONTRACT'
  | 'CIVIL_CONTRACT'
  | 'SELF_EMPLOYED'
  | 'ENTREPRENEUR'
  | 'OUTSTAFF'
  | 'INTERN';

export type PaymentForm = 'SALARY' | 'HOURLY' | 'PIECEWORK' | 'PER_ACT';

/** Единственная величина, по которой ветвится код (§3.2). */
export type TimeTrackingPolicy = 'NORM_BASED' | 'FACT_BASED' | 'DELIVERABLE_BASED' | 'NONE';

export interface EmploymentSnapshot {
  type: EmploymentType;
  paymentForm: PaymentForm;
  policy: TimeTrackingPolicy;
  rate: number;
}

export type AbsenceType = 'VACATION' | 'SICK_LEAVE' | 'TIME_OFF' | 'BUSINESS_TRIP' | 'UNPAID';

export interface DatePeriod {
  from: string; // YYYY-MM-DD
  to: string;
}

// ── auth ────────────────────────────────────────────────────────────────────

export interface UserRegistered {
  userId: string;
  email: string;
  roles: string[];
}

export interface PasswordResetRequested {
  userId: string;
  email: string;
  token: string;
  ttlSeconds: number;
}

export interface SessionSuspicious {
  userId: string;
  ip: string;
  userAgent: string;
  reason: string;
}

/** Изменение роли. `auto: true` — выдано системой из оргструктуры. */
export interface RoleChanged {
  userId: string;
  employeeId?: string;
  roleCode: string;
  actorUserId?: string;
  auto: boolean;
}

export interface UserBlocked {
  userId: string;
  employeeId?: string;
  reason: string;
  actorUserId: string;
}

export interface UserUnblocked {
  userId: string;
  employeeId?: string;
  actorUserId: string;
}

// ── hr: staff ───────────────────────────────────────────────────────────────

export interface EmployeeCreated {
  employeeId: string;
  userId: string;
  fullName: string;
  /**
   * Отсутствующие ссылки передаются как undefined, а НЕ пустой строкой.
   * Потребители кладут их в колонки типа UUID, и '' там вызывает ошибку
   * приведения типа — сообщение уходит в DLQ, а проекция молча отстаёт.
   */
  departmentId?: string;
  position?: string;
  managerId?: string;
  employment: EmploymentSnapshot;
}

export interface EmployeeUpdated {
  employeeId: string;
  changed: Partial<{
    fullName: string;
    departmentId: string;
    position: string;
    managerId: string;
    avatarFileId: string;
  }>;
}

export interface EmployeeDeactivated {
  employeeId: string;
  userId: string;
  date: string;
  reason: string;
}

/** Смена типа найма — §10.5. Меняет набор применимых подсистем. */
export interface EmploymentChanged {
  employeeId: string;
  before: EmploymentSnapshot;
  after: EmploymentSnapshot;
  validFrom: string;
}

export interface HierarchyChanged {
  employeeId: string;
  oldManagerId?: string;
  newManagerId?: string;
}

// ── hr: schedule ────────────────────────────────────────────────────────────

export interface ShiftAssigned {
  shiftId: string;
  employeeId: string;
  date: string;
  startsAt: string;
  endsAt: string;
}

export interface ShiftChanged {
  shiftId: string;
  employeeId: string;
  before: { date: string; startsAt: string; endsAt: string };
  after: { date: string; startsAt: string; endsAt: string };
}

export interface ShiftCancelled {
  shiftId: string;
  employeeId: string;
  date: string;
  reason: string;
}

/** Итог массового применения шаблона графика к одному сотруднику. */
export interface ScheduleApplied {
  employeeId: string;
  templateId: string;
  templateName: string;
  period: DatePeriod;
  shiftsCreated: number;
  normMinutes: number;
}

/**
 * Подтверждающее событие саги согласования (§10.3): approval-service
 * подписан на него и по requestId переводит заявку в APPLIED.
 */
export interface AbsenceRegistered {
  requestId: string;
  absenceId: string;
  employeeId: string;
  type: AbsenceType;
  period: DatePeriod;
}

export interface AbsenceRegistrationFailed {
  requestId: string;
  employeeId: string;
  reason: string;
}

// ── hr: timesheet ───────────────────────────────────────────────────────────

export interface OvertimeRegistered {
  requestId: string;
  employeeId: string;
  date: string;
  minutes: number;
}

export interface TimesheetCorrected {
  requestId: string;
  employeeId: string;
  date: string;
  beforeMinutes: number;
  afterMinutes: number;
}

export interface TimesheetClosed {
  periodId: string;
  departmentId: string;
  period: DatePeriod;
  totalMinutes: number;
  closedBy: string;
}

export interface TimesheetReopened {
  periodId: string;
  departmentId: string;
  period: DatePeriod;
  reason: string;
}

// ── approval ────────────────────────────────────────────────────────────────

export type RequestType =
  | 'VACATION'
  | 'TIME_OFF'
  | 'OVERTIME'
  | 'SHIFT_SWAP'
  | 'TIMESHEET_FIX'
  | 'TRIP'
  | 'PERIOD_CLOSE'
  | 'WORK_ACT';

export interface RequestCreated {
  requestId: string;
  type: RequestType;
  authorEmployeeId: string;
  approverEmployeeIds: string[];
  slaDeadline: number;
}

export interface RequestStepPassed {
  requestId: string;
  step: number;
  approverEmployeeId: string;
  nextApproverEmployeeId?: string;
}

/** Решение принято. Владелец данных обязан применить результат и ответить. */
export interface RequestApproved {
  requestId: string;
  type: RequestType;
  authorEmployeeId: string;
  payload: Record<string, unknown>;
}

export interface RequestRejected {
  requestId: string;
  type: RequestType;
  authorEmployeeId: string;
  approverEmployeeId: string;
  reason: string;
}

export interface RequestEscalated {
  requestId: string;
  fromApproverEmployeeId: string;
  toApproverEmployeeId: string;
}

export interface DelegationSet {
  managerEmployeeId: string;
  delegateEmployeeId: string;
  period: DatePeriod;
}

// ── task ────────────────────────────────────────────────────────────────────

export interface BoardCreated {
  boardId: string;
  name: string;
  departmentId?: string;
  createdByEmployeeId: string;
}

export interface BoardMemberAdded {
  boardId: string;
  employeeId: string;
  role: string;
}

export interface CardCreated {
  cardId: string;
  boardId: string;
  columnId: string;
  title: string;
  authorEmployeeId: string;
  assigneeEmployeeId?: string;
}

export interface CardMoved {
  cardId: string;
  boardId: string;
  fromColumnId: string;
  toColumnId: string;
  actorEmployeeId: string;
  /** Оптимистическая версия: потребитель игнорирует значения ниже применённого. */
  version: number;
}

export interface CardAssigned {
  cardId: string;
  boardId: string;
  assigneeEmployeeId: string;
  actorEmployeeId: string;
}

export interface CardCommented {
  cardId: string;
  commentId: string;
  authorEmployeeId: string;
  mentions: string[];
}

export interface CardClosed {
  cardId: string;
  boardId: string;
  assigneeEmployeeId?: string;
  closedAt: string;
  estimateMinutes: number;
}

export interface CardOverdue {
  cardId: string;
  boardId: string;
  assigneeEmployeeId: string;
  dueDate: string;
}

export interface CardDeleted {
  cardId: string;
  boardId: string;
  attachmentFileIds: string[];
}

// ── chat ────────────────────────────────────────────────────────────────────

export type ChannelType = 'PUBLIC' | 'PRIVATE' | 'DIRECT' | 'GROUP' | 'ANNOUNCEMENT';

export interface ChannelCreated {
  channelId: string;
  name: string;
  type: ChannelType;
  creatorEmployeeId: string;
  memberEmployeeIds: string[];
}

export interface ChannelMemberChanged {
  channelId: string;
  employeeId: string;
}

export interface MessageSent {
  messageId: string;
  channelId: string;
  authorEmployeeId: string;
  /** Монотонный номер в канале — порядок и курсор (§8.2). */
  seq: number;
  preview: string;
  threadRootId?: string;
  recipientEmployeeIds: string[];
  hasAttachments: boolean;
}

export interface MessageEdited {
  messageId: string;
  channelId: string;
  seq: number;
}

export interface MessageDeleted {
  messageId: string;
  channelId: string;
  seq: number;
  attachmentFileIds: string[];
}

export interface MentionCreated {
  messageId: string;
  channelId: string;
  authorEmployeeId: string;
  mentionedEmployeeIds: string[];
}

export interface ReactionAdded {
  messageId: string;
  channelId: string;
  employeeId: string;
  emoji: string;
}

// ── video ───────────────────────────────────────────────────────────────────

export interface CallStarted {
  roomId: string;
  initiatorEmployeeId: string;
  invitedEmployeeIds: string[];
  channelId?: string;
  cardId?: string;
}

export interface ParticipantChanged {
  roomId: string;
  employeeId: string;
  at: string;
}

export interface CallEnded {
  roomId: string;
  durationSec: number;
  participantEmployeeIds: string[];
  channelId?: string;
  recorded: boolean;
}

export interface RecordingReady {
  roomId: string;
  rawPath: string;
  sizeBytes: number;
}

// ── file ────────────────────────────────────────────────────────────────────

export interface UploadCompleted {
  fileId: string;
  ownerEmployeeId: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  /** true, если содержимое уже было на диске — дедупликация (§9.1). */
  deduplicated: boolean;
}

export interface ThumbnailReady {
  fileId: string;
  thumbPath: string;
}

export interface QuotaExceeded {
  ownerEmployeeId: string;
  usedBytes: number;
  limitBytes: number;
}

/** Специфика self-hosted: диск конечен и никто не расширит его автоматически. */
export interface StorageLow {
  freeBytes: number;
  totalBytes: number;
  usedRatio: number;
}

// ── analytics ───────────────────────────────────────────────────────────────

export interface ReportReady {
  ticketId: string;
  reportType: string;
  requestedByEmployeeId: string;
  fileId: string;
}

// ── Карта «событие → payload» ───────────────────────────────────────────────

export interface EventPayloadMap {
  [AuthEvents.USER_REGISTERED]: UserRegistered;
  [AuthEvents.PASSWORD_RESET_REQUESTED]: PasswordResetRequested;
  [AuthEvents.SESSION_SUSPICIOUS]: SessionSuspicious;
  [AuthEvents.ROLE_GRANTED]: RoleChanged;
  [AuthEvents.ROLE_REVOKED]: RoleChanged;
  [AuthEvents.USER_BLOCKED]: UserBlocked;
  [AuthEvents.USER_UNBLOCKED]: UserUnblocked;

  [HrEvents.EMPLOYEE_CREATED]: EmployeeCreated;
  [HrEvents.EMPLOYEE_UPDATED]: EmployeeUpdated;
  [HrEvents.EMPLOYEE_DEACTIVATED]: EmployeeDeactivated;
  [HrEvents.EMPLOYMENT_CHANGED]: EmploymentChanged;
  [HrEvents.HIERARCHY_CHANGED]: HierarchyChanged;
  [HrEvents.SHIFT_ASSIGNED]: ShiftAssigned;
  [HrEvents.SHIFT_CHANGED]: ShiftChanged;
  [HrEvents.SHIFT_CANCELLED]: ShiftCancelled;
  [HrEvents.SCHEDULE_APPLIED]: ScheduleApplied;
  [HrEvents.ABSENCE_REGISTERED]: AbsenceRegistered;
  [HrEvents.ABSENCE_REGISTRATION_FAILED]: AbsenceRegistrationFailed;
  [HrEvents.OVERTIME_REGISTERED]: OvertimeRegistered;
  [HrEvents.TIMESHEET_CORRECTED]: TimesheetCorrected;
  [HrEvents.TIMESHEET_CLOSED]: TimesheetClosed;
  [HrEvents.TIMESHEET_REOPENED]: TimesheetReopened;

  [ApprovalEvents.REQUEST_CREATED]: RequestCreated;
  [ApprovalEvents.REQUEST_STEP_PASSED]: RequestStepPassed;
  [ApprovalEvents.REQUEST_APPROVED]: RequestApproved;
  [ApprovalEvents.REQUEST_REJECTED]: RequestRejected;
  [ApprovalEvents.REQUEST_ESCALATED]: RequestEscalated;
  [ApprovalEvents.DELEGATION_SET]: DelegationSet;

  [TaskEvents.BOARD_CREATED]: BoardCreated;
  [TaskEvents.BOARD_MEMBER_ADDED]: BoardMemberAdded;
  [TaskEvents.CARD_CREATED]: CardCreated;
  [TaskEvents.CARD_MOVED]: CardMoved;
  [TaskEvents.CARD_ASSIGNED]: CardAssigned;
  [TaskEvents.CARD_COMMENTED]: CardCommented;
  [TaskEvents.CARD_CLOSED]: CardClosed;
  [TaskEvents.CARD_OVERDUE]: CardOverdue;
  [TaskEvents.CARD_DELETED]: CardDeleted;

  [ChatEvents.CHANNEL_CREATED]: ChannelCreated;
  [ChatEvents.MEMBER_ADDED]: ChannelMemberChanged;
  [ChatEvents.MEMBER_REMOVED]: ChannelMemberChanged;
  [ChatEvents.MESSAGE_SENT]: MessageSent;
  [ChatEvents.MESSAGE_EDITED]: MessageEdited;
  [ChatEvents.MESSAGE_DELETED]: MessageDeleted;
  [ChatEvents.MENTION_CREATED]: MentionCreated;
  [ChatEvents.REACTION_ADDED]: ReactionAdded;

  [VideoEvents.CALL_STARTED]: CallStarted;
  [VideoEvents.PARTICIPANT_JOINED]: ParticipantChanged;
  [VideoEvents.PARTICIPANT_LEFT]: ParticipantChanged;
  [VideoEvents.CALL_ENDED]: CallEnded;
  [VideoEvents.RECORDING_READY]: RecordingReady;

  [FileEvents.UPLOAD_COMPLETED]: UploadCompleted;
  [FileEvents.THUMBNAIL_READY]: ThumbnailReady;
  [FileEvents.QUOTA_EXCEEDED]: QuotaExceeded;
  [FileEvents.STORAGE_LOW]: StorageLow;

  [AnalyticsEvents.REPORT_READY]: ReportReady;
}

/** Payload по типу события. Даёт типобезопасность publish/consume. */
export type PayloadOf<T extends EventType> = T extends keyof EventPayloadMap
  ? EventPayloadMap[T]
  : never;

// ── Payload асинхронных команд ──────────────────────────────────────────────
//
// Команды отделены от событий не формально: событие констатирует
// свершившийся факт и не знает подписчиков, команда адресована конкретному
// сервису и требует действия (§7.4). Отсюда и разные обменники.

/** Канал доставки. Зеркало enum Channel из notification.proto. */
export type NotificationChannel = 'EMAIL' | 'WEB_PUSH' | 'IN_APP';

/** URGENT игнорирует тихие часы: приглашение в звонок к утру бесполезно. */
export type NotificationPriority = 'NORMAL' | 'HIGH' | 'URGENT';

/**
 * Кому адресовано уведомление. Способы адресации складываются, получатели
 * дедуплицируются. Пустая аудитория — ошибка, а не «всем»: рассылка на всю
 * компанию должна быть заявлена явным `everyone`, иначе забытое поле
 * превращает точечное уведомление в веерное.
 */
export interface NotificationAudience {
  userIds?: string[];
  employeeIds?: string[];
  departmentIds?: string[];
  roleCodes?: string[];
  everyone?: boolean;
}

/**
 * Команда notification.send — явная отправка вне каталога правил (§7.4).
 *
 * Текст передаётся готовым, а не ключом шаблона: отправитель находится в
 * другом сервисе и в момент отправки знает подробности, которых нет в
 * payload доменного события. Каталог шаблонов остаётся за уведомлениями,
 * которые выводятся из событий.
 */
export interface NotificationSend {
  audience: NotificationAudience;
  title: string;
  body: string;
  /** Относительный путь в интерфейсе, куда ведёт уведомление. */
  link?: string;
  /** По умолчанию — IN_APP и EMAIL. */
  channels?: NotificationChannel[];
  priority?: NotificationPriority;
  /** Ключ для настроек подписки и группировки в интерфейсе. */
  eventType?: string;
}

/**
 * Команда notification.broadcast — рассылка по отделу или всей компании.
 *
 * Payload совпадает с notification.send намеренно: различие не в форме
 * сообщения, а в маршрутизации и в том, что рассылка проходит отдельный
 * учёт — по ней видно, кто и когда обратился ко всей компании.
 */
export type NotificationBroadcast = NotificationSend;

export interface CommandPayloadMap {
  [Commands.NOTIFICATION_SEND]: NotificationSend;
  [Commands.NOTIFICATION_BROADCAST]: NotificationBroadcast;
}

/** Payload по типу команды. Для команд без описанного payload — unknown. */
export type CommandPayloadOf<T extends CommandType> = T extends keyof CommandPayloadMap
  ? CommandPayloadMap[T]
  : unknown;
