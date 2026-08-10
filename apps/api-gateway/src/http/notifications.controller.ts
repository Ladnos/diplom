import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  NotificationClient,
  type InAppNotificationDto,
  type PreferencesDto,
} from '../clients/notification.client';
import type { AuthenticatedUser } from '../auth/auth.guard';
import { CurrentUser, RequirePermission } from '../auth/permission.guard';
import {
  MarkReadDto,
  NotificationsQuery,
  PushSubscriptionDto,
  RemovePushSubscriptionDto,
  UpdatePreferencesDto,
} from './dto';

function mapNotification(item: InAppNotificationDto) {
  return {
    id: item.notification_id,
    eventType: item.event_type,
    title: item.title,
    body: item.body,
    link: item.link || null,
    priority: item.priority,
    read: item.read,
    createdAt: new Date(Number(item.created_at)).toISOString(),
  };
}

function mapPreferences(preferences: PreferencesDto) {
  return {
    email: preferences.email,
    pushSubscriptions: Number(preferences.push_subscriptions ?? 0),
    channels: (preferences.channels ?? []).map((channel) => ({
      channel: channel.channel,
      enabled: channel.enabled,
      mutedEventTypes: channel.muted_event_types ?? [],
    })),
    quietHours: {
      enabled: preferences.quiet_hours?.enabled ?? false,
      from: preferences.quiet_hours?.from ?? '22:00',
      to: preferences.quiet_hours?.to ?? '08:00',
      timezone: preferences.quiet_hours?.timezone ?? 'Europe/Moscow',
    },
  };
}

/**
 * Уведомления текущего пользователя.
 *
 * КРИТИЧНО: адресат везде берётся из проверенного токена, а не из
 * запроса. Уведомления — личная переписка системы с человеком, и
 * возможность подставить чужой идентификатор означала бы чтение чужих
 * уведомлений по одному только знанию id.
 *
 * Отправить уведомление через REST нельзя намеренно: рассылка
 * инициируется событием или командой в очереди (§7.5), и открывать
 * снаружи способ разослать что угодно кому угодно незачем.
 */
@Controller('api/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationClient) {}

  /** Лента уведомлений. */
  @Get()
  @RequirePermission({ resource: 'notification', action: 'read' })
  async list(@Query() query: NotificationsQuery, @CurrentUser() user: AuthenticatedUser) {
    const result = await this.notifications.listInApp(
      user.userId,
      query.onlyUnread ?? false,
      query.limit ?? 30,
      query.cursor,
    );

    return {
      notifications: (result.items ?? []).map(mapNotification),
      unread: Number(result.unread ?? 0),
      nextCursor: result.page?.next_cursor || null,
      hasMore: result.page?.has_more ?? false,
    };
  }

  /**
   * Счётчик для бейджа. Отдельная точка, потому что интерфейс опрашивает
   * её часто, а тянуть ради числа всю первую страницу ленты незачем.
   */
  @Get('unread-count')
  @RequirePermission({ resource: 'notification', action: 'read' })
  async unreadCount(@CurrentUser() user: AuthenticatedUser) {
    const result = await this.notifications.getUnreadCount(user.userId);
    return { unread: Number(result.value ?? 0) };
  }

  @Post('read')
  @HttpCode(200)
  @RequirePermission({ resource: 'notification', action: 'write' })
  async markRead(@Body() dto: MarkReadDto, @CurrentUser() user: AuthenticatedUser) {
    const result = await this.notifications.markRead(
      user.userId,
      dto.notificationIds ?? [],
      dto.all ?? false,
    );
    return { marked: Number(result.value ?? 0) };
  }

  // ── Настройки подписок ────────────────────────────────────────────────

  @Get('preferences')
  @RequirePermission({ resource: 'notification', action: 'read' })
  async getPreferences(@CurrentUser() user: AuthenticatedUser) {
    return mapPreferences(await this.notifications.getPreferences(user.userId));
  }

  @Put('preferences')
  @RequirePermission({ resource: 'notification', action: 'write' })
  async updatePreferences(
    @Body() dto: UpdatePreferencesDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const updated = await this.notifications.updatePreferences(user.userId, {
      channels: dto.channels?.map((channel) => ({
        channel: channel.channel,
        enabled: channel.enabled,
        muted_event_types: channel.mutedEventTypes ?? [],
      })),
      quietHours: dto.quietHours
        ? {
            enabled: dto.quietHours.enabled,
            from: dto.quietHours.from,
            to: dto.quietHours.to,
            timezone: dto.quietHours.timezone ?? '',
          }
        : undefined,
    });
    return mapPreferences(updated);
  }

  // ── Web Push ──────────────────────────────────────────────────────────

  /**
   * Публичный ключ VAPID. Без него браузер не может создать подписку,
   * а зашивать ключ в сборку фронтенда нельзя: он задаётся при
   * развёртывании и у каждой установки свой.
   */
  @Get('push/key')
  @RequirePermission({ resource: 'notification', action: 'read' })
  async vapidKey() {
    const result = await this.notifications.getVapidKey();
    return { publicKey: result.public_key || null, enabled: result.enabled ?? false };
  }

  @Post('push')
  @HttpCode(204)
  @RequirePermission({ resource: 'notification', action: 'write' })
  async subscribePush(
    @Body() dto: PushSubscriptionDto,
    @CurrentUser() user: AuthenticatedUser,
    // User-Agent берётся из заголовка, а не из тела: он нужен, чтобы
    // человек узнал свои устройства в списке подписок, и подделывать
    // его в запросе смысла нет — но и доверять телу незачем.
    @Headers('user-agent') userAgent?: string,
  ) {
    await this.notifications.registerPush(user.userId, {
      endpoint: dto.endpoint,
      p256dh: dto.p256dh,
      auth: dto.auth,
      userAgent: userAgent?.slice(0, 200),
    });
  }

  @Delete('push')
  @HttpCode(204)
  @RequirePermission({ resource: 'notification', action: 'write' })
  async unsubscribePush(
    @Body() dto: RemovePushSubscriptionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.notifications.removePush(user.userId, dto.endpoint);
  }
}
