<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { CheckCircle2, FileCheck2, Plus } from 'lucide-vue-next';
import { useAuthStore } from '~/stores/auth';
import { formatDate, formatDateTime } from '~/lib/utils';
import { requestTitle, statusOf } from '~/lib/domain';
import type { RequestType, WorkRequest } from '~/types/api';

const auth = useAuthStore();
const api = useApi();
const { run, success } = useToast();

const tab = ref<'my' | 'inbox'>('my');
const loading = ref(true);
const my = ref<WorkRequest[]>([]);
const inbox = ref<WorkRequest[]>([]);
const types = ref<RequestType[]>([]);

const createOpen = ref(false);
const decisionOpen = ref(false);
const active = ref<WorkRequest | null>(null);
const comment = ref('');

const form = ref({ type: '', from: '', to: '', reason: '', minutes: 60, date: '' });

// Заявку можно открыть по ссылке из сводки или уведомления. Считываем в
// setup: после await композиции Nuxt теряют контекст приложения.
const requestFromQuery = useRoute().query.id;

const canApprove = computed(() => auth.isManager || auth.isHr);
const rows = computed(() => (tab.value === 'my' ? my.value : inbox.value));

onMounted(async () => {
  await Promise.all([loadMy(), loadTypes(), canApprove.value ? loadInbox() : Promise.resolve()]);
  loading.value = false;

  if (typeof requestFromQuery === 'string' && requestFromQuery) {
    const found = [...my.value, ...inbox.value].find(
      (item) => item.requestId === requestFromQuery,
    );
    if (found) openDecision(found);
  }
});

async function loadMy() {
  const result = await api.get<{ requests: WorkRequest[] }>('/api/requests/my', { limit: 100 });
  my.value = result.requests;
}

async function loadInbox() {
  const result = await api
    .get<{ requests: WorkRequest[] }>('/api/requests/inbox', { limit: 100 })
    .catch(() => ({ requests: [] }));
  inbox.value = result.requests;
}

async function loadTypes() {
  // Набор типов зависит от типа найма: подрядчику отпуск не положен, и
  // список приходит уже отфильтрованным сервисом (§3.3).
  const result = await api
    .get<{ types: RequestType[] }>('/api/requests/types')
    .catch(() => ({ types: [] }));
  types.value = result.types;
  form.value.type ||= result.types[0]?.type ?? '';
}

const typeOptions = computed(() =>
  types.value.map((item) => ({ value: item.type, label: item.title || requestTitle(item.type) })),
);

/** Форма заявки зависит от типа: у отпуска период, у переработки — минуты. */
const needsPeriod = computed(() =>
  ['VACATION', 'TIME_OFF', 'TRIP', 'UNPAID'].includes(form.value.type),
);
const needsMinutes = computed(() => form.value.type === 'OVERTIME');

async function create() {
  const payload: Record<string, unknown> = { reason: form.value.reason };
  if (needsPeriod.value) {
    payload.from = form.value.from;
    payload.to = form.value.to;
  }
  if (needsMinutes.value) {
    payload.date = form.value.date;
    payload.minutes = form.value.minutes;
  }

  const created = await run(
    () => api.post<WorkRequest>('/api/requests', { type: form.value.type, payload }),
    'Заявка отправлена',
  );
  if (!created) return;

  createOpen.value = false;
  form.value.reason = '';
  await loadMy();
}

function openDecision(request: WorkRequest) {
  active.value = request;
  comment.value = '';
  decisionOpen.value = true;
}

async function decide(approve: boolean) {
  if (!active.value) return;

  const path = `/api/requests/${active.value.requestId}/${approve ? 'approve' : 'reject'}`;
  const body = approve ? { comment: comment.value } : { reason: comment.value || 'без пояснения' };

  const result = await run(() => api.post(path, body));
  if (!result) return;

  decisionOpen.value = false;
  success(approve ? 'Заявка согласована' : 'Заявка отклонена');
  await Promise.all([loadMy(), loadInbox()]);
}

async function cancel(request: WorkRequest) {
  const result = await run(() => api.post(`/api/requests/${request.requestId}/cancel`, {}));
  if (result !== null) {
    success('Заявка отозвана');
    await loadMy();
  }
}

