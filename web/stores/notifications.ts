import { defineStore } from 'pinia';

export interface Notification {
  notificationId: string;
  title: string;
  body: string;
  link: string | null;
  priority: 'NORMAL' | 'HIGH' | 'URGENT';
  eventType: string;
  read: boolean;
  createdAt: string;
}

/**
 * Лента уведомлений и счётчик непрочитанного.
 *
 * Хранилище общее, потому что счётчик виден в шапке на каждой странице, а
 * лента открывается из неё же — держать два источника значило бы
 * показывать «3» рядом со списком из пяти.
 */
export const useNotificationsStore = defineStore('notifications', {
  state: () => ({
    items: [] as Notification[],
    unread: 0,
    loading: false,
    nextCursor: null as string | null,
  }),

  actions: {
    async load(reset = true) {
      const api = useApi();
      this.loading = true;
      try {
        const result = await api.get<{
          notifications: Notification[];
          unread: number;
          nextCursor: string | null;
        }>('/api/notifications', {
          limit: 30,
          ...(reset ? {} : { cursor: this.nextCursor }),
        });

        this.items = reset ? result.notifications : [...this.items, ...result.notifications];
        this.unread = result.unread;
        this.nextCursor = result.nextCursor;
      } finally {
        this.loading = false;
      }
    },

    async loadCount() {
      const result = await useApi().get<{ unread: number }>('/api/notifications/unread-count');
      this.unread = result.unread;
    },

    async markRead(ids?: string[]) {
      const api = useApi();
      await api.post('/api/notifications/read', ids ? { notificationIds: ids } : { all: true });

      for (const item of this.items) {
        if (!ids || ids.includes(item.notificationId)) item.read = true;
      }
      this.unread = ids ? Math.max(0, this.unread - ids.length) : 0;
    },

    /**
     * Уведомление пришло по WebSocket.
     *
     * Счётчик увеличивается локально, а не перезапрашивается: событие уже
     * содержит всё нужное, и лишний запрос к серверу на каждое
     * уведомление свёл бы на нет смысл живого соединения.
     */
    receive(payload: Record<string, unknown>) {
      const item: Notification = {
        notificationId: String(payload.notificationId ?? ''),
        title: String(payload.title ?? ''),
        body: String(payload.body ?? ''),
        link: (payload.link as string) || null,
        priority: (payload.priority as Notification['priority']) ?? 'NORMAL',
        eventType: String(payload.sourceEventType ?? ''),
        read: false,
        createdAt: String(payload.occurredAt ?? new Date().toISOString()),
      };

      // Дубль возможен при переподключении: событие могло прийти дважды
      if (this.items.some((existing) => existing.notificationId === item.notificationId)) return;

      this.items = [item, ...this.items];
      this.unread += 1;
    },
  },
});
