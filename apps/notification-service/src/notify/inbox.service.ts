import { createPublicKey } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import type { Notification } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Размеры ключей подписки заданы стандартом Web Push:
 * p256dh — несжатая точка кривой P-256 (65 байт), auth — 16 байт соли.
 */
const P256DH_BYTES = 65;
const AUTH_BYTES = 16;

/**
 * In-app история: список, счётчик непрочитанного, отметки о прочтении и
 * подписки браузера на Web Push.
 *
 * Отделено от маршрутизации осознанно: там сервис пишет от имени системы
 * по событию из очереди, здесь — читает и меняет от имени конкретного
 * пользователя по gRPC. Разные источники запроса, разные права,
 * разные причины меняться.
 */
@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Лента уведомлений.
   *
   * Курсор — не смещение: лента постоянно пополняется сверху, и OFFSET 20
   * после трёх новых уведомлений показал бы часть первой страницы второй
   * раз. Курсором служит момент создания, по нему же построен индекс.
   */
  async list(input: {
    userId: string;
    onlyUnread: boolean;
    limit: number;
    cursor?: string;
  }): Promise<{ items: Notification[]; nextCursor: string | null; unread: number }> {
    const limit = Math.min(Math.max(input.limit, 1), 100);
    const before = input.cursor ? new Date(Number(input.cursor)) : undefined;

    const [items, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where: {
          userId: input.userId,
          visible: true,
          ...(input.onlyUnread ? { readAt: null } : {}),
          ...(before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        // На одну больше запрошенного: так «есть ли ещё» узнаётся из той
        // же выборки, без отдельного count по всей ленте.
        take: limit + 1,
      }),
      this.unreadCount(input.userId),
    ]);

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? String(page[page.length - 1].createdAt.getTime()) : null;

    return { items: page, nextCursor, unread };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, visible: true, readAt: null },
    });
  }

  /** Возвращает число фактически отмеченных: повторный вызов даст 0. */
  async markRead(input: {
    userId: string;
    notificationIds: string[];
    all: boolean;
  }): Promise<number> {
    if (!input.all && input.notificationIds.length === 0) return 0;

    const result = await this.prisma.notification.updateMany({
      where: {
        userId: input.userId,
        readAt: null,
        ...(input.all ? {} : { id: { in: input.notificationIds } }),
      },
      data: { readAt: new Date() },
    });
    return result.count;
  }

  /**
   * Регистрация подписки браузера.
   *
   * Upsert по endpoint, а не вставка: браузер присылает прежний endpoint
   * при каждом входе, и вставка плодила бы дубли, по которым push уходил
   * бы на одно устройство по нескольку раз. Смена владельца подписки
   * тоже возможна — общий компьютер, разные учётные записи.
   *
   * Ключи проверяются здесь, а не при отправке. Подписка с ключом
   * неверной длины не шифруется вообще, и ошибка возникает ДО обращения
   * к push-шлюзу — то есть без кода ответа, по которому её можно было бы
   * отличить от временного сбоя сети. Такая подписка тратила бы все
   * попытки на каждом уведомлении и оседала бы в FAILED. Отказать при
   * регистрации дешевле и честнее: клиент узнаёт о проблеме сразу.
   */
  async registerPush(input: {
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string;
  }): Promise<void> {
    assertP256dhKey(input.p256dh);
    assertAuthKey(input.auth);

    await this.prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: {
        userId: input.userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent ?? null,
      },
      update: {
        userId: input.userId,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent ?? null,
      },
    });
  }

  async removePush(userId: string, endpoint: string): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
  }

  async countPushSubscriptions(userId: string): Promise<number> {
    return this.prisma.pushSubscription.count({ where: { userId } });
  }
}

/** Соль auth: просто 16 случайных байт, проверяется только длина. */
function assertAuthKey(value: string): void {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== AUTH_BYTES) {
    throw new RpcException({
      code: status.INVALID_ARGUMENT,
      message: `auth: ожидается ${AUTH_BYTES} байт в base64url, получено ${decoded.length}`,
    });
  }
}

/**
 * p256dh — открытый ключ подписки: несжатая точка кривой P-256, то есть
 * префикс 0x04 и две координаты по 32 байта.
 *
 * Длины мало: строка нужной длины из случайных байт точкой на кривой не
 * является, и шифрование падает ровно так же. Импорт через JWK заставляет
 * проверить принадлежность точки кривой средствами node:crypto — тем же
 * условием, которое потом применит библиотека отправки.
 */
function assertP256dhKey(value: string): void {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== P256DH_BYTES || decoded[0] !== 0x04) {
    throw new RpcException({
      code: status.INVALID_ARGUMENT,
      message:
        `p256dh: ожидается несжатая точка P-256 (${P256DH_BYTES} байт с префиксом 0x04), ` +
        `получено ${decoded.length} байт`,
    });
  }

  try {
    createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: decoded.subarray(1, 33).toString('base64url'),
        y: decoded.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
  } catch {
    throw new RpcException({
      code: status.INVALID_ARGUMENT,
      message: 'p256dh: точка не принадлежит кривой P-256',
    });
  }
}
