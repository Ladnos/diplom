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
export declare const AuthEvents: {
    readonly USER_REGISTERED: "auth.user.registered";
    readonly PASSWORD_RESET_REQUESTED: "auth.password.reset_requested";
    readonly SESSION_SUSPICIOUS: "auth.session.suspicious";
};
export declare const HrEvents: {
    readonly EMPLOYEE_CREATED: "hr.employee.created";
    readonly EMPLOYEE_UPDATED: "hr.employee.updated";
    readonly EMPLOYEE_DEACTIVATED: "hr.employee.deactivated";
    readonly EMPLOYMENT_CHANGED: "hr.employment.changed";
    readonly HIERARCHY_CHANGED: "hr.hierarchy.changed";
    readonly SHIFT_ASSIGNED: "hr.shift.assigned";
    readonly SHIFT_CHANGED: "hr.shift.changed";
    readonly SHIFT_CANCELLED: "hr.shift.cancelled";
    readonly ABSENCE_REGISTERED: "hr.absence.registered";
    readonly ABSENCE_REGISTRATION_FAILED: "hr.absence.registration_failed";
    readonly OVERTIME_REGISTERED: "hr.timesheet.overtime_registered";
    readonly TIMESHEET_CORRECTED: "hr.timesheet.corrected";
    readonly TIMESHEET_CLOSED: "hr.timesheet.closed";
    readonly TIMESHEET_REOPENED: "hr.timesheet.reopened";
};
export declare const ApprovalEvents: {
    readonly REQUEST_CREATED: "approval.request.created";
    readonly REQUEST_STEP_PASSED: "approval.request.step_passed";
    readonly REQUEST_APPROVED: "approval.request.approved";
    readonly REQUEST_REJECTED: "approval.request.rejected";
    readonly REQUEST_ESCALATED: "approval.request.escalated";
    readonly DELEGATION_SET: "approval.delegation.set";
};
export declare const TaskEvents: {
    readonly CARD_CREATED: "task.card.created";
    readonly CARD_MOVED: "task.card.moved";
    readonly CARD_ASSIGNED: "task.card.assigned";
    readonly CARD_COMMENTED: "task.card.commented";
    readonly CARD_CLOSED: "task.card.closed";
    readonly CARD_OVERDUE: "task.card.overdue";
    readonly CARD_DELETED: "task.card.deleted";
};
export declare const ChatEvents: {
    readonly CHANNEL_CREATED: "chat.channel.created";
    readonly MEMBER_ADDED: "chat.member.added";
    readonly MEMBER_REMOVED: "chat.member.removed";
    readonly MESSAGE_SENT: "chat.message.sent";
    readonly MESSAGE_EDITED: "chat.message.edited";
    readonly MESSAGE_DELETED: "chat.message.deleted";
    readonly MENTION_CREATED: "chat.mention.created";
    readonly REACTION_ADDED: "chat.reaction.added";
};
export declare const VideoEvents: {
    readonly CALL_STARTED: "video.call.started";
    readonly PARTICIPANT_JOINED: "video.participant.joined";
    readonly PARTICIPANT_LEFT: "video.participant.left";
    readonly CALL_ENDED: "video.call.ended";
    readonly RECORDING_READY: "video.recording.ready";
};
export declare const FileEvents: {
    readonly UPLOAD_COMPLETED: "file.upload.completed";
    readonly THUMBNAIL_READY: "file.thumbnail.ready";
    readonly QUOTA_EXCEEDED: "file.quota.exceeded";
    readonly STORAGE_LOW: "file.storage.low";
};
export declare const AnalyticsEvents: {
    readonly REPORT_READY: "analytics.report.ready";
};
/**
 * Префикс attendance.* ЗАРЕЗЕРВИРОВАН под будущий сервис фактического
 * учёта (§3.4) и сегодня не используется ни одним издателем.
 * Раскомментировать вместе с появлением attendance-service.
 */
