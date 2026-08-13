<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { CalendarDays, CheckCircle2, Clock, FileCheck2, Trello } from 'lucide-vue-next';
import { useAuthStore } from '~/stores/auth';
import { formatDate, formatMinutes, plural } from '~/lib/utils';
import { requestTitle, statusOf, TIME_POLICIES } from '~/lib/domain';
import type { Card as CardType, Timesheet, WorkRequest } from '~/types/api';

const auth = useAuthStore();
const api = useApi();

const loading = ref(true);
const inbox = ref<WorkRequest[]>([]);
const myRequests = ref<WorkRequest[]>([]);
const myCards = ref<CardType[]>([]);
const timesheet = ref<Timesheet | null>(null);

const period = monthPeriod();

/**
 * Сводка собирается ПАРАЛЛЕЛЬНЫМИ запросами, и отказ одного не роняет
 * страницу целиком: блок останется пустым, остальные покажут данные.
 * Это та же идея, что и `degraded` в BFF-агрегации шлюза (ADR-3).
 */
onMounted(async () => {
  const requests: Promise<unknown>[] = [
    api
      .get<{ requests: WorkRequest[] }>('/api/requests/my', { limit: 5 })
      .then((result) => (myRequests.value = result.requests))
      .catch(() => undefined),
    api
      .get<Timesheet>('/api/timesheet', period)
      .then((result) => (timesheet.value = result))
      .catch(() => undefined),
    api
      .get<{ cards: CardType[] }>('/api/cards', { onlyOpen: true, limit: 6 })
      .then((result) => (myCards.value = result.cards ?? []))
      .catch(() => undefined),
  ];

  // Очередь согласований — только для тех, кто вообще может согласовывать
  if (auth.isManager || auth.isHr) {
    requests.push(
      api
        .get<{ requests: WorkRequest[] }>('/api/requests/inbox', { limit: 5 })
        .then((result) => (inbox.value = result.requests))
        .catch(() => undefined),
    );
  }

  await Promise.all(requests);
  loading.value = false;
});

const policy = computed(() => {
  const code = auth.me?.employee?.employment?.policy;
  return code ? TIME_POLICIES[code] : null;
});

const pendingMine = computed(() =>
  myRequests.value.filter((request) => request.status === 'PENDING').length,
);

