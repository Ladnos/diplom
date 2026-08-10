import { randomBytes } from 'node:crypto';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AuthEvents, type RoleChanged, type UserRegistered } from '@crm/contracts';
import { getRequestContext, optionalEnv } from '@crm/common';
import { EventPublisher } from '@crm/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { outboxRow } from '../prisma/outbox.store';
import { PasswordService } from './password.service';
import { RbacSeed } from './rbac.seed';
import { ADMIN_ROLE } from './admin.service';
import { DEFAULT_ROLE } from './auth.service';

/**
 * Создание первого администратора при первом запуске.
 *
 * Задача «откуда берётся первый ADMIN» в самохостинге решается плохо
 * тремя привычными способами: назначать админом первого
 * зарегистрировавшегося (кто угодно захватывает свежий сервер, пока
 * администратор не успел войти), хардкодить учётку (одинаковый пароль
 * у всех установок) или требовать SQL руками (половина пользователей
 * не дойдёт). Здесь — вариант, принятый в Gitea и Grafana: учётка
 * создаётся из переменных окружения, и только если администраторов
 * в системе ещё НЕТ.
 *
 * Пароль можно не задавать: тогда он генерируется и печатается в лог
 * один раз. Это лучше значения по умолчанию, которое остаётся навсегда.
 */
@Injectable()
export class AdminBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminBootstrap.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly publisher: EventPublisher,
    private readonly rbac: RbacSeed,
  ) {}

  /**
   * Последовательность запуска подсистемы безопасности.
   *
   * Роли обязаны существовать до создания администратора: user_roles
   * ссылается на roles внешним ключом. Порядок задан здесь явно, а не
   * оставлен на очерёдность вызова хуков у разных провайдеров.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.rbac.sync();
      await this.ensureAdmin();
    } catch (error) {
      // Не валим сервис: база может быть ещё не мигрирована при первом
      // запуске — обе операции идемпотентны и пройдут при следующем старте.
      this.logger.error({
        message: 'не удалось выполнить инициализацию безопасности',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async ensureAdmin(): Promise<void> {
    const existingAdmins = await this.prisma.userRole.count({
      where: { roleCode: ADMIN_ROLE },
    });
    if (existingAdmins > 0) return;

    const email = optionalEnv('BOOTSTRAP_ADMIN_EMAIL', '').trim().toLowerCase();
    if (!email) {
      this.logger.warn({
        message:
          'в системе нет ни одного администратора. Задайте BOOTSTRAP_ADMIN_EMAIL ' +
          '(и при желании BOOTSTRAP_ADMIN_PASSWORD) и перезапустите auth-service',
      });
      return;
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    // Учётка уже есть — просто повышаем её до администратора.
    // Типичный сценарий: владелец сервера зарегистрировался обычным
    // способом, а потом прописал свой адрес в переменную окружения.
    if (existingUser) {
      await this.grantAdmin(existingUser.id, email, 'существующая учётная запись повышена');
      return;
    }

    const generated = !process.env.BOOTSTRAP_ADMIN_PASSWORD;
    const password = generated
      ? randomBytes(15).toString('base64url')
      : String(process.env.BOOTSTRAP_ADMIN_PASSWORD);

    const weakness = PasswordService.validateStrength(password);
    if (weakness) {
      this.logger.error({ message: `BOOTSTRAP_ADMIN_PASSWORD отклонён: ${weakness}` });
      return;
    }

    const passwordHash = await this.passwords.hash(password);

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          passwordHash,
          roles: {
            create: [{ roleCode: DEFAULT_ROLE, auto: false }, { roleCode: ADMIN_ROLE, auto: false }],
          },
        },
        select: { id: true },
      });

      // Событие регистрации нужно и здесь: без него hr-service не заведёт
      // профиль, и у администратора не будет сотрудника, а значит и
      // положения в оргструктуре.
      const registered = this.publisher.wrap<UserRegistered & { fullName: string }>(
        AuthEvents.USER_REGISTERED,
        {
          userId: created.id,
          email,
          roles: [DEFAULT_ROLE, ADMIN_ROLE],
          fullName: optionalEnv('BOOTSTRAP_ADMIN_NAME', 'Администратор системы'),
        },
        getRequestContext(),
      );
      await tx.outbox.create({ data: outboxRow(registered) });

      const granted = this.publisher.wrap<RoleChanged>(
        AuthEvents.ROLE_GRANTED,
        { userId: created.id, roleCode: ADMIN_ROLE, auto: false },
        getRequestContext(),
      );
      await tx.outbox.create({ data: outboxRow(granted) });

      return created;
    });

    this.logger.warn({
      message: '═══ СОЗДАН АДМИНИСТРАТОР СИСТЕМЫ ═══',
      email,
      userId: user.id,
      // Сгенерированный пароль показывается ровно один раз — больше его
      // взять неоткуда, в базе лежит только хэш.
      password: generated ? password : '(из BOOTSTRAP_ADMIN_PASSWORD)',
      hint: generated
        ? 'СОХРАНИТЕ пароль и смените его после первого входа; повторно он показан не будет'
        : 'смените пароль после первого входа',
    });
  }

  private async grantAdmin(userId: string, email: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.upsert({
        where: { userId_roleCode: { userId, roleCode: ADMIN_ROLE } },
        create: { userId, roleCode: ADMIN_ROLE, auto: false },
        update: { auto: false },
      });

      const envelope = this.publisher.wrap<RoleChanged>(
        AuthEvents.ROLE_GRANTED,
        { userId, roleCode: ADMIN_ROLE, auto: false },
        getRequestContext(),
      );
      await tx.outbox.create({ data: outboxRow(envelope) });
    });

    this.logger.warn({ message: 'выданы права администратора', email, userId, reason });
  }
}