export declare const DomainEvents: {
    readonly REPORT_READY: "analytics.report.ready";
    readonly UPLOAD_COMPLETED: "file.upload.completed";
    readonly THUMBNAIL_READY: "file.thumbnail.ready";
    readonly QUOTA_EXCEEDED: "file.quota.exceeded";
    readonly STORAGE_LOW: "file.storage.low";
    readonly CALL_STARTED: "video.call.started";
    readonly PARTICIPANT_JOINED: "video.participant.joined";
    readonly PARTICIPANT_LEFT: "video.participant.left";
    readonly CALL_ENDED: "video.call.ended";
    readonly RECORDING_READY: "video.recording.ready";
    readonly CHANNEL_CREATED: "chat.channel.created";
    readonly MEMBER_ADDED: "chat.member.added";
    readonly MEMBER_REMOVED: "chat.member.removed";
    readonly MESSAGE_SENT: "chat.message.sent";
    readonly MESSAGE_EDITED: "chat.message.edited";
    readonly MESSAGE_DELETED: "chat.message.deleted";
    readonly MENTION_CREATED: "chat.mention.created";
    readonly REACTION_ADDED: "chat.reaction.added";
    readonly CARD_CREATED: "task.card.created";
    readonly CARD_MOVED: "task.card.moved";
    readonly CARD_ASSIGNED: "task.card.assigned";
    readonly CARD_COMMENTED: "task.card.commented";
    readonly CARD_CLOSED: "task.card.closed";
    readonly CARD_OVERDUE: "task.card.overdue";
    readonly CARD_DELETED: "task.card.deleted";
    readonly REQUEST_CREATED: "approval.request.created";
    readonly REQUEST_STEP_PASSED: "approval.request.step_passed";
    readonly REQUEST_APPROVED: "approval.request.approved";
    readonly REQUEST_REJECTED: "approval.request.rejected";
    readonly REQUEST_ESCALATED: "approval.request.escalated";
    readonly DELEGATION_SET: "approval.delegation.set";
    readonly EMPLOYEE_CREATED: "hr.employee.created";
    readonly EMPLOYEE_UPDATED: "hr.employee.updated";
    readonly EMPLOYEE_DEACTIVATED: "hr.employee.deactivated";
    readonly EMPLOYMENT_CHANGED: "hr.employment.changed";
    readonly HIERARCHY_CHANGED: "hr.hierarchy.changed";
    readonly SHIFT_ASSIGNED: "hr.shift.assigned";
    readonly SHIFT_CHANGED: "hr.shift.changed";
    readonly SHIFT_CANCELLED: "hr.shift.cancelled";
    readonly ABSENCE_REGISTERED: "hr.absence.registered";
    readonly ABSENCE_REGISTRATION_FAILED: "hr.absence.registration_failed";
    readonly OVERTIME_REGISTERED: "hr.timesheet.overtime_registered";
    readonly TIMESHEET_CORRECTED: "hr.timesheet.corrected";
    readonly TIMESHEET_CLOSED: "hr.timesheet.closed";
    readonly TIMESHEET_REOPENED: "hr.timesheet.reopened";
    readonly USER_REGISTERED: "auth.user.registered";
    readonly PASSWORD_RESET_REQUESTED: "auth.password.reset_requested";
    readonly SESSION_SUSPICIOUS: "auth.session.suspicious";
};
export type EventType = (typeof DomainEvents)[keyof typeof DomainEvents];
export declare const Commands: {
    readonly NOTIFICATION_SEND: "notification.send";
    readonly NOTIFICATION_BROADCAST: "notification.broadcast";
    readonly REPORT_GENERATE: "report.generate";
    readonly MEDIA_PROCESS: "media.process";
    readonly TIMESHEET_RECALCULATE: "timesheet.recalculate";
    readonly FILE_GC_RUN: "file.gc.run";
};
export type CommandType = (typeof Commands)[keyof typeof Commands];
export declare const RedisChannels: {
    readonly PRESENCE_UPDATES: "presence:updates";
    readonly typing: (channelId: string) => string;
    readonly boardPresence: (boardId: string) => string;
    readonly callSpeaking: (roomId: string) => string;
};
//# sourceMappingURL=routing-keys.d.ts.map