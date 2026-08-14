<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  BarChart3,
  Bell,
  Building2,
  CalendarDays,
  Files,
  FileCheck2,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  Shield,
  Sun,
  Trello,
  Users,
  Video,
  Wifi,
  WifiOff,
} from 'lucide-vue-next';
import { useAuthStore } from '~/stores/auth';
import { useNotificationsStore } from '~/stores/notifications';
import { cn, plural } from '~/lib/utils';

const auth = useAuthStore();
const notifications = useNotificationsStore();
const realtime = useRealtime();
const { toast } = useToast();
const route = useRoute();

const sidebarOpen = ref(false);
const dark = ref(false);

/**
 * Пункты меню фильтруются по ролям.
 *
 * Это удобство, а не защита: спрятанный пункт не мешает открыть адрес
 * руками, и настоящий отказ придёт от api-gateway. Смысл в том, чтобы не
 * показывать человеку разделы, которые для него всё равно пусты.
 */
const nav = computed(() =>
  [
    { to: '/', label: 'Сводка', icon: LayoutDashboard, show: true },
    { to: '/requests', label: 'Заявки', icon: FileCheck2, show: true },
    { to: '/boards', label: 'Доски', icon: Trello, show: true },
    { to: '/chat', label: 'Переписка', icon: MessageSquare, show: true },
    { to: '/calls', label: 'Звонки', icon: Video, show: true },
    { to: '/timesheet', label: 'Табель', icon: CalendarDays, show: true },
    { to: '/employees', label: 'Сотрудники', icon: Users, show: auth.isManager || auth.isHr },
    // Руководителю нужен доступ и без кадровых прав: состав своего
    // отдела он ведёт сам
    {
      to: '/departments',
      label: 'Подразделения',
      icon: Building2,
      show: auth.isManager || auth.isHr,
    },
    { to: '/files', label: 'Файлы', icon: Files, show: true },
    { to: '/reports', label: 'Отчёты', icon: BarChart3, show: auth.isManager || auth.isHr },
    { to: '/admin', label: 'Администрирование', icon: Shield, show: auth.isAdmin },
  ].filter((item) => item.show),
);

const unsubscribers: (() => void)[] = [];

onMounted(async () => {
  dark.value = localStorage.getItem('crm.theme') === 'dark';
  applyTheme();

  realtime.connect();
  await notifications.loadCount();

  // Счётчик поднимается событием, а не опросом: лента уже в базе, а это
  // сообщение — лишь повод обновить бейдж (§8.1).
  unsubscribers.push(
    realtime.on('notification.created', (payload) => {
      notifications.receive(payload);
      if (payload.priority === 'URGENT') {
        toast(String(payload.title ?? 'Уведомление'), String(payload.body ?? ''));
      }
    }),
  );
});

onUnmounted(() => {
  for (const off of unsubscribers) off();
});

function applyTheme() {
  document.documentElement.classList.toggle('dark', dark.value);
  localStorage.setItem('crm.theme', dark.value ? 'dark' : 'light');
}

function toggleTheme() {
  dark.value = !dark.value;
  applyTheme();
}

const isActive = (to: string) => (to === '/' ? route.path === '/' : route.path.startsWith(to));
</script>

<template>
  <div class="bg-background min-h-screen">
    <!-- ── Боковое меню ────────────────────────────────────────────── -->
    <aside
      :class="
        cn(
          'bg-card fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r transition-transform',
          // На узком экране меню выезжает поверх, на широком стоит всегда
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )
      "
    >
      <div class="flex h-14 items-center gap-2 border-b px-5">
        <div class="bg-primary text-primary-foreground grid size-7 place-items-center rounded-md">
          <span class="text-xs font-bold">УР</span>
        </div>
        <span class="text-sm font-semibold">Учёт работы</span>
      </div>

      <nav class="flex-1 space-y-0.5 overflow-y-auto p-3">
        <NuxtLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          :class="
            cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              isActive(item.to)
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )
          "
          @click="sidebarOpen = false"
        >
          <component :is="item.icon" class="size-4 shrink-0" />
          <span class="truncate">{{ item.label }}</span>
        </NuxtLink>
      </nav>

      <div class="border-t p-3">
        <NuxtLink
          to="/profile"
          class="hover:bg-accent/50 flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors"
          title="Свой профиль"
          @click="sidebarOpen = false"
        >
          <UiAvatar :name="auth.fullName" :id="auth.employeeId ?? undefined" size="sm" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-medium">{{ auth.fullName }}</p>
            <p class="text-muted-foreground truncate text-[11px]">
              {{ auth.roles.join(', ') || 'без ролей' }}
            </p>
          </div>
        </NuxtLink>
        <UiButton variant="ghost" size="sm" class="mt-1 w-full justify-start" @click="auth.logout()">
          <LogOut class="size-4" />
          Выйти
        </UiButton>
      </div>
    </aside>

    <!-- Затемнение под выехавшим меню: клик закрывает -->
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 z-30 bg-black/50 lg:hidden"
      @click="sidebarOpen = false"
    />

    <!-- ── Содержимое ──────────────────────────────────────────────── -->
    <div class="lg:pl-60">
      <header
        class="bg-background/80 sticky top-0 z-20 flex h-14 items-center gap-3 border-b px-4 backdrop-blur lg:px-6"
      >
        <UiButton variant="ghost" size="icon" class="lg:hidden" @click="sidebarOpen = true">
          <Menu class="size-4" />
        </UiButton>

        <div class="flex-1" />

        <!-- Состояние живого соединения: без него интерфейс работает, но
             перестаёт обновляться сам, и человек должен об этом знать -->
        <span
          :class="cn('text-xs', realtime.connected.value ? 'text-success' : 'text-muted-foreground')"
          :title="realtime.connected.value ? 'Обновления приходят сразу' : 'Нет живого соединения'"
        >
          <Wifi v-if="realtime.connected.value" class="size-4" />
          <WifiOff v-else class="size-4" />
        </span>

        <UiButton variant="ghost" size="icon" :title="dark ? 'Светлая тема' : 'Тёмная тема'" @click="toggleTheme">
          <Sun v-if="dark" class="size-4" />
          <Moon v-else class="size-4" />
        </UiButton>

        <NuxtLink to="/notifications" class="relative">
          <UiButton variant="ghost" size="icon" title="Уведомления">
            <Bell class="size-4" />
          </UiButton>
          <span
            v-if="notifications.unread > 0"
            class="bg-destructive text-destructive-foreground absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold"
            :title="`${notifications.unread} ${plural(notifications.unread, 'непрочитанное', 'непрочитанных', 'непрочитанных')}`"
          >
            {{ notifications.unread > 99 ? '99+' : notifications.unread }}
          </span>
        </NuxtLink>
      </header>

      <main class="p-4 lg:p-6">
        <slot />
      </main>
    </div>

    <UiToaster />
  </div>
</template>
