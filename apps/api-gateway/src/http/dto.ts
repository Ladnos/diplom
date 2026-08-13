import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsBoolean,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * DTO входящих запросов.
 *
 * Валидация здесь, на краю системы: доменные сервисы должны получать уже
 * проверенные данные и не тратить дедлайн на разбор мусора. Глобальный
 * ValidationPipe настроен с forbidNonWhitelisted, поэтому лишние поля в
 * теле запроса дают 400, а не проходят молча.
 */

export class RegisterDto {
  @IsEmail({}, { message: 'некорректный email' })
  email!: string;

  @IsString()
  @Length(10, 128, { message: 'пароль от 10 до 128 символов' })
  password!: string;

  @IsString()
  @Length(2, 200)
  fullName!: string;
}

export class LoginDto {
  @IsEmail({}, { message: 'некорректный email' })
  email!: string;

  @IsString()
  @Length(1, 128)
  password!: string;
}

export class RefreshDto {
  @IsString()
  @Length(10, 512)
  refreshToken!: string;
}

export class UpdateEmployeeDto {
  @IsOptional()
  @IsString()
  @Length(2, 200)
  fullName?: string;

  /** Название должности, а не ссылка на справочник — см. hr.proto. */
  @IsOptional()
  @IsString()
  @Length(0, 200)
  position?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsUUID()
  managerId?: string;

  @IsOptional()
  @IsUUID()
  avatarFileId?: string;
}

/** Значения дублируют enum'ы из hr.proto — валидация до похода в сервис. */
export const EMPLOYMENT_TYPES = [
  'LABOR_CONTRACT',
  'CIVIL_CONTRACT',
  'SELF_EMPLOYED',
  'ENTREPRENEUR',
  'OUTSTAFF',
  'INTERN',
] as const;

export const PAYMENT_FORMS = ['SALARY', 'HOURLY', 'PIECEWORK', 'PER_ACT'] as const;

export class ChangeEmploymentDto {
  @IsIn(EMPLOYMENT_TYPES, { message: `тип найма: ${EMPLOYMENT_TYPES.join(', ')}` })
  type!: (typeof EMPLOYMENT_TYPES)[number];

  @IsIn(PAYMENT_FORMS, { message: `форма оплаты: ${PAYMENT_FORMS.join(', ')}` })
  paymentForm!: (typeof PAYMENT_FORMS)[number];

  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(2)
  rate?: number;

  @IsOptional()
  @IsString()
  validFrom?: string;
}

/**
 * Коды ролей проверяются по списку, а не свободной строкой: опечатка
 * в имени роли иначе создала бы «назначение», которое ничего не даёт,
 * и разбирались бы с ним по журналу аудита.
 */
export const ROLE_CODES = ['EMPLOYEE', 'MANAGER', 'HR', 'ADMIN'] as const;

export class GrantRoleDto {
  @IsIn(ROLE_CODES, { message: `роль должна быть одной из: ${ROLE_CODES.join(', ')}` })
  roleCode!: (typeof ROLE_CODES)[number];
}

export class BlockUserDto {
  @IsString()
  @Length(3, 500, { message: 'укажите причину блокировки (от 3 символов)' })
  reason!: string;
}

export class ListUsersQuery {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  q?: string;

  @IsOptional()
  @IsIn(ROLE_CODES)
  role?: (typeof ROLE_CODES)[number];

  @IsOptional()
  @IsIn(['ACTIVE', 'BLOCKED'])
  status?: 'ACTIVE' | 'BLOCKED';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class DeactivateEmployeeDto {
  @IsOptional()
  @IsString()
  date?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  reason?: string;
}

// ── Графики и табель ────────────────────────────────────────────────────

/** Дата в формате YYYY-MM-DD. Проверяется здесь, чтобы доменный сервис
 *  не тратил дедлайн на разбор мусора. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class PeriodQuery {
  @Matches(ISO_DATE, { message: 'from: ожидается дата YYYY-MM-DD' })
  from!: string;

  @Matches(ISO_DATE, { message: 'to: ожидается дата YYYY-MM-DD' })
  to!: string;

  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

export class ApplyTemplateDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'укажите хотя бы одного сотрудника' })
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  employeeIds!: string[];

  @IsUUID()
  templateId!: string;

  @Matches(ISO_DATE, { message: 'from: ожидается дата YYYY-MM-DD' })
  from!: string;

  @Matches(ISO_DATE, { message: 'to: ожидается дата YYYY-MM-DD' })
  to!: string;
}

export const TEMPLATE_KINDS = ['FIXED_WEEK', 'SHIFT_CYCLE'] as const;

export class CreateTemplateDto {
  @IsString()
  @Length(2, 100)
  name!: string;

  @IsIn(TEMPLATE_KINDS, { message: `вид графика: ${TEMPLATE_KINDS.join(', ')}` })
  kind!: (typeof TEMPLATE_KINDS)[number];

  /** FIXED_WEEK: рабочие дни недели, 1 = понедельник … 7 = воскресенье */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  weekdays?: number[];

