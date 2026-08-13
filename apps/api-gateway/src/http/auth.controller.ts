import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthClient } from '../clients/auth.client';
import { HrClient } from '../clients/hr.client';
import { Public } from '@crm/common';
import type { AuthenticatedUser } from '../auth/auth.guard';
import { CurrentUser } from '../auth/permission.guard';
import { LoginDto, RefreshDto, RegisterDto } from './dto';

/**
 * Публичный REST API аутентификации.
 *
 * Токены возвращаются в теле ответа: система рассчитана и на веб-клиент,
 * и на мобильный, а тот не умеет работать с httpOnly-cookie. Веб-клиенту
 * рекомендуется класть access-токен в память, а refresh — в cookie,
 * которую выставляет фронтенд-прокси.
 */
@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthClient,
    private readonly hr: HrClient,
  ) {}

  /**
   * Регистрация. Профиль сотрудника создаётся АСИНХРОННО: auth-service
   * публикует auth.user.registered, hr-service заводит профиль. Поэтому
   * сразу после ответа GET /me ещё может не вернуть employee — это
   * ожидаемое поведение eventual consistency, а не ошибка (§10.1).
   */
  @Public()
  @Post('register')
  async register(@Body() dto: RegisterDto) {
    const result = await this.auth.register(dto.email, dto.password, dto.fullName);
    return {
      userId: result.user_id,
      message: 'учётная запись создана, профиль сотрудника будет создан в течение нескольких секунд',
    };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() request: Request) {
    const tokens = await this.auth.login(dto.email, dto.password, {
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    });
    return toTokenResponse(tokens);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshDto) {
    const tokens = await this.auth.refresh(dto.refreshToken);
    return toTokenResponse(tokens);
  }

  /**
   * Текущий пользователь. Пример BFF-агрегации: клиенту нужен один
   * ответ, а данные лежат в двух сервисах — учётная запись в auth,
   * профиль в hr (ADR-3, часть 3).
   */
  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser) {
    if (!user.employeeId) {
      return {
        userId: user.userId,
        roles: user.roles,
        isManager: user.isManager,
        employee: null,
        note: 'профиль сотрудника ещё не создан',
      };
    }

    // Отказ hr-service не должен ломать /me целиком: без профиля
    // интерфейс покажет меньше, но пользователь останется в системе.
    const employee = await this.hr.getEmployee(user.employeeId).catch(() => null);

    return {
      userId: user.userId,
      roles: user.roles,
      isManager: user.isManager,
      employee: employee
        ? {
            employeeId: employee.employee_id,
            fullName: employee.full_name,
            position: employee.position || null,
            departmentId: employee.department_id || null,
            managerId: employee.manager_id || null,
            avatarFileId: employee.avatar_file_id || null,
            active: employee.active,
            employment: employee.employment
              ? {
                  type: employee.employment.type,
                  paymentForm: employee.employment.payment_form,
                  policy: employee.employment.policy,
                  rate: employee.employment.rate,
                }
              : null,
          }
        : null,
      degraded: employee === null,
    };
  }
}

function toTokenResponse(tokens: {
  access_token: string;
  refresh_token: string;
  access_expires_at: number;
  refresh_expires_at: number;
}) {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessExpiresAt: Number(tokens.access_expires_at),
    refreshExpiresAt: Number(tokens.refresh_expires_at),
    tokenType: 'Bearer',
  };
}
