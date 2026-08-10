import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { SERVICES } from '@crm/contracts';
import { DEADLINES_MS, grpcClientToken } from '@crm/grpc-clients';

export interface InAppNotificationDto {
  notification_id: string;
  user_id: string;
  event_type: string;
  title: string;
  body: string;
  link: string;
  priority: string;
  read: boolean;
  created_at: number;
}

export interface ChannelPreferenceDto {
  channel: string;
  enabled: boolean;
  muted_event_types: string[];
}

export interface PreferencesDto {
  user_id: string;
  channels: ChannelPreferenceDto[];
  quiet_hours: { enabled: boolean; from: string; to: string; timezone: string };
  email: string;
  push_subscriptions: number;
}

interface NotificationGrpc {
  ListInApp(data: {
    user_id: string;
    only_unread?: boolean;
    page?: { limit?: number; cursor?: string };
  }): Observable<{
    items: InAppNotificationDto[];
    page: { next_cursor: string; has_more: boolean };
    unread: number;
  }>;
  GetUnreadCount(data: { user_id: string }): Observable<{ value: number }>;
  MarkRead(data: {
    user_id: string;
    notification_ids?: string[];
    all?: boolean;
  }): Observable<{ value: number }>;
  GetPreferences(data: { user_id: string }): Observable<PreferencesDto>;
  UpdatePreferences(data: {
    user_id: string;
    channels?: ChannelPreferenceDto[];
    quiet_hours?: { enabled: boolean; from: string; to: string; timezone: string };
    update_mask?: string[];
  }): Observable<PreferencesDto>;
  RegisterPushSubscription(data: {
    user_id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    user_agent?: string;
  }): Observable<object>;
  RemovePushSubscription(data: { user_id: string; endpoint: string }): Observable<object>;
  GetVapidKey(data: object): Observable<{ public_key: string; enabled: boolean }>;
}

@Injectable()
export class NotificationClient implements OnModuleInit {
  private service!: NotificationGrpc;

  constructor(
    @Inject(grpcClientToken(SERVICES.NOTIFICATION)) private readonly client: ClientGrpc,
  ) {}

  onModuleInit(): void {
    this.service = this.client.getService<NotificationGrpc>('NotificationService');
  }

  listInApp(userId: string, onlyUnread: boolean, limit: number, cursor?: string) {
    return firstValueFrom(
      this.service
        .ListInApp({ user_id: userId, only_unread: onlyUnread, page: { limit, cursor } })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  getUnreadCount(userId: string) {
    return firstValueFrom(
      this.service.GetUnreadCount({ user_id: userId }).pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  markRead(userId: string, notificationIds: string[], all: boolean) {
    return firstValueFrom(
      this.service
        .MarkRead({ user_id: userId, notification_ids: notificationIds, all })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  getPreferences(userId: string) {
    return firstValueFrom(
      this.service.GetPreferences({ user_id: userId }).pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  updatePreferences(
    userId: string,
    input: {
      channels?: ChannelPreferenceDto[];
      quietHours?: { enabled: boolean; from: string; to: string; timezone: string };
    },
  ) {
    // Маска собирается здесь, а не приходит от клиента: она описывает,
    // какие разделы формы пользователь фактически прислал, и доверять
    // этому решению телу запроса незачем.
    const updateMask: string[] = [];
    if (input.channels) updateMask.push('channels');
    if (input.quietHours) updateMask.push('quiet_hours');

    return firstValueFrom(
      this.service
        .UpdatePreferences({
          user_id: userId,
          channels: input.channels,
          quiet_hours: input.quietHours,
          update_mask: updateMask,
        })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  registerPush(
    userId: string,
    input: { endpoint: string; p256dh: string; auth: string; userAgent?: string },
  ) {
    return firstValueFrom(
      this.service
        .RegisterPushSubscription({
          user_id: userId,
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
          user_agent: input.userAgent,
        })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  removePush(userId: string, endpoint: string) {
    return firstValueFrom(
      this.service
        .RemovePushSubscription({ user_id: userId, endpoint })
        .pipe(timeout(DEADLINES_MS.DEFAULT)),
    );
  }

  getVapidKey() {
    return firstValueFrom(this.service.GetVapidKey({}).pipe(timeout(DEADLINES_MS.DEFAULT)));
  }
}
