/**
 * Каталог routing key. docs/architecture.md §7.2, §7.3, §7.4
 *
 * Соглашение: <контекст>.<агрегат>.<событие в прошедшем времени>
 *
 * Контекст соответствует ОГРАНИЧЕННОМУ КОНТЕКСТУ, а не имени контейнера.
 * hr-service публикует hr.employee.*, hr.shift.*, hr.absence.* и
 * hr.timesheet.* — четыре агрегата одного контекста. Если модуль позже
 * выделят в отдельный сервис (ADR-1), routing key не изменятся и
 * подписчиков менять не придётся.
 */

// ── Доменные события (обменник crm.events, topic) ───────────────────────────

export const AuthEvents = {
  USER_REGISTERED: 'auth.user.registered',
  PASSWORD_RESET_REQUESTED: 'auth.password.reset_requested',
  SESSION_SUSPICIOUS: 'auth.session.suspicious',
} as const;

export const HrEvents = {
  // staff
  EMPLOYEE_CREATED: 'hr.employee.created',
  EMPLOYEE_UPDATED: 'hr.employee.updated',
  EMPLOYEE_DEACTIVATED: 'hr.employee.deactivated',
  EMPLOYMENT_CHANGED: 'hr.employment.changed',
  HIERARCHY_CHANGED: 'hr.hierarchy.changed',
  // schedule
  SHIFT_ASSIGNED: 'hr.shift.assigned',
  SHIFT_CHANGED: 'hr.shift.changed',
  SHIFT_CANCELLED: 'hr.shift.cancelled',
  ABSENCE_REGISTERED: 'hr.absence.registered',
  ABSENCE_REGISTRATION_FAILED: 'hr.absence.registration_failed',
  // timesheet
  OVERTIME_REGISTERED: 'hr.timesheet.overtime_registered',
  TIMESHEET_CORRECTED: 'hr.timesheet.corrected',
  TIMESHEET_CLOSED: 'hr.timesheet.closed',
  TIMESHEET_REOPENED: 'hr.timesheet.reopened',
} as const;

export const ApprovalEvents = {
  REQUEST_CREATED: 'approval.request.created',
  REQUEST_STEP_PASSED: 'approval.request.step_passed',
  REQUEST_APPROVED: 'approval.request.approved',
  REQUEST_REJECTED: 'approval.request.rejected',
  REQUEST_ESCALATED: 'approval.request.escalated',
  DELEGATION_SET: 'approval.delegation.set',
} as const;

export const TaskEvents = {
  CARD_CREATED: 'task.card.created',
  CARD_MOVED: 'task.card.moved',
  CARD_ASSIGNED: 'task.card.assigned',
  CARD_COMMENTED: 'task.card.commented',
  CARD_CLOSED: 'task.card.closed',
  CARD_OVERDUE: 'task.card.overdue',
  CARD_DELETED: 'task.card.deleted',
} as const;

export const ChatEvents = {
  CHANNEL_CREATED: 'chat.channel.created',
  MEMBER_ADDED: 'chat.member.added',
  MEMBER_REMOVED: 'chat.member.removed',
  MESSAGE_SENT: 'chat.message.sent',
  MESSAGE_EDITED: 'chat.message.edited',
  MESSAGE_DELETED: 'chat.message.deleted',
  MENTION_CREATED: 'chat.mention.created',
  REACTION_ADDED: 'chat.reaction.added',
} as const;

export const VideoEvents = {
  CALL_STARTED: 'video.call.started',
  PARTICIPANT_JOINED: 'video.participant.joined',
  PARTICIPANT_LEFT: 'video.participant.left',
  CALL_ENDED: 'video.call.ended',
  RECORDING_READY: 'video.recording.ready',
} as const;

export const FileEvents = {
  UPLOAD_COMPLETED: 'file.upload.completed',
  THUMBNAIL_READY: 'file.thumbnail.ready',
  QUOTA_EXCEEDED: 'file.quota.exceeded',
  STORAGE_LOW: 'file.storage.low',
} as const;

export const AnalyticsEvents = {
  REPORT_READY: 'analytics.report.ready',
} as const;

/**
 * Префикс attendance.* ЗАРЕЗЕРВИРОВАН под будущий сервис фактического
 * учёта (§3.4) и сегодня не используется ни одним издателем.
 * Раскомментировать вместе с появлением attendance-service.
 */
// export const AttendanceEvents = {
//   CHECKIN_RECORDED: 'attendance.checkin.recorded',
//   CHECKOUT_RECORDED: 'attendance.checkout.recorded',
//   VIOLATION_DETECTED: 'attendance.violation.detected',
// } as const;

export const DomainEvents = {
  ...AuthEvents,
  ...HrEvents,
  ...ApprovalEvents,
  ...TaskEvents,
  ...ChatEvents,
  ...VideoEvents,
  ...FileEvents,
  ...AnalyticsEvents,
} as const;

export type EventType = (typeof DomainEvents)[keyof typeof DomainEvents];

// ── Асинхронные команды (обменник crm.commands, direct) ─────────────────────

export const Commands = {
  NOTIFICATION_SEND: 'notification.send',
  NOTIFICATION_BROADCAST: 'notification.broadcast',
  REPORT_GENERATE: 'report.generate',
  MEDIA_PROCESS: 'media.process',
  TIMESHEET_RECALCULATE: 'timesheet.recalculate',
  FILE_GC_RUN: 'file.gc.run',
} as const;

export type CommandType = (typeof Commands)[keyof typeof Commands];

// ── Эфемерные каналы Redis Pub/Sub ──────────────────────────────────────────
//
// Третий транспорт (§5). Эти сигналы ОБЯЗАНЫ теряться при сбое: индикатор
// «печатает» живёт 3 секунды, и доставка устаревшего значения хуже,
// чем недоставка. Поэтому они принципиально не проходят через RabbitMQ.

export const RedisChannels = {
  PRESENCE_UPDATES: 'presence:updates',
  typing: (channelId: string) => `typing:${channelId}`,
  boardPresence: (boardId: string) => `board:${boardId}:presence`,
  callSpeaking: (roomId: string) => `call:${roomId}:speaking`,
} as const;
