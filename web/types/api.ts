/**
 * Формы ответов API.
 *
 * Описаны здесь, а не выведены из бэкенда автоматически: контракты
 * сервисов заданы в .proto, а шлюз отдаёт наружу СВОИ формы — с camelCase,
 * подмешанными именами сотрудников и без служебных полей. Генерировать
 * типы из .proto значило бы получить не то, что приходит в браузер.
 */

export interface Person {
  employeeId: string;
  fullName: string | null;
}

// ── Заявки ──────────────────────────────────────────────────────────────

export type RequestStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'APPLIED'
  | 'FAILED';

export interface RequestStep {
  order: number;
  approver: Person;
  decidedBy?: Person | null;
  status: string;
  comment?: string | null;
  decidedAt?: string | null;
}

export interface WorkRequest {
  requestId: string;
  type: string;
  status: RequestStatus;
  author: Person;
  payload: Record<string, unknown>;
  currentStep: number;
  steps: RequestStep[];
  createdAt?: string;
  slaDeadline?: string | number | null;
}

export interface RequestType {
  type: string;
  title: string;
  managerLevels: number;
  requiresHr: boolean;
  slaHours: number;
}

// ── Табель ──────────────────────────────────────────────────────────────

export interface TimesheetEntry {
  date: string;
  normMinutes: number;
  absenceMinutes: number;
  overtimeMinutes: number;
  totalMinutes: number;
  source: string;
}

export interface Timesheet {
  employeeId: string;
  period: { from: string; to: string };
  entries: TimesheetEntry[];
  totalMinutes: number;
  totalHours: number;
  totalOvertimeMinutes: number;
  closed: boolean;
}

// ── Kanban ──────────────────────────────────────────────────────────────

export interface BoardColumn {
  columnId: string;
  name: string;
  position: number;
  wipLimit: number | null;
  isDoneColumn: boolean;
  cardCount: number;
  wipReached: boolean;
}

export interface Attachment {
  fileId: string;
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  url: string;
}

export interface Card {
  cardId: string;
  boardId: string;
  columnId: string;
  title: string;
  description: string | null;
  assignee: (Person & { absentUntil?: string | null; absenceType?: string | null }) | null;
  position: number;
  labels: { labelId: string; name: string; color: string }[];
  attachments: Attachment[];
  dueDate: string | null;
  estimateMinutes: number;
  version: number;
  closedAt: number | null;
  createdAt: number;
}

export interface Board {
  boardId: string;
  name: string;
  departmentId: string | null;
  columns: BoardColumn[];
  members: (Person & { role: string })[];
  labels: { labelId: string; name: string; color: string }[];
  cards?: Card[];
}

// ── Чат ─────────────────────────────────────────────────────────────────

export interface Channel {
  channelId: string;
  name: string;
  type: 'PUBLIC' | 'PRIVATE' | 'DIRECT' | 'GROUP' | 'ANNOUNCEMENT';
  departmentId: string | null;
  members: Person[];
  creatorEmployeeId: string;
  lastMessageSeq: number;
  createdAt: string;
  unread?: number;
  mentions?: number;
}

export interface Message {
  messageId: string;
  channelId: string;
  author: Person | null;
  body: string;
  threadRootId: string | null;
  mentions: string[];
  attachments: Attachment[];
  reactions: { emoji: string; employeeIds: string[] }[];
  seq: number;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
}

// ── Звонки ──────────────────────────────────────────────────────────────

export interface CallParticipant extends Person {
  isModerator: boolean;
  audioEnabled: boolean;
  videoEnabled: boolean;
  inCall: boolean;
}

export interface Call {
  roomId: string;
  title: string;
  status: 'CREATED' | 'ACTIVE' | 'ENDED';
  channelId: string | null;
  initiatorEmployeeId: string;
  recording: boolean;
  participants: CallParticipant[];
  startedAt: string;
  endedAt: string | null;
}

export interface JoinTicket {
  token: string;
  signalingUrl: string;
  iceServers: { urls: string; username?: string; credential?: string }[];
  expiresAt: string;
}

// ── Сотрудники ──────────────────────────────────────────────────────────

export interface EmployeeRow {
  employeeId: string;
  fullName: string;
  position: string | null;
  departmentId: string | null;
  managerId: string | null;
  active: boolean;
  employment: {
    type: string;
    paymentForm: string;
    policy: string;
    rate: number;
  } | null;
}
