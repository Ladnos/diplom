<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Bell, BellOff, Check } from 'lucide-vue-next';
import { useNotificationsStore } from '~/stores/notifications';
import { formatRelative } from '~/lib/utils';
import { eventTitle } from '~/lib/domain';

const store = useNotificationsStore();
const api = useApi();
const { run, success, error } = useToast();

interface Preferences {
  channels: { channel: string; enabled: boolean }[];
  mutedEventTypes: string[];
  quietHours: { from: string; to: string; timezone: string } | null;
  pushSubscriptions: number;
}

const preferences = ref<Preferences | null>(null);
const tab = ref<'feed' | 'settings'>('feed');
const pushBusy = ref(false);

onMounted(async () => {
  await Promise.all([store.load(), loadPreferences()]);
});

async function loadPreferences() {
  preferences.value = await api.get<Preferences>('/api/notifications/preferences').catch(() => null);
}

async function savePreferences() {
  if (!preferences.value) return;

  await run(
    () =>
      api.put('/api/notifications/preferences', {
        channels: preferences.value!.channels,
        mutedEventTypes: preferences.value!.mutedEventTypes,
        quietHours: preferences.value!.quietHours,
      }),
    'Настройки сохранены',
  );
}

/**
 * Подписка браузера на Web Push.
 *
 * Ключ VAPID запрашивается у сервиса и приводится к формату, который
 * ждёт PushManager: он принимает только сырые байты, а по сети ключ
 * ходит строкой base64url.
 */
async function subscribePush() {
  pushBusy.value = true;
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      error('Браузер не поддерживает Web Push');
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      error('Уведомления запрещены', 'Разрешите их в настройках браузера');
      return;
    }

    const { publicKey, enabled } = await api.get<{ publicKey: string; enabled: boolean }>(
      '/api/notifications/push/key',
    );
    if (!enabled || !publicKey) {
      error('Web Push отключён на сервере', 'Не заданы ключи VAPID');
      return;
    }

    const registration = await navigator.serviceWorker.register('/push-sw.js');
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(publicKey),
    });

    const json = subscription.toJSON();
    await api.post('/api/notifications/push', {
      endpoint: subscription.endpoint,
      p256dh: json.keys?.p256dh,
      auth: json.keys?.auth,
    });

    success('Подписка оформлена', 'Push придёт, даже когда вкладка закрыта');
    await loadPreferences();
  } catch (caught) {
    error('Не удалось подписаться', caught instanceof Error ? caught.message : '');
  } finally {
    pushBusy.value = false;
  }
}

