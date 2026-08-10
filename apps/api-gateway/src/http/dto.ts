import { IsEmail, IsIn, IsNumber, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

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

export class DeactivateEmployeeDto {
  @IsOptional()
  @IsString()
  date?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  reason?: string;
}
