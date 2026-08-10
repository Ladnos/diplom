import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { Channel, type Notification } from '../../generated/prisma';
import { NOTIFICATION_CONFIG, type NotificationConfig } from '../config';
import { ContactsService } from '../contacts/contacts.service';
import { InboxService } from './inbox.service';
import { PreferencesService, type ResolvedPreferences } from './preferences.service';

/** Порядок каналов в ответе фиксирован: интерфейс рисует их списком. */
const CHANNEL_ORDER: Channel[] = [Channel.IN_APP, Channel.WEB_PUSH, Channel.EMAIL];

function mapNotification(item: Notification) {
  return {
    notification_id: item.id,
    user_id: item.userId,
    event_type: item.eventType,
    title: item.title,
    body: item.body,
    link: item.link ?? '',
    priority: item.priority,
    read: item.readAt !== null,
    created_at: item.createdAt.getTime(),
  };
}

function mapPreferences(
  preferences: ResolvedPreferences,
  email: string,
  pushSubscriptions: number,
) {
  return {
    user_id: preferences.userId,
    channels: CHANNEL_ORDER.map((channel) => ({
      channel,
      enabled: preferences.channels[channel].enabled,
      muted_event_types: preferences.channels[channel].mutedEventTypes,
    })),
    quiet_hours: {
      enabled: preferences.quietHours.enabled,
      from: preferences.quietHours.from,
      to: preferences.quietHours.to,
      timezone: preferences.quietHours.timezone,
    },
    email,
    push_subscriptions: pushSubscriptions,
  };
}

function inMask(mask: string[] | undefined, field: string): boolean {
  return Array.isArray(mask) && mask.includes(field);
}

/**
 * gRPC-интерфейс notification-service (libs/contracts/proto/notification.proto).
 *
 * Вызывает его только api-gateway и только от имени самого пользователя:
 * идентификатор берётся из проверенного токена, а не из тела запроса.
 * Методов «отправить уведомление» здесь нет намеренно — отправка
 * инициируется событием или командой в очереди (§7.5), иначе появился бы
 * способ разослать что угодно кому угодно синхронным вызовом.
 */
@Controller()
export class NotificationGrpcController {
  constructor(
    private readonly inbox: InboxService,
    private readonly preferences: PreferencesService,
    private readonly contacts: ContactsService,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
  ) {}

  @GrpcMethod('NotificationService', 'ListInApp')
  async listInApp(data: {
    user_id: string;
    only_unread?: boolean;
    page?: { limit?: number; cursor?: string };
  }) {
    const result = await this.inbox.list({
      userId: data.user_id,
      onlyUnread: data.only_unread ?? false,
      limit: data.page?.limit && data.page.limit > 0 ? data.page.limit : 30,
      cursor: data.page?.cursor || undefined,
    });

    return {
      items: result.items.map(mapNotification),
      page: { next_cursor: result.nextCursor ?? '', has_more: result.nextCursor !== null },
      unread: result.unread,
    };
  }

  @GrpcMethod('NotificationService', 'GetUnreadCount')
  async getUnreadCount(data: { user_id: string }) {
    return { value: await this.inbox.unreadCount(data.user_id) };
  }

  @GrpcMethod('NotificationService', 'MarkRead')
  async markRead(data: { user_id: string; notification_ids?: string[]; all?: boolean }) {
    const marked = await this.inbox.markRead({
      userId: data.user_id,
      notificationIds: data.notification_ids ?? [],
      all: data.all ?? false,
    });
    return { value: marked };
  }

  @GrpcMethod('NotificationService', 'GetPreferences')
  async getPreferences(data: { user_id: string }) {
    const [preferences, contact, subscriptions] = await Promise.all([
      this.preferences.resolve(data.user_id),
      this.contacts.byUserId(data.user_id),
      this.inbox.countPushSubscriptions(data.user_id),
    ]);
    return mapPreferences(preferences, contact?.email ?? '', subscriptions);
  }

  @GrpcMethod('NotificationService', 'UpdatePreferences')
  async updatePreferences(data: {
    user_id: string;
    channels?: { channel: string; enabled?: boolean; muted_event_types?: string[] }[];
    quiet_hours?: { enabled?: boolean; from?: string; to?: string; timezone?: string };
    update_mask?: string[];
  }) {
    // Настройки принадлежат контакту: без него сохранять их некуда, а
    // молча создавать контакт по gRPC нельзя — он наполняется событиями.
    const contact = await this.contacts.byUserId(data.user_id);
    if (!contact) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'контакт пользователя не найден' });
    }

    const preferences = await this.preferences.update(data.user_id, {
      channels: inMask(data.update_mask, 'channels')
        ? (data.channels ?? [])
            .filter((item) => CHANNEL_ORDER.includes(item.channel as Channel))
            .map((item) => ({
              channel: item.channel as Channel,
              enabled: item.enabled ?? true,
              mutedEventTypes: item.muted_event_types ?? [],
            }))
        : undefined,
      quietHours: inMask(data.update_mask, 'quiet_hours')
        ? {
            enabled: data.quiet_hours?.enabled ?? false,
            from: data.quiet_hours?.from ?? '22:00',
            to: data.quiet_hours?.to ?? '08:00',
            timezone: data.quiet_hours?.timezone ?? contact.timezone,
          }
        : undefined,
    });

    const subscriptions = await this.inbox.countPushSubscriptions(data.user_id);
    return mapPreferences(preferences, contact.email, subscriptions);
  }

  @GrpcMethod('NotificationService', 'RegisterPushSubscription')
  async registerPush(data: {
    user_id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    user_agent?: string;
  }) {
    const contact = await this.contacts.byUserId(data.user_id);
    if (!contact) {
      throw new RpcException({ code: status.NOT_FOUND, message: 'контакт пользователя не найден' });
    }

    await this.inbox.registerPush({
      userId: data.user_id,
      endpoint: data.endpoint,
      p256dh: data.p256dh,
      auth: data.auth,
      userAgent: data.user_agent || undefined,
    });
    return {};
  }

  @GrpcMethod('NotificationService', 'RemovePushSubscription')
  async removePush(data: { user_id: string; endpoint: string }) {
    await this.inbox.removePush(data.user_id, data.endpoint);
    return {};
  }

  /** Браузеру нужен публичный ключ, чтобы вообще создать подписку. */
  @GrpcMethod('NotificationService', 'GetVapidKey')
  getVapidKey() {
    return {
      public_key: this.config.vapid?.publicKey ?? '',
      enabled: this.config.vapid !== null,
    };
  }
}