  /** SHIFT_CYCLE: длина цикла и номера рабочих дней внутри него */
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(31)
  cycleLength?: number;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  cycleWorkDays?: number[];

  @IsOptional()
  @Matches(ISO_DATE)
  cycleAnchor?: string;

  @Matches(/^\d{1,2}:\d{2}$/, { message: 'startTime: ожидается время ЧЧ:ММ' })
  startTime!: string;

  @Matches(/^\d{1,2}:\d{2}$/, { message: 'endTime: ожидается время ЧЧ:ММ' })
  endTime!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  breakMinutes?: number;
}

export const ABSENCE_TYPES = [
  'VACATION',
  'SICK_LEAVE',
  'TIME_OFF',
  'BUSINESS_TRIP',
  'UNPAID',
] as const;

export class RegisterAbsenceDto {
  @IsUUID()
  employeeId!: string;

  @IsIn(ABSENCE_TYPES, { message: `тип отсутствия: ${ABSENCE_TYPES.join(', ')}` })
  type!: (typeof ABSENCE_TYPES)[number];

  @Matches(ISO_DATE)
  from!: string;

  @Matches(ISO_DATE)
  to!: string;
}

export class OvertimeDto {
  @IsUUID()
  employeeId!: string;

  @Matches(ISO_DATE)
  date!: string;

  @IsInt()
  @Min(1)
  @Max(720, { message: 'переработка не может превышать 12 часов' })
  minutes!: number;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  reason?: string;
}

export class CorrectionDto {
  @IsUUID()
  employeeId!: string;

  @Matches(ISO_DATE)
  date!: string;

  @IsInt()
  @Min(0)
  @Max(1440)
  totalMinutes!: number;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  reason?: string;
}

export class ClosePeriodDto {
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @Matches(ISO_DATE)
  from!: string;

  @Matches(ISO_DATE)
  to!: string;
}

export class ReopenPeriodDto extends ClosePeriodDto {
  @IsString()
  @Length(3, 500, { message: 'укажите причину повторного открытия периода' })
  reason!: string;
}

export const CALENDAR_DAY_KINDS = ['HOLIDAY', 'SHORTENED', 'WORKDAY'] as const;

export class CalendarDayDto {
  @Matches(ISO_DATE)
  date!: string;

  @IsIn(CALENDAR_DAY_KINDS, { message: `вид дня: ${CALENDAR_DAY_KINDS.join(', ')}` })
  kind!: (typeof CALENDAR_DAY_KINDS)[number];

  @IsOptional()
  @IsString()
  @Length(0, 200)
  note?: string;
}

export class SeedYearDto {
  @Type(() => Number)
  @IsInt()
  @Min(2020)
  @Max(2100)
  year!: number;
}

// ── Заявки на согласование ──────────────────────────────────────────────

export const REQUEST_TYPES = [
  'VACATION',
  'TIME_OFF',
  'OVERTIME',
  'SHIFT_SWAP',
  'TIMESHEET_FIX',
  'TRIP',
  'PERIOD_CLOSE',
  'WORK_ACT',
] as const;

export class CreateRequestDto {
  @IsIn(REQUEST_TYPES, { message: `тип заявки: ${REQUEST_TYPES.join(', ')}` })
  type!: (typeof REQUEST_TYPES)[number];

  /**
   * Тело заявки. Состав зависит от типа и проверяется в approval-service:
   * отпуск — from и to, переработка — date и minutes, и так далее.
   * Здесь только базовая проверка, что это объект, а не строка или массив.
   */
  @IsObject({ message: 'payload должен быть объектом' })
  payload!: Record<string, unknown>;
}

export class DecisionDto {
  @IsOptional()
  @IsString()
  @Length(0, 500)
  comment?: string;
}

export class DelegationDto {
  @IsUUID()
  delegateEmployeeId!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from: ожидается дата YYYY-MM-DD' })
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to: ожидается дата YYYY-MM-DD' })
  to!: string;
}

