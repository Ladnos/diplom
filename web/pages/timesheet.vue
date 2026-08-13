<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { CalendarDays } from 'lucide-vue-next';
import { useAuthStore } from '~/stores/auth';
import { formatDate, formatMinutes } from '~/lib/utils';
import type { Timesheet, TimesheetEntry } from '~/types/api';

const auth = useAuthStore();
const api = useApi();

const now = new Date();
const month = ref(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
const sheet = ref<Timesheet | null>(null);
const loading = ref(true);

const period = computed(() => {
  const [year, monthIndex] = month.value.split('-').map(Number);
  const from = new Date(Date.UTC(year, monthIndex - 1, 1));
  const to = new Date(Date.UTC(year, monthIndex, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
});

async function load() {
  loading.value = true;
  try {
    sheet.value = await api.get<Timesheet>('/api/timesheet', period.value);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(month, load);

/**
 * Источник значения показывается явно.
 *
 * Система НЕ измеряет фактическое время (ADR-2): норма берётся из
 * графика, переработка — из утверждённой заявки, правка — из
 * корректировки. Человек, глядя на число, должен понимать, откуда оно, —
 * иначе табель выглядит как результат слежки, которой нет.
 */
const sources: Record<string, { label: string; variant: string }> = {
  PLAN: { label: 'по графику', variant: 'muted' },
  FACT: { label: 'по факту', variant: 'default' },
  CORRECTION: { label: 'правка', variant: 'warning' },
};

const totals = computed(() => {
  const entries = sheet.value?.entries ?? [];
  return {
    norm: entries.reduce((sum, entry) => sum + entry.normMinutes, 0),
    absence: entries.reduce((sum, entry) => sum + entry.absenceMinutes, 0),
    overtime: entries.reduce((sum, entry) => sum + entry.overtimeMinutes, 0),
  };
});

const weekday = (date: string) =>
  new Intl.DateTimeFormat('ru-RU', { weekday: 'short' }).format(new Date(date));

const isWeekend = (date: string) => [0, 6].includes(new Date(date).getUTCDay());
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">Табель</h1>
        <p class="text-muted-foreground text-sm">
          Норма по графику − отсутствия + согласованные переработки
        </p>
      </div>
      <div class="space-y-1.5">
        <label class="text-sm font-medium">Период</label>
        <UiInput v-model="month" type="month" class="w-44" />
      </div>
    </div>

    <div class="grid gap-4 sm:grid-cols-4">
      <UiCard body-class="p-4">
        <p class="text-muted-foreground text-xs">Норма</p>
        <p class="mt-1 text-xl font-semibold tabular">{{ formatMinutes(totals.norm) }}</p>
      </UiCard>
      <UiCard body-class="p-4">
        <p class="text-muted-foreground text-xs">Отсутствия</p>
        <p class="mt-1 text-xl font-semibold tabular">{{ formatMinutes(totals.absence) }}</p>
      </UiCard>
      <UiCard body-class="p-4">
        <p class="text-muted-foreground text-xs">Переработки</p>
        <p class="mt-1 text-xl font-semibold tabular">{{ formatMinutes(totals.overtime) }}</p>
      </UiCard>
      <UiCard body-class="p-4">
        <p class="text-muted-foreground text-xs">Итого</p>
        <p class="mt-1 text-xl font-semibold tabular">
          {{ sheet ? `${sheet.totalHours} ч` : '—' }}
        </p>
        <UiBadge v-if="sheet?.closed" variant="success" class="mt-2">Период закрыт</UiBadge>
      </UiCard>
    </div>

    <UiCard body-class="p-0">
      <UiEmptyState
        v-if="!loading && (sheet?.entries.length ?? 0) === 0"
        title="За этот месяц записей нет"
        description="Табель наполняется назначенными сменами; если графика не было, он останется пустым"
        :icon="CalendarDays"
      />

      <UiDataTable
        v-else
        :loading="loading"
        :rows="sheet?.entries ?? []"
        :row-key="(row) => (row as TimesheetEntry).date"
        :columns="[
          { key: 'date', label: 'Дата' },
          { key: 'normMinutes', label: 'Норма', numeric: true },
          { key: 'absenceMinutes', label: 'Отсутствия', numeric: true },
          { key: 'overtimeMinutes', label: 'Переработка', numeric: true },
          { key: 'totalMinutes', label: 'Итого', numeric: true },
          { key: 'source', label: 'Источник' },
        ]"
      >
        <template #date="{ row }">
          <span :class="isWeekend((row as TimesheetEntry).date) ? 'text-muted-foreground' : ''">
            {{ formatDate((row as TimesheetEntry).date) }}
            <span class="text-muted-foreground ml-1 text-xs">{{ weekday((row as TimesheetEntry).date) }}</span>
          </span>
        </template>

        <template #normMinutes="{ row }">
          {{ (row as TimesheetEntry).normMinutes || '—' }}
        </template>
        <template #absenceMinutes="{ row }">
          <span :class="(row as TimesheetEntry).absenceMinutes ? 'text-warning' : 'text-muted-foreground'">
            {{ (row as TimesheetEntry).absenceMinutes || '—' }}
          </span>
        </template>
        <template #overtimeMinutes="{ row }">
          <span :class="(row as TimesheetEntry).overtimeMinutes ? 'text-success' : 'text-muted-foreground'">
            {{ (row as TimesheetEntry).overtimeMinutes || '—' }}
          </span>
        </template>
        <template #totalMinutes="{ row }">
          <span class="font-medium">{{ (row as TimesheetEntry).totalMinutes }}</span>
        </template>

        <template #source="{ row }">
          <UiBadge :variant="(sources[(row as TimesheetEntry).source]?.variant ?? 'muted') as never">
            {{ sources[(row as TimesheetEntry).source]?.label ?? (row as TimesheetEntry).source }}
          </UiBadge>
        </template>
      </UiDataTable>
    </UiCard>

    <p class="text-muted-foreground text-xs">
      Система не измеряет фактическое время прихода и ухода: табель считается от графика, а
      переработки попадают в него только через согласованную заявку.
    </p>
  </div>
</template>
