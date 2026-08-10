import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
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