export class PageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

// ── Kanban ──────────────────────────────────────────────────────────────

export class CreateBoardDto {
  @IsString()
  @Length(2, 120)
  name!: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  memberEmployeeIds?: string[];
}

export class AddMembersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  employeeIds!: string[];

  @IsOptional()
  @IsIn(['OWNER', 'MEMBER', 'VIEWER'])
  role?: 'OWNER' | 'MEMBER' | 'VIEWER';
}

export class CreateColumnDto {
  @IsString()
  @Length(1, 60)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  wipLimit?: number;

  @IsOptional()
  @IsBoolean()
  isDoneColumn?: boolean;

  @IsOptional()
  @IsUUID()
  afterColumnId?: string;
}

export class UpdateColumnDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  wipLimit?: number;

  @IsOptional()
  @IsBoolean()
  isDoneColumn?: boolean;
}

export class ReorderColumnsDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  orderedColumnIds!: string[];
}

export class CreateCardDto {
  @IsUUID()
  columnId!: string;

  @IsString()
  @Length(1, 300)
  title!: string;

  @IsOptional()
  @IsString()
  @Length(0, 10000)
  description?: string;

  @IsOptional()
  @IsUUID()
  assigneeEmployeeId?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dueDate: ожидается дата YYYY-MM-DD' })
  dueDate?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  estimateMinutes?: number;
}

export class UpdateCardDto {
  @IsOptional()
  @IsString()
  @Length(1, 300)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(0, 10000)
  description?: string;

  @IsOptional()
  @Matches(/^(\d{4}-\d{2}-\d{2})?$/, { message: 'dueDate: дата YYYY-MM-DD или пустая строка' })
  dueDate?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  estimateMinutes?: number;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  labelIds?: string[];

  /**
   * Полный список вложений после правки, а не добавляемые. Клиент
   * редактирует набор целиком; «добавить» отдельным полем потребовало бы
   * ещё и «удалить», а с ними — правил разрешения конфликтов.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  attachmentFileIds?: string[];
}

export class MoveCardDto {
  @IsUUID()
  toColumnId!: string;

  @IsInt()
  @Min(0)
  targetIndex!: number;

  /**
   * Версия карточки, которую видел клиент. Нужна, чтобы двое,
   * перетащившие карточку одновременно, не затирали друг друга молча.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class AssignCardDto {
  /** null или отсутствие поля — снять исполнителя. */
  @IsOptional()
  @IsUUID()
  assigneeEmployeeId?: string;
}

export class AddCommentDto {
  @IsString()
  @Length(1, 5000)
  body!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  mentions?: string[];
}

export class CreateLabelDto {
  @IsString()
  @Length(1, 40)
  name!: string;

  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'color: ожидается HEX-цвет вида #6b7280' })
  color?: string;
}

export class AssigneeCardsQuery {
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  onlyOpen?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

// ── Уведомления ─────────────────────────────────────────────────────────

export class NotificationsQuery {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  onlyUnread?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /**
   * Курсор — момент создания последнего показанного уведомления, а не
   * смещение: лента пополняется сверху, и offset после трёх новых
   * уведомлений повторил бы часть предыдущей страницы.
   */
  @IsOptional()
  @IsString()
  @Length(1, 32)
  cursor?: string;
}

export class MarkReadDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  notificationIds?: string[];

  @IsOptional()
  @IsBoolean()
  all?: boolean;
}

export class ChannelPreferenceDto {
  @IsIn(['EMAIL', 'WEB_PUSH', 'IN_APP'])
  channel!: string;

  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @Length(3, 64, { each: true })
  mutedEventTypes?: string[];
}

export class QuietHoursDto {
  @IsBoolean()
  enabled!: boolean;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'from: ожидается время вида 22:00' })
  from!: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'to: ожидается время вида 08:00' })
  to!: string;

  /** Зона IANA: тихие часы — это стенные часы пользователя, а не сервера. */
  @IsOptional()
  @IsString()
  @Length(3, 64)
  timezone?: string;
}

export class UpdatePreferencesDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ChannelPreferenceDto)
  channels?: ChannelPreferenceDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => QuietHoursDto)
  quietHours?: QuietHoursDto;
}

/**
 * Подписка браузера на Web Push — то, что возвращает
 * PushManager.subscribe() в интерфейсе.
 */
