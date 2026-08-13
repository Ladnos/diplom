<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { BarChart3, Download, ScrollText } from 'lucide-vue-next';
import { useAuthStore } from '~/stores/auth';
import { formatDateTime, formatMinutes } from '~/lib/utils';
import { eventTitle } from '~/lib/domain';

const auth = useAuthStore();
const api = useApi();
const { run, success, error } = useToast();

const now = new Date();
const from = ref(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10));
const to = ref(now.toISOString().slice(0, 10));
const tab = ref<'time' | 'approvals' | 'meetings' | 'audit'>('time');

const time = ref<{ rows: Row[]; totalNormMinutes: number; totalOvertimeMinutes: number } | null>(null);
const approvals = ref<Record<string, number> | null>(null);
const meetings = ref<Record<string, number> | null>(null);
const audit = ref<AuditEntry[]>([]);
const auditFilter = ref('');
const loading = ref(false);
const exporting = ref(false);

interface Row {
  employeeId: string;
  fullName: string | null;
  normMinutes: number;
  absenceMinutes: number;
  overtimeMinutes: number;
  totalMinutes: number;
}

interface AuditEntry {
  eventId: string;
  eventType: string;
  producer: string;
  actor: { employeeId: string; userId: string | null } | null;
  correlationId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

const period = computed(() => ({ from: from.value, to: to.value }));

onMounted(load);
watch([from, to, tab], load);

async function load() {
  loading.value = true;
  try {
    if (tab.value === 'time') {
      time.value = await api.get('/api/reports/time', period.value);
    } else if (tab.value === 'approvals') {
      approvals.value = await api.get('/api/reports/approvals', period.value);
    } else if (tab.value === 'meetings') {
      meetings.value = await api.get('/api/reports/meetings', period.value);
    } else {
      const result = await api.get<{ entries: AuditEntry[] }>('/api/reports/audit', {
        ...period.value,
        eventType: auditFilter.value || undefined,
        limit: 100,
      });
      audit.value = result.entries;
    }
  } catch (caught) {
    error('Отчёт не построился', caught instanceof Error ? caught.message : '');
  } finally {
    loading.value = false;
  }
}

/**
 * Выгрузка идёт билетом, а не файлом сразу: отчёт за год считается
 * секундами, и держать запрос всё это время незачем. Опрашиваем билет,
 * пока он не будет готов.
 */
async function exportReport(reportType: string) {
  exporting.value = true;
  try {
    const ticket = await api.post<{ ticketId: string }>(
      `/api/reports/export?from=${from.value}&to=${to.value}`,
      { reportType },
    );

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const status = await api.get<{ status: string; ready: boolean; error: string | null }>(
        `/api/reports/export/${ticket.ticketId}`,
      );

      if (status.ready) {
        await api.download(`/api/reports/export/${ticket.ticketId}/download`);
        success('Выгрузка готова', 'CSV откроется в Excel без настроек');
        return;
      }
      if (status.status === 'FAILED') {
        error('Выгрузка не собралась', status.error ?? '');
        return;
      }
    }
    error('Выгрузка не успела', 'Попробуйте ещё раз или сузьте период');
  } catch (caught) {
    error('Не удалось выгрузить', caught instanceof Error ? caught.message : '');
  } finally {
    exporting.value = false;
  }
}

const tabs = computed(() =>
  [
    { key: 'time', label: 'Рабочее время', show: true },
    { key: 'approvals', label: 'Согласования', show: true },
    { key: 'meetings', label: 'Встречи', show: true },
    { key: 'audit', label: 'Журнал аудита', show: auth.isAdmin },
  ].filter((item) => item.show),
);