function monthPeriod() {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-xl font-semibold">Здравствуйте, {{ auth.fullName.split(' ')[1] || auth.fullName }}</h1>
      <p class="text-muted-foreground text-sm">
        {{ formatDate(new Date()) }}
        <template v-if="policy"> · учёт времени: {{ policy.label.toLowerCase() }}</template>
      </p>
    </div>

    <!-- ── Плитки ──────────────────────────────────────────────────── -->
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <UiCard body-class="p-4">
        <div class="flex items-start justify-between">
          <div>
            <p class="text-muted-foreground text-xs">Отработано за месяц</p>
            <p class="mt-1 text-2xl font-semibold tabular">
              {{ timesheet ? formatMinutes(timesheet.totalMinutes) : '—' }}
            </p>
            <p v-if="timesheet && timesheet.totalOvertimeMinutes > 0" class="text-muted-foreground mt-1 text-xs">
              включая {{ formatMinutes(timesheet.totalOvertimeMinutes) }} переработки
            </p>
          </div>
          <Clock class="text-muted-foreground size-5" />
        </div>
      </UiCard>

      <UiCard body-class="p-4">
        <div class="flex items-start justify-between">
          <div>
            <p class="text-muted-foreground text-xs">Мои заявки</p>
            <p class="mt-1 text-2xl font-semibold tabular">{{ pendingMine }}</p>
            <p class="text-muted-foreground mt-1 text-xs">ждут решения</p>
          </div>
          <FileCheck2 class="text-muted-foreground size-5" />
        </div>
      </UiCard>

      <UiCard v-if="auth.isManager || auth.isHr" body-class="p-4">
        <div class="flex items-start justify-between">
          <div>
            <p class="text-muted-foreground text-xs">Ждут моего решения</p>
            <p class="mt-1 text-2xl font-semibold tabular">{{ inbox.length }}</p>
            <p class="text-muted-foreground mt-1 text-xs">заявок в очереди</p>
          </div>
          <CheckCircle2 class="text-muted-foreground size-5" />
        </div>
      </UiCard>

      <UiCard body-class="p-4">
        <div class="flex items-start justify-between">
          <div>
            <p class="text-muted-foreground text-xs">Открытые задачи</p>
            <p class="mt-1 text-2xl font-semibold tabular">{{ myCards.length }}</p>
            <p class="text-muted-foreground mt-1 text-xs">на мне</p>
          </div>
          <Trello class="text-muted-foreground size-5" />
        </div>
      </UiCard>
    </div>

    <div class="grid gap-6 lg:grid-cols-2">
      <!-- ── Очередь согласований ──────────────────────────────────── -->
      <UiCard
        v-if="auth.isManager || auth.isHr"
        title="Ждут моего решения"
        description="Заявки, где следующий шаг — за вами"
      >
        <template #actions>
          <UiButton as="a" variant="ghost" size="sm" href="/requests">Все заявки</UiButton>
        </template>

        <UiEmptyState
          v-if="!loading && inbox.length === 0"
          title="Очередь пуста"
          description="Ничего не ждёт вашего решения"
          :icon="CheckCircle2"
        />

        <ul v-else class="divide-y">
          <li v-for="request in inbox" :key="request.requestId" class="flex items-center gap-3 py-3 first:pt-0">
            <UiAvatar :name="request.author.fullName" :id="request.author.employeeId" size="sm" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{{ requestTitle(request.type) }}</p>
              <p class="text-muted-foreground truncate text-xs">
                {{ request.author.fullName ?? request.author.employeeId }}
              </p>
            </div>
            <UiButton as="a" size="sm" variant="outline" :href="`/requests?id=${request.requestId}`">
              Рассмотреть
            </UiButton>
          </li>
        </ul>
      </UiCard>

      <!-- ── Мои заявки ────────────────────────────────────────────── -->
      <UiCard title="Мои заявки" description="Последние обращения">
        <template #actions>
          <UiButton as="a" variant="ghost" size="sm" href="/requests">Открыть</UiButton>
        </template>

        <UiEmptyState
          v-if="!loading && myRequests.length === 0"
          title="Заявок пока нет"
          description="Отпуск, отгул и переработку оформляют здесь"
          :icon="FileCheck2"
        />

        <ul v-else class="divide-y">
          <li v-for="request in myRequests" :key="request.requestId" class="flex items-center gap-3 py-3 first:pt-0">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{{ requestTitle(request.type) }}</p>
              <p class="text-muted-foreground truncate text-xs">
                шаг {{ request.currentStep + 1 }} из {{ request.steps.length || 1 }}
              </p>
            </div>
            <UiBadge :variant="statusOf(request.status).variant as never">
              {{ statusOf(request.status).label }}
            </UiBadge>
          </li>
        </ul>
      </UiCard>

      <!-- ── Мои задачи ────────────────────────────────────────────── -->
      <UiCard title="Мои задачи" description="Открытые карточки на досках">
        <template #actions>
          <UiButton as="a" variant="ghost" size="sm" href="/boards">К доскам</UiButton>
        </template>

        <UiEmptyState
          v-if="!loading && myCards.length === 0"
          title="Задач нет"
          description="Ничего не назначено"
          :icon="Trello"
        />

        <ul v-else class="divide-y">
          <li v-for="card in myCards" :key="card.cardId" class="flex items-center gap-3 py-3 first:pt-0">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{{ card.title }}</p>
              <p v-if="card.dueDate" class="text-muted-foreground text-xs">
                срок {{ formatDate(card.dueDate) }}
              </p>
            </div>
            <UiBadge v-if="card.estimateMinutes" variant="muted">
              {{ formatMinutes(card.estimateMinutes) }}
            </UiBadge>
          </li>
        </ul>
      </UiCard>

      <!-- ── Табель ────────────────────────────────────────────────── -->
      <UiCard title="Табель за месяц" :description="`${formatDate(period.from)} — ${formatDate(period.to)}`">
        <template #actions>
          <UiButton as="a" variant="ghost" size="sm" href="/timesheet">Подробно</UiButton>
        </template>

        <div v-if="timesheet" class="space-y-3">
          <div class="flex items-baseline justify-between">
            <span class="text-muted-foreground text-sm">Итого</span>
            <span class="text-lg font-semibold tabular">{{ timesheet.totalHours }} ч</span>
          </div>
          <div class="flex items-baseline justify-between">
            <span class="text-muted-foreground text-sm">Переработки</span>
            <span class="tabular text-sm">{{ formatMinutes(timesheet.totalOvertimeMinutes) }}</span>
          </div>
          <div class="flex items-baseline justify-between">
            <span class="text-muted-foreground text-sm">Дней в периоде</span>
            <span class="tabular text-sm">
              {{ timesheet.entries.length }}
              {{ plural(timesheet.entries.length, 'день', 'дня', 'дней') }}
            </span>
          </div>
          <UiBadge v-if="timesheet.closed" variant="success">Период закрыт</UiBadge>
        </div>

        <UiEmptyState
          v-else-if="!loading"
          title="Табель пуст"
          description="За этот период нет назначенных смен"
          :icon="CalendarDays"
        />
      </UiCard>
    </div>
  </div>
</template>