export class PushSubscriptionDto {
  @IsString()
  @Length(10, 1024)
  endpoint!: string;

  @IsString()
  @Length(10, 256)
  p256dh!: string;

  @IsString()
  @Length(4, 256)
  auth!: string;
}

export class RemovePushSubscriptionDto {
  @IsString()
  @Length(10, 1024)
  endpoint!: string;
}

// ── Чат ─────────────────────────────────────────────────────────────────

export class CreateChannelDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  /**
   * DIRECT в списке нет: личная переписка не создаётся с именем и
   * составом, она заводится обращением к собеседнику через
   * POST /api/channels/direct.
   */
  @IsIn(['PUBLIC', 'PRIVATE', 'GROUP', 'ANNOUNCEMENT'])
  type!: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  memberEmployeeIds?: string[];
}

export class CreateDirectDto {
  @IsUUID()
  employeeId!: string;
}

export class SendMessageDto {
  @IsString()
  @Length(0, 8000)
  body!: string;

  @IsOptional()
  @IsUUID()
  threadRootId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  mentions?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  attachmentFileIds?: string[];

  /**
   * Идентификатор, присвоенный клиентом до отправки. Повторная отправка
   * после обрыва связи вернёт уже сохранённое сообщение вместо второй
   * копии — без него пользователь, нажавший «отправить» дважды при
   * зависшей сети, получает дубль.
   */
  @IsOptional()
  @IsUUID()
  clientMessageId?: string;
}

export class EditMessageDto {
  @IsString()
  @Length(1, 8000)
  body!: string;
}

export class ReactionDto {
  @IsString()
  @Length(1, 16)
  emoji!: string;
}

/**
 * Отметка о прочтении канала.
 *
 * Отдельно от MarkReadDto уведомлений: там отмечаются конкретные записи
 * или все сразу, здесь — позиция в ленте. Общее имя скрыло бы, что это
 * две разные операции над разными сущностями.
 */
export class MarkChannelReadDto {
  @IsInt()
  @Min(1)
  upToSeq!: number;
}

/**
 * Состав канала. Без поля role, в отличие от досок: роль в канале
 * назначается только созданием, а принимать её здесь и молча
 * игнорировать — значит обещать клиенту то, чего не происходит.
 */
export class AddChannelMembersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  employeeIds!: string[];
}

export class HistoryQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  beforeSeq?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsUUID()
  threadRootId?: string;
}

// ── Отчёты ──────────────────────────────────────────────────────────────

export class ReportPeriodQuery {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from: дата YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to: дата YYYY-MM-DD' })
  to?: string;

  /** Отдел вместо своей команды. Право на чужой отдел решает auth-service. */
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  /** Только для отчёта по потоку задач. */
  @IsOptional()
  @IsUUID()
  boardId?: string;
}

export class RequestExportDto {
  @IsIn(['TIME_UTILIZATION', 'TASK_FLOW', 'APPROVALS', 'MEETINGS'])
  reportType!: string;

  /**
   * XLSX и PDF потребовали бы библиотек вёрстки; CSV не требует ничего.
   * Сервис отвечает на них UNIMPLEMENTED, поэтому и в списке их нет —
   * принять значение, чтобы тут же отказать, значит обещать лишнее.
   */
  @IsOptional()
  @IsIn(['CSV'])
  format?: string;
}

export class AuditLogQuery {
  @IsOptional()
  @IsUUID()
  actorEmployeeId?: string;

  /** Префикс: `approval` покроет все события согласований. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  eventType?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  cursor?: string;
}

// ── Звонки ──────────────────────────────────────────────────────────────

export class CreateCallDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  title?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  invitedEmployeeIds?: string[];

  /** Звонок из канала: по нему chat-service положит запись о завершении. */
  @IsOptional()
  @IsUUID()
  channelId?: string;

  @IsOptional()
  @IsUUID()
  cardId?: string;
}

export class ModerateCallDto {
  @IsUUID()
  employeeId!: string;

  /**
   * KICK здесь нет: исключить участника можно только из живого
   * соединения, а им управляет сигналинг. Отметка в базе без разрыва
   * соединения означала бы, что исключённый продолжает слышать разговор.
   */
  @IsIn(['MUTE', 'UNMUTE', 'GRANT_MODERATOR'])
  action!: string;
}

export class MessageSearchQuery {
  @IsString()
  @Length(2, 200)
  q!: string;

  @IsOptional()
  @IsUUID()
  channelId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  cursor?: string;
}