function base64UrlToBytes(value: string): Uint8Array {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

const channelLabels: Record<string, { label: string; hint: string }> = {
  IN_APP: { label: 'В приложении', hint: 'Лента уведомлений — тихим часам не подчиняется' },
  EMAIL: { label: 'Электронная почта', hint: 'Важные события и то, что можно прочитать позже' },
  WEB_PUSH: { label: 'Push в браузере', hint: 'Приходит, даже когда вкладка закрыта' },
};

const grouped = computed(() => store.items);
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">Уведомления</h1>
        <p class="text-muted-foreground text-sm">
          {{ store.unread > 0 ? `${store.unread} непрочитанных` : 'Всё прочитано' }}
        </p>
      </div>
      <UiButton v-if="store.unread > 0" variant="outline" @click="store.markRead()">
        <Check class="size-4" />
        Прочитать всё
      </UiButton>
    </div>

    <div class="flex gap-1 border-b">
      <button
        v-for="item in [
          { key: 'feed', label: 'Лента' },
          { key: 'settings', label: 'Настройки' },
        ]"
        :key="item.key"
        class="relative px-4 py-2 text-sm transition-colors"
        :class="tab === item.key ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'"
        @click="tab = item.key as 'feed' | 'settings'"
      >
        {{ item.label }}
        <span v-if="tab === item.key" class="bg-foreground absolute inset-x-0 -bottom-px h-0.5" />
      </button>
    </div>

    <!-- ── Лента ───────────────────────────────────────────────────── -->
    <UiCard v-if="tab === 'feed'" body-class="p-0">
      <UiEmptyState
        v-if="!store.loading && grouped.length === 0"
        title="Уведомлений нет"
        description="Здесь появятся события, которые вас касаются"
        :icon="Bell"
      />

      <ul v-else class="divide-y">
        <li
          v-for="item in grouped"
          :key="item.notificationId"
          class="hover:bg-muted/40 flex gap-3 px-5 py-4 transition-colors"
          :class="!item.read && 'bg-accent/30'"
        >
          <!-- Непрочитанное помечено точкой, а не только фоном: фон плохо
               различим на тёмной теме -->
          <span
            class="mt-1.5 size-2 shrink-0 rounded-full"
            :class="item.read ? 'bg-transparent' : 'bg-primary'"
          />

          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-3">
              <p class="text-sm font-medium">{{ item.title }}</p>
              <span class="text-muted-foreground shrink-0 text-xs">
                {{ formatRelative(item.createdAt) }}
              </span>
            </div>
            <p class="text-muted-foreground mt-0.5 text-sm">{{ item.body }}</p>

            <div class="mt-2 flex items-center gap-2">
              <UiBadge v-if="item.priority !== 'NORMAL'" :variant="item.priority === 'URGENT' ? 'destructive' : 'warning'">
                {{ item.priority === 'URGENT' ? 'срочно' : 'важно' }}
              </UiBadge>
              <span class="text-muted-foreground text-xs">{{ eventTitle(item.eventType) }}</span>
              <NuxtLink
                v-if="item.link"
                :to="item.link"
                class="text-xs underline underline-offset-4"
                @click="store.markRead([item.notificationId])"
              >
                Перейти
              </NuxtLink>
            </div>
          </div>
        </li>
      </ul>

      <template v-if="store.nextCursor" #footer>
        <UiButton variant="ghost" size="sm" class="w-full" @click="store.load(false)">
          Показать ещё
        </UiButton>
      </template>
    </UiCard>

    <!-- ── Настройки ───────────────────────────────────────────────── -->
    <div v-else class="space-y-6">
      <UiCard title="Каналы доставки" description="Куда присылать уведомления">
        <div v-if="preferences" class="space-y-4">
          <label
            v-for="channel in preferences.channels"
            :key="channel.channel"
            class="flex cursor-pointer items-start gap-3"
          >
            <input
              v-model="channel.enabled"
              type="checkbox"
              class="border-input accent-primary mt-0.5 size-4 rounded"
            />
            <span class="min-w-0">
              <span class="block text-sm font-medium">
                {{ channelLabels[channel.channel]?.label ?? channel.channel }}
              </span>
              <span class="text-muted-foreground block text-xs">
                {{ channelLabels[channel.channel]?.hint }}
              </span>
            </span>
          </label>

          <UiButton size="sm" @click="savePreferences">Сохранить</UiButton>
        </div>
      </UiCard>

      <UiCard
        title="Тихие часы"
        description="Уведомления копятся и приходят после окончания — кроме срочных"
      >
        <div v-if="preferences" class="space-y-4">
          <div v-if="preferences.quietHours" class="grid gap-3 sm:grid-cols-3">
            <div class="space-y-1.5">
              <label class="text-sm font-medium">С</label>
              <UiInput v-model="preferences.quietHours.from" type="time" />
            </div>
            <div class="space-y-1.5">
              <label class="text-sm font-medium">До</label>
              <UiInput v-model="preferences.quietHours.to" type="time" />
            </div>
            <div class="space-y-1.5">
              <label class="text-sm font-medium">Часовой пояс</label>
              <UiInput v-model="preferences.quietHours.timezone" placeholder="Europe/Moscow" />
            </div>
          </div>

          <UiButton
            v-else
            variant="outline"
            size="sm"
            @click="preferences.quietHours = { from: '22:00', to: '08:00', timezone: 'Europe/Moscow' }"
          >
            <BellOff class="size-4" />
            Включить тихие часы
          </UiButton>

          <div v-if="preferences.quietHours" class="flex gap-2">
            <UiButton size="sm" @click="savePreferences">Сохранить</UiButton>
            <UiButton
              size="sm"
              variant="ghost"
              @click="((preferences.quietHours = null), savePreferences())"
            >
              Отключить
            </UiButton>
          </div>
        </div>
      </UiCard>

      <UiCard title="Push в браузере" description="Приходит, даже когда вкладка закрыта">
        <div class="flex items-center justify-between gap-4">
          <p class="text-muted-foreground text-sm">
            Подписок:
            <span class="text-foreground font-medium">{{ preferences?.pushSubscriptions ?? 0 }}</span>
          </p>
          <UiButton size="sm" :loading="pushBusy" @click="subscribePush">Подписать браузер</UiButton>
        </div>
      </UiCard>
    </div>
  </div>
</template>
