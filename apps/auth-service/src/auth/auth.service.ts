import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { AuthEvents, type UserRegistered } from '@crm/contracts';
import { getRequestContext } from '@crm/common';
import { EventPublisher } from '@crm/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { outboxRow } from '../prisma/outbox.store';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { PermissionService } from './permission.service';

/** Роль по умолчанию для вновь зарегистрированного пользователя. */
export const DEFAULT_ROLE = 'EMPLOYEE';

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly permissions: PermissionService,
    private readonly publisher: EventPublisher,
  ) {}

  /**
   * Регистрация. Профиль сотрудника здесь НЕ создаётся: это зона
   * ответственности hr-service, который слушает auth.user.registered
   * и заводит заготовку профиля. Обратная связь приходит событием
   * hr.employee.created, по которому проставляется employeeId (§10.1).
   */
  async register(input: {
    email: string;
    password: string;
    fullName: string;
  }): Promise<{ userId: string }> {
    const email = input.email.trim().toLowerCase();

    const weakness = PasswordService.validateStrength(input.password);
    if (weakness) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: weakness });
    }

    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      throw new RpcException({
        code: GrpcStatus.ALREADY_EXISTS,
        message: 'пользователь с таким email уже зарегистрирован',
      });
    }

    const passwordHash = await this.passwords.hash(input.password);

    const envelope = this.publisher.wrap<UserRegistered>(
      AuthEvents.USER_REGISTERED,
      { userId: '', email, roles: [DEFAULT_ROLE] },
      getRequestContext(),
    );

    // Пользователь и событие сохраняются атомарно. Публикация — забота
    // OutboxWorker: упади процесс сразу после COMMIT, событие всё равно
    // уйдёт после перезапуска (§7.7).
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          passwordHash,
          roles: { create: { roleCode: DEFAULT_ROLE } },
        },
        select: { id: true },
      });

      const payload: UserRegistered & { fullName: string } = {
        userId: created.id,
        email,
        roles: [DEFAULT_ROLE],
        fullName: input.fullName,
      };

      await tx.outbox.create({
        data: outboxRow({ ...envelope, payload }),
      });

      return created;
    });

    this.logger.log({ message: 'пользователь зарегистрирован', userId: user.id, email });
    return { userId: user.id };
  }

  async login(input: {
    email: string;
    password: string;
    userAgent?: string;
    ip?: string;
  }): Promise<LoginResult> {
    const email = input.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        passwordHash: true,
        status: true,
        employeeId: true,
        roles: { select: { roleCode: true } },
      },
    });

    // Пароль проверяется даже для несуществующего пользователя — иначе
    // по времени ответа можно перебрать, какие адреса зарегистрированы.
    const stored = user?.passwordHash ?? DUMMY_HASH;
    const passwordOk = await this.passwords.verify(input.password, stored);

    if (!user || !passwordOk) {
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'неверный email или пароль',
      });
    }
    if (user.status === 'BLOCKED') {
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: 'учётная запись заблокирована',
      });
    }

    return this.issueSession(user.id, {
      employeeId: user.employeeId,
      roles: user.roles.map((r) => r.roleCode),
      userAgent: input.userAgent,
      ip: input.ip,
    });
  }

  /**
   * Обновление пары токенов с ротацией refresh.
   *
   * Старая сессия отзывается, выдаётся новая. Если отозванный токен
   * предъявят повторно — значит, он у кого-то ещё, и это признак кражи:
   * отзываются ВСЕ сессии пользователя.
   */
  async refresh(refreshToken: string, meta: { userAgent?: string; ip?: string }): Promise<LoginResult> {
    const hash = TokenService.hashRefreshToken(refreshToken);
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hash },
      select: {
        id: true,
        userId: true,
        revokedAt: true,
        expiresAt: true,
        user: {
          select: { status: true, employeeId: true, roles: { select: { roleCode: true } } },
        },
      },
    });

    if (!session) {
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'refresh-токен недействителен',
      });
    }

    if (session.revokedAt) {
      await this.revokeAllSessions(session.userId, 'повторное использование отозванного токена');
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'токен уже был использован, все сессии отозваны',
      });
    }

    if (session.expiresAt < new Date()) {
      throw new RpcException({ code: GrpcStatus.UNAUTHENTICATED, message: 'срок сессии истёк' });
    }
    if (session.user.status === 'BLOCKED') {
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: 'учётная запись заблокирована',
      });
    }

    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    return this.issueSession(session.userId, {
      employeeId: session.user.employeeId,
      roles: session.user.roles.map((r) => r.roleCode),
      userAgent: meta.userAgent,
      ip: meta.ip,
    });
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Используется при увольнении: доступ обрывается немедленно (§10.6). */
  async revokeAllSessions(userId: string, reason: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    this.logger.warn({ message: 'сессии отозваны', userId, reason, count: result.count });
    return result.count;
  }

  async validateAccessToken(token: string) {
    try {
      const claims = await this.tokens.verifyAccessToken(token);
      return {
        userId: claims.sub,
        employeeId: claims.employeeId ?? '',
        roles: claims.roles ?? [],
        isManager: claims.isManager ?? false,
        expiresAt: claims.exp * 1000,
      };
    } catch {
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'access-токен недействителен или истёк',
      });
    }
  }

  private async issueSession(
    userId: string,
    context: {
      employeeId: string | null;
      roles: string[];
      userAgent?: string;
      ip?: string;
    },
  ): Promise<LoginResult> {
    const isManager = await this.permissions.hasSubordinates(context.employeeId);

    const access = await this.tokens.issueAccessToken({
      sub: userId,
      employeeId: context.employeeId ?? undefined,
      roles: context.roles,
      isManager,
    });
    const refresh = this.tokens.issueRefreshToken();

    await this.prisma.session.create({
      data: {
        userId,
        refreshTokenHash: refresh.hash,
        userAgent: context.userAgent?.slice(0, 255),
        ip: context.ip,
        expiresAt: refresh.expiresAt,
      },
    });

    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      accessExpiresAt: access.expiresAt,
      refreshExpiresAt: refresh.expiresAt.getTime(),
    };
  }
}

/**
 * Заглушка для сравнения при несуществующем пользователе. Валидный
 * scrypt-хэш от случайной строки: проверка занимает столько же времени,
 * сколько настоящая, и не выдаёт факт отсутствия учётной записи.
 */
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
  'GwUxNBBI7iPBnfCkFANqcOhEQO4rOJdyxpx6xkFmnRKZ4ZRlHXHu1lDbDpnaYnw2bMEQvzWQMx3zEqNRWKbHwQ==';