/** Payload у каждого типа свой — показываем его как есть, парами. */
function payloadPairs(payload: Record<string, unknown>) {
  const labels: Record<string, string> = {
    from: 'С',
    to: 'По',
    reason: 'Причина',
    minutes: 'Минут',
    date: 'Дата',
    type: 'Вид',
  };
  return Object.entries(payload)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => ({
      label: labels[key] ?? key,
      value: /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? formatDate(String(value)) : String(value),
    }));
}

watch(tab, () => {
  if (tab.value === 'inbox') void loadInbox();
});
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">Заявки</h1>
        <p class="text-muted-foreground text-sm">Отпуска, отгулы, переработки и корректировки</p>
      </div>
      <UiButton @click="createOpen = true">
        <Plus class="size-4" />
        Новая заявка
      </UiButton>
    </div>

    <div class="flex gap-1 border-b">
      <button
        v-for="item in [
          { key: 'my', label: `Мои (${my.length})` },
          ...(canApprove ? [{ key: 'inbox', label: `Ждут решения (${inbox.length})` }] : []),
        ]"
        :key="item.key"
        class="relative px-4 py-2 text-sm transition-colors"
        :class="tab === item.key ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'"
        @click="tab = item.key as 'my' | 'inbox'"
      >
        {{ item.label }}
        <span v-if="tab === item.key" class="bg-foreground absolute inset-x-0 -bottom-px h-0.5" />
      </button>
    </div>

    <UiCard body-class="p-0">
      <UiEmptyState
        v-if="!loading && rows.length === 0"
        :title="tab === 'my' ? 'Заявок пока нет' : 'Очередь пуста'"
        :description="
          tab === 'my'
            ? 'Отпуск, отгул и переработку оформляют кнопкой выше'
            : 'Ничего не ждёт вашего решения'
        "
        :icon="tab === 'my' ? FileCheck2 : CheckCircle2"
      />

      <UiDataTable
        v-else
        :loading="loading"
        :rows="rows"
        :row-key="(row) => (row as WorkRequest).requestId"
        :columns="[
          { key: 'type', label: 'Тип' },
          { key: 'author', label: 'Автор' },
          { key: 'payload', label: 'Содержание' },
          { key: 'status', label: 'Статус' },
          { key: 'actions', label: '', width: '1%' },
        ]"
      >
        <template #type="{ row }">
          <span class="font-medium">{{ requestTitle((row as WorkRequest).type) }}</span>
        </template>

        <template #author="{ row }">
          <div class="flex items-center gap-2">
            <UiAvatar
              :name="(row as WorkRequest).author.fullName"
              :id="(row as WorkRequest).author.employeeId"
              size="sm"
            />
            <span class="text-muted-foreground truncate text-xs">
              {{ (row as WorkRequest).author.fullName ?? '—' }}
            </span>
          </div>
        </template>

        <template #payload="{ row }">
          <span class="text-muted-foreground text-xs">
            {{
              payloadPairs((row as WorkRequest).payload)
                .map((pair) => `${pair.label}: ${pair.value}`)
                .join(' · ') || '—'
            }}
          </span>
        </template>

        <template #status="{ row }">
          <UiBadge :variant="statusOf((row as WorkRequest).status).variant as never">
            {{ statusOf((row as WorkRequest).status).label }}
          </UiBadge>
        </template>

        <template #actions="{ row }">
          <div class="flex justify-end gap-2">
            <UiButton
              v-if="tab === 'inbox'"
              size="sm"
              @click.stop="openDecision(row as WorkRequest)"
            >
              Рассмотреть
            </UiButton>
            <UiButton
              v-else-if="(row as WorkRequest).status === 'PENDING'"
              size="sm"
              variant="outline"
              @click.stop="cancel(row as WorkRequest)"
            >
              Отозвать
            </UiButton>
          </div>
        </template>
      </UiDataTable>
    </UiCard>

    <!-- ── Новая заявка ────────────────────────────────────────────── -->
    <UiDialog
      v-model:open="createOpen"
      title="Новая заявка"
      description="Маршрут согласования построится из оргструктуры"
    >
      <form class="space-y-4" @submit.prevent="create">
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Тип</label>
          <UiSelect v-model="form.type" :options="typeOptions" placeholder="Выберите тип" />
          <p v-if="typeOptions.length === 0" class="text-muted-foreground text-xs">
            Для вашего типа найма заявки недоступны
          </p>
        </div>

        <div v-if="needsPeriod" class="grid grid-cols-2 gap-3">
          <div class="space-y-1.5">
            <label class="text-sm font-medium">С</label>
            <UiInput v-model="form.from" type="date" required />
          </div>
          <div class="space-y-1.5">
            <label class="text-sm font-medium">По</label>
            <UiInput v-model="form.to" type="date" required />
          </div>
        </div>

        <div v-if="needsMinutes" class="grid grid-cols-2 gap-3">
          <div class="space-y-1.5">
            <label class="text-sm font-medium">Дата</label>
            <UiInput v-model="form.date" type="date" required />
          </div>
          <div class="space-y-1.5">
            <label class="text-sm font-medium">Минут</label>
            <UiInput v-model.number="form.minutes" type="number" min="15" step="15" required />
          </div>
        </div>

        <div class="space-y-1.5">
          <label class="text-sm font-medium">Причина</label>
          <UiTextarea v-model="form.reason" placeholder="Коротко о причине" />
        </div>

        <div class="flex justify-end gap-2">
          <UiButton type="button" variant="outline" @click="createOpen = false">Отмена</UiButton>
          <UiButton type="submit" :disabled="!form.type">Отправить</UiButton>
        </div>
      </form>
    </UiDialog>

    <!-- ── Решение по заявке ───────────────────────────────────────── -->
    <UiDialog v-model:open="decisionOpen" :title="active ? requestTitle(active.type) : 'Заявка'">
      <div v-if="active" class="space-y-4">
        <div class="flex items-center gap-3">
          <UiAvatar :name="active.author.fullName" :id="active.author.employeeId" />
          <div>
            <p class="text-sm font-medium">{{ active.author.fullName ?? '—' }}</p>
            <p class="text-muted-foreground text-xs">автор заявки</p>
          </div>
        </div>

        <dl class="bg-muted/40 space-y-2 rounded-lg p-3 text-sm">
          <div v-for="pair in payloadPairs(active.payload)" :key="pair.label" class="flex justify-between gap-4">
            <dt class="text-muted-foreground">{{ pair.label }}</dt>
            <dd class="text-right font-medium">{{ pair.value }}</dd>
          </div>
        </dl>

        <!-- Маршрут виден целиком: согласующий должен понимать, он
             последний или после него будет ещё кто-то -->
        <div v-if="active.steps.length > 0" class="space-y-2">
          <p class="text-muted-foreground text-xs font-medium">Маршрут согласования</p>
          <ol class="space-y-1.5">
            <li
              v-for="step in active.steps"
              :key="step.order"
              class="flex items-center gap-2 text-sm"
              :class="step.order === active.currentStep ? 'font-medium' : 'text-muted-foreground'"
            >
              <span
                class="grid size-5 shrink-0 place-items-center rounded-full text-[10px]"
                :class="
                  step.status === 'APPROVED'
                    ? 'bg-success/15 text-success'
                    : step.order === active.currentStep
                      ? 'bg-warning/15 text-warning'
                      : 'bg-muted text-muted-foreground'
                "
              >
                {{ step.order + 1 }}
              </span>
              <span class="truncate">{{ step.approver.fullName ?? step.approver.employeeId }}</span>
              <span v-if="step.decidedAt" class="text-muted-foreground ml-auto shrink-0 text-xs">
                {{ formatDateTime(step.decidedAt) }}
              </span>
            </li>
          </ol>
        </div>

        <div class="space-y-1.5">
          <label class="text-sm font-medium">Комментарий</label>
          <UiTextarea v-model="comment" placeholder="Необязательно при согласовании, обязателен при отказе" />
        </div>

        <div class="flex justify-end gap-2">
          <UiButton variant="outline" @click="decisionOpen = false">Закрыть</UiButton>
          <UiButton variant="destructive" @click="decide(false)">Отклонить</UiButton>
          <UiButton @click="decide(true)">Согласовать</UiButton>
        </div>
      </div>
    </UiDialog>
  </div>
</template>
