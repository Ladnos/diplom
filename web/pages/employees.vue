<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { Users } from 'lucide-vue-next';
import { useApi } from '~/composables/useApi';
import { EMPLOYMENT_TYPES, PAYMENT_FORMS, TIME_POLICIES } from '~/lib/domain';
import type { EmployeeRow } from '~/types/api';

const api = useApi();
const { run, success } = useToast();

const loading = ref(true);
const employees = ref<EmployeeRow[]>([]);
const search = ref('');
const note = ref('');

const editOpen = ref(false);
const active = ref<EmployeeRow | null>(null);
const form = ref({ position: '', departmentId: '', managerId: '' });

onMounted(load);

/**
 * Поиск идёт на сервере, а не по загруженному списку: выдача ограничена
 * правами и объёмом, и человек, не попавший в первую сотню, при
 * локальной фильтрации не нашёлся бы вовсе.
 */
let timer: ReturnType<typeof setTimeout> | undefined;
watch(search, () => {
  clearTimeout(timer);
  timer = setTimeout(() => void load(), 250);
});

async function load() {
  loading.value = true;
  try {
    const result = await api.get<{ employees: EmployeeRow[]; note?: string }>('/api/employees', {
      limit: 200,
      search: search.value.trim() || undefined,
    });
    employees.value = result.employees;
    note.value = result.note ?? '';
  } finally {
    loading.value = false;
  }
}

function edit(employee: EmployeeRow) {
  active.value = employee;
  form.value = {
    position: employee.position ?? '',
    departmentId: employee.departmentId ?? '',
    managerId: employee.managerId ?? '',
  };
  editOpen.value = true;
}

async function save() {
  if (!active.value) return;

  // Пустые поля не отправляем: сервис отличает «не менять» от «очистить»,
  // и пустая строка в поле UUID станет ошибкой приведения типа.
  const body: Record<string, string> = {};
  if (form.value.position) body.position = form.value.position;
  if (form.value.departmentId) body.departmentId = form.value.departmentId;
  if (form.value.managerId) body.managerId = form.value.managerId;

  const result = await run(() => api.patch(`/api/employees/${active.value!.employeeId}`, body));
  if (result === null) return;

  editOpen.value = false;
  success('Карточка обновлена', 'Изменение руководителя перестроит маршруты согласования');
  await load();
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">Сотрудники</h1>
        <p class="text-muted-foreground text-sm">
          Тип найма определяет, какие подсистемы к человеку применимы
        </p>
      </div>
      <UiInput v-model="search" placeholder="Поиск по имени или должности" class="w-64" />
    </div>

    <UiCard body-class="p-0">
      <UiEmptyState
        v-if="!loading && employees.length === 0"
        title="Никого не нашлось"
        :description="note || (search ? 'Попробуйте изменить запрос' : 'Список сотрудников пуст')"
        :icon="Users"
      />

      <UiDataTable
        v-else
        :loading="loading"
        :rows="employees"
        :row-key="(row) => (row as EmployeeRow).employeeId"
        :columns="[
          { key: 'fullName', label: 'Сотрудник' },
          { key: 'position', label: 'Должность' },
          { key: 'employment', label: 'Тип найма' },
          { key: 'policy', label: 'Учёт времени' },
          { key: 'actions', label: '', width: '1%' },
        ]"
      >
        <template #fullName="{ row }">
          <div class="flex items-center gap-2">
            <UiAvatar :name="(row as EmployeeRow).fullName" :id="(row as EmployeeRow).employeeId" size="sm" />
            <div class="min-w-0">
              <p class="truncate text-sm font-medium">{{ (row as EmployeeRow).fullName }}</p>
              <p v-if="!(row as EmployeeRow).active" class="text-muted-foreground text-xs">уволен</p>
            </div>
          </div>
        </template>

        <template #position="{ row }">
          <span class="text-muted-foreground text-sm">{{ (row as EmployeeRow).position || '—' }}</span>
        </template>

        <template #employment="{ row }">
          <div v-if="(row as EmployeeRow).employment" class="space-y-0.5">
            <p class="text-sm">
              {{ EMPLOYMENT_TYPES[(row as EmployeeRow).employment!.type] ?? (row as EmployeeRow).employment!.type }}
            </p>
            <p class="text-muted-foreground text-xs">
              {{ PAYMENT_FORMS[(row as EmployeeRow).employment!.paymentForm] ?? '' }}
              · ставка {{ (row as EmployeeRow).employment!.rate }}
            </p>
          </div>
          <span v-else class="text-muted-foreground text-sm">—</span>
        </template>

        <template #policy="{ row }">
          <UiBadge
            v-if="(row as EmployeeRow).employment"
            variant="outline"
            :title="TIME_POLICIES[(row as EmployeeRow).employment!.policy]?.hint"
          >
            {{ TIME_POLICIES[(row as EmployeeRow).employment!.policy]?.label ?? '—' }}
          </UiBadge>
        </template>

        <template #actions="{ row }">
          <div class="flex justify-end">
            <UiButton size="sm" variant="outline" @click.stop="edit(row as EmployeeRow)">
              Изменить
            </UiButton>
          </div>
        </template>
      </UiDataTable>
    </UiCard>

    <UiDialog
      v-model:open="editOpen"
      :title="active?.fullName ?? 'Сотрудник'"
      description="Смена руководителя перестроит маршруты открытых заявок"
    >
      <form class="space-y-4" @submit.prevent="save">
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Должность</label>
          <UiInput v-model="form.position" placeholder="Например, ведущий инженер" />
        </div>

        <!-- Руководителем можно назначить любого, кроме самого сотрудника:
             цикл в оргструктуре сломал бы построение маршрута согласования -->
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Руководитель</label>
          <EmployeePicker
            v-model="form.managerId"
            :exclude="active ? [active.employeeId] : []"
            placeholder="Найти руководителя"
          />
          <p class="text-muted-foreground text-xs">
            От него строится маршрут согласования и права на подчинённых. Пока руководителя нет,
            заявки сотрудника утверждаются сразу — согласовывать их некому.
          </p>
        </div>

        <div class="space-y-1.5">
          <label class="text-sm font-medium">Отдел</label>
          <UiInput v-model="form.departmentId" placeholder="Идентификатор отдела" />
          <p class="text-muted-foreground text-xs">
            Отделы заводит кадровая служба — здесь указывается готовый идентификатор
          </p>
        </div>

        <div class="flex justify-end gap-2">
          <UiButton type="button" variant="outline" @click="editOpen = false">Отмена</UiButton>
          <UiButton type="submit">Сохранить</UiButton>
        </div>
      </form>
    </UiDialog>
  </div>
</template>