const exportType = computed(
  () => ({ time: 'TIME_UTILIZATION', approvals: 'APPROVALS', meetings: 'MEETINGS', audit: '' })[tab.value],
);
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">Отчёты</h1>
        <p class="text-muted-foreground text-sm">Считаются по витринам, а не по живым базам</p>
      </div>

      <div class="flex flex-wrap items-end gap-2">
        <div class="space-y-1.5">
          <label class="text-sm font-medium">С</label>
          <UiInput v-model="from" type="date" class="w-40" />
        </div>
        <div class="space-y-1.5">
          <label class="text-sm font-medium">По</label>
          <UiInput v-model="to" type="date" class="w-40" />
        </div>
        <UiButton v-if="exportType" variant="outline" :loading="exporting" @click="exportReport(exportType)">
          <Download class="size-4" />
          Выгрузить
        </UiButton>
      </div>
    </div>

    <div class="flex gap-1 border-b">
      <button
        v-for="item in tabs"
        :key="item.key"
        class="relative px-4 py-2 text-sm transition-colors"
        :class="tab === item.key ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'"
        @click="tab = item.key as typeof tab"
      >
        {{ item.label }}
        <span v-if="tab === item.key" class="bg-foreground absolute inset-x-0 -bottom-px h-0.5" />
      </button>
    </div>

    <!-- ── Рабочее время ───────────────────────────────────────────── -->
    <template v-if="tab === 'time'">
      <div class="grid gap-4 sm:grid-cols-3">
        <UiCard body-class="p-4">
          <p class="text-muted-foreground text-xs">Норма по команде</p>
          <p class="mt-1 text-xl font-semibold tabular">
            {{ formatMinutes(time?.totalNormMinutes ?? 0) }}
          </p>
        </UiCard>
        <UiCard body-class="p-4">
          <p class="text-muted-foreground text-xs">Переработки</p>
          <p class="mt-1 text-xl font-semibold tabular">
            {{ formatMinutes(time?.totalOvertimeMinutes ?? 0) }}
          </p>
        </UiCard>
        <UiCard body-class="p-4">
          <p class="text-muted-foreground text-xs">Сотрудников</p>
          <p class="mt-1 text-xl font-semibold tabular">{{ time?.rows.length ?? 0 }}</p>
        </UiCard>
      </div>

      <UiCard body-class="p-0">
        <UiEmptyState
          v-if="!loading && (time?.rows.length ?? 0) === 0"
          title="Данных за период нет"
          description="Витрина наполняется событиями: смены, отсутствия и утверждённые переработки"
          :icon="BarChart3"
        />

        <UiDataTable
          v-else
          :loading="loading"
          :rows="time?.rows ?? []"
          :row-key="(row) => (row as Row).employeeId"
          :columns="[
            { key: 'fullName', label: 'Сотрудник' },
            { key: 'normMinutes', label: 'Норма', numeric: true },
            { key: 'absenceMinutes', label: 'Отсутствия', numeric: true },
            { key: 'overtimeMinutes', label: 'Переработки', numeric: true },
            { key: 'totalMinutes', label: 'Итого', numeric: true },
          ]"
        >
          <template #fullName="{ row }">
            <div class="flex items-center gap-2">
              <UiAvatar :name="(row as Row).fullName" :id="(row as Row).employeeId" size="sm" />
              <span class="truncate text-sm">{{ (row as Row).fullName ?? '—' }}</span>
            </div>
          </template>
          <template #normMinutes="{ row }">{{ formatMinutes((row as Row).normMinutes) }}</template>
          <template #absenceMinutes="{ row }">{{ formatMinutes((row as Row).absenceMinutes) }}</template>
          <template #overtimeMinutes="{ row }">{{ formatMinutes((row as Row).overtimeMinutes) }}</template>
          <template #totalMinutes="{ row }">
            <span class="font-medium">{{ formatMinutes((row as Row).totalMinutes) }}</span>
          </template>
        </UiDataTable>
      </UiCard>
    </template>

    <!-- ── Согласования ────────────────────────────────────────────── -->
    <div v-else-if="tab === 'approvals'" class="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      <UiCard v-for="item in [
        { key: 'created', label: 'Создано' },
        { key: 'approved', label: 'Согласовано' },
        { key: 'rejected', label: 'Отклонено' },
        { key: 'expired', label: 'Просрочено' },
        { key: 'avgDecisionHours', label: 'Среднее решение, ч' },
      ]" :key="item.key" body-class="p-4">
        <p class="text-muted-foreground text-xs">{{ item.label }}</p>
        <p class="mt-1 text-2xl font-semibold tabular">{{ approvals?.[item.key] ?? 0 }}</p>
      </UiCard>
    </div>

    <!-- ── Встречи ─────────────────────────────────────────────────── -->
    <div v-else-if="tab === 'meetings'" class="space-y-4">
      <div class="grid gap-4 sm:grid-cols-3">
        <UiCard body-class="p-4">
          <p class="text-muted-foreground text-xs">Звонков</p>
          <p class="mt-1 text-2xl font-semibold tabular">{{ meetings?.callCount ?? 0 }}</p>
        </UiCard>
        <UiCard body-class="p-4">
          <p class="text-muted-foreground text-xs">Суммарно</p>
          <p class="mt-1 text-2xl font-semibold tabular">
            {{ formatMinutes(meetings?.totalDurationMinutes ?? 0) }}
          </p>
        </UiCard>
        <UiCard body-class="p-4">
          <p class="text-muted-foreground text-xs">Среднее участников</p>
          <p class="mt-1 text-2xl font-semibold tabular">{{ meetings?.avgParticipants ?? 0 }}</p>
        </UiCard>
      </div>

      <p class="text-muted-foreground text-xs">
        Статистика агрегированная и по команде целиком: длительность звонков никогда не относится
        к конкретному сотруднику и не используется для контроля дисциплины.
      </p>
    </div>

    <!-- ── Журнал аудита ───────────────────────────────────────────── -->
    <template v-else>
      <div class="flex items-end gap-2">
        <div class="flex-1 space-y-1.5">
          <label class="text-sm font-medium">Тип события</label>
          <UiInput v-model="auditFilter" placeholder="Например, approval — покроет все согласования" />
        </div>
        <UiButton variant="outline" @click="load">Применить</UiButton>
      </div>

      <UiCard body-class="p-0">
        <UiEmptyState
          v-if="!loading && audit.length === 0"
          title="Записей нет"
          description="Журнал наполняется всеми событиями системы"
          :icon="ScrollText"
        />

        <UiDataTable
          v-else
          :loading="loading"
          :rows="audit"
          :row-key="(row) => (row as AuditEntry).eventId"
          :columns="[
            { key: 'occurredAt', label: 'Когда', width: '160px' },
            { key: 'eventType', label: 'Событие' },
            { key: 'producer', label: 'Сервис' },
            { key: 'actor', label: 'Кто' },
          ]"
        >
          <template #occurredAt="{ row }">
            <span class="text-muted-foreground text-xs">
              {{ formatDateTime((row as AuditEntry).occurredAt) }}
            </span>
          </template>
          <template #eventType="{ row }">
            <div>
              <p class="text-sm">{{ eventTitle((row as AuditEntry).eventType) }}</p>
              <p class="text-muted-foreground font-mono text-[11px]">
                {{ (row as AuditEntry).eventType }}
              </p>
            </div>
          </template>
          <template #producer="{ row }">
            <UiBadge variant="muted">{{ (row as AuditEntry).producer }}</UiBadge>
          </template>
          <template #actor="{ row }">
            <span class="text-muted-foreground text-xs">
              {{ (row as AuditEntry).actor?.employeeId?.slice(0, 8) ?? 'система' }}
            </span>
          </template>
        </UiDataTable>
      </UiCard>
    </template>
  </div>
</template>
