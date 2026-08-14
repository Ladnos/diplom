<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Building2, Plus, Trash2, Users } from 'lucide-vue-next';
import { useAuthStore } from '~/stores/auth';

/**
 * Справочник подразделений.
 *
 * Две разные роли работают на одной странице, и это видно по составу
 * действий. Кадровая служба заводит, переименовывает и расформировывает
 * отделы — от них зависит область видимости DEPARTMENT, поэтому создание
 * отдела это создание границы доступа. Линейный руководитель видит тот же
 * справочник, но управляет ровно одним подразделением — своим, и переводит
 * в него только собственных подчинённых.
 */
const auth = useAuthStore();
const api = useApi();
const { run, success } = useToast();

interface Department {
  departmentId: string;
  name: string;
  parentId: string | null;
  employeeCount: number;
  createdAt: string;
}

interface Member {
  employeeId: string;
  fullName: string;
  position: string | null;
  managerId: string | null;
  active: boolean;
}

const departments = ref<Department[]>([]);
const loading = ref(true);
const search = ref('');

const createOpen = ref(false);
const form = ref({ name: '', parentId: '' });

const active = ref<Department | null>(null);
const membersOpen = ref(false);
const members = ref<Member[]>([]);
const membersLoading = ref(false);
const toAssign = ref<string[]>([]);
const assigning = ref(false);

const renameOpen = ref(false);
const renameForm = ref({ name: '', parentId: '' });

/** Кадровая служба и администратор — полный набор действий. */
const canManage = computed(() => auth.isHr);
/** Своё подразделение руководителя: только в него он может переводить. */
const ownDepartmentId = computed(() => auth.me?.employee?.departmentId ?? null);

onMounted(load);

async function load() {
  loading.value = true;
  try {
    const result = await api.get<{ departments: Department[] }>('/api/departments', {
      search: search.value.trim() || undefined,
    });
    departments.value = result.departments;
  } finally {
    loading.value = false;
  }
}

const parentOptions = computed(() => [
  { value: '', label: 'Верхний уровень' },
  ...departments.value
    .filter((item) => item.departmentId !== active.value?.departmentId)
    .map((item) => ({ value: item.departmentId, label: item.name })),
]);

const nameById = computed(
  () => new Map(departments.value.map((item) => [item.departmentId, item.name])),
);

async function create() {
  const created = await run(
    () =>
      api.post<Department>('/api/departments', {
        name: form.value.name.trim(),
        parentId: form.value.parentId || undefined,
      }),
    'Подразделение заведено',
  );
  if (!created) return;

  createOpen.value = false;
  form.value = { name: '', parentId: '' };
  await load();
}

async function openMembers(department: Department) {
  active.value = department;
  membersOpen.value = true;
  toAssign.value = [];
  membersLoading.value = true;
  try {
    const result = await api
      .get<{ employees: Member[] }>(`/api/departments/${department.departmentId}/employees`)
      .catch(() => ({ employees: [] }));
    members.value = result.employees;
  } finally {
    membersLoading.value = false;
  }
}

/**
 * Перевести можно либо любого (кадровая служба), либо своих подчинённых
 * в своё подразделение (руководитель). Второй случай ограничен и на
 * сервере: интерфейс лишь не предлагает заведомо запрещённого.
 */
const canAssignHere = computed(
  () => canManage.value || (active.value?.departmentId === ownDepartmentId.value),
);

async function assign() {
  if (!active.value || toAssign.value.length === 0) return;
  assigning.value = true;
  try {
    const result = await run(
      () =>
        api.post<{ moved: number }>(`/api/departments/${active.value!.departmentId}/employees`, {
          employeeIds: toAssign.value,
        }),
    );
    if (result === null) return;

    success(
      result.moved > 0 ? `Переведено: ${result.moved}` : 'Все выбранные уже числятся здесь',
      result.moved > 0 ? 'Область видимости обновится в течение нескольких секунд' : undefined,
    );
    toAssign.value = [];
    await Promise.all([openMembers(active.value), load()]);
  } finally {
    assigning.value = false;
  }
}

function openRename(department: Department) {
  active.value = department;
  renameForm.value = { name: department.name, parentId: department.parentId ?? '' };
  renameOpen.value = true;
}

async function rename() {
  if (!active.value) return;

  const before = active.value;
  const result = await run(
    () =>
      api.patch<Department>(`/api/departments/${before.departmentId}`, {
        name: renameForm.value.name.trim(),
        // Пустой родитель значит «не менять»: поднять в корень надо
        // просить отдельным признаком — иначе это неотличимо.
        ...(renameForm.value.parentId
          ? { parentId: renameForm.value.parentId }
          : before.parentId
            ? { detachParent: true }
            : {}),
      }),
    'Подразделение изменено',
  );
  if (!result) return;

  renameOpen.value = false;
  await load();
}

async function remove(department: Department) {
  const result = await run(
    () => api.delete(`/api/departments/${department.departmentId}`),
    'Подразделение расформировано',
  );
  if (result === null) return;
  await load();
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">Подразделения</h1>
        <p class="text-muted-foreground text-sm">
          Отдел задаёт область видимости: коллеги по нему видны друг другу
        </p>
      </div>
      <div class="flex items-center gap-2">
        <UiInput
          v-model="search"
          placeholder="Поиск по названию"
          class="w-56"
          @keyup.enter="load"
        />
        <UiButton v-if="canManage" @click="createOpen = true">
          <Plus class="size-4" />
          Новое
        </UiButton>
      </div>
    </div>

    <UiCard body-class="p-0">
      <UiEmptyState
        v-if="!loading && departments.length === 0"
        title="Подразделений пока нет"
        :description="
          canManage
            ? 'Заведите первое — после этого сотрудников можно распределять по отделам'
            : 'Их заводит кадровая служба'
        "
        :icon="Building2"
      >
        <UiButton v-if="canManage" class="mt-2" @click="createOpen = true">Завести</UiButton>
      </UiEmptyState>

      <UiDataTable
        v-else
        :loading="loading"
        :rows="departments"
        :row-key="(row) => (row as Department).departmentId"
        :columns="[
          { key: 'name', label: 'Название' },
          { key: 'parent', label: 'Входит в' },
          { key: 'employeeCount', label: 'Сотрудников', numeric: true },
          { key: 'actions', label: '', width: '1%' },
        ]"
      >
        <template #name="{ row }">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium">{{ (row as Department).name }}</span>
            <UiBadge
              v-if="(row as Department).departmentId === ownDepartmentId"
              variant="secondary"
            >
              ваш отдел
            </UiBadge>
          </div>
        </template>

        <template #parent="{ row }">
          <span class="text-muted-foreground text-sm">
            {{
              (row as Department).parentId
                ? (nameById.get((row as Department).parentId!) ?? '—')
                : '—'
            }}
          </span>
        </template>

        <template #employeeCount="{ row }">
          <span class="tabular text-sm">{{ (row as Department).employeeCount }}</span>
        </template>

        <template #actions="{ row }">
          <div class="flex justify-end gap-2">
            <UiButton size="sm" variant="outline" @click.stop="openMembers(row as Department)">
              <Users class="size-4" />
              Состав
            </UiButton>
            <UiButton
              v-if="canManage"
              size="sm"
              variant="ghost"
              @click.stop="openRename(row as Department)"
            >
              Изменить
            </UiButton>
            <UiButton
              v-if="canManage && (row as Department).employeeCount === 0"
              size="icon-sm"
              variant="ghost"
              title="Расформировать"
              @click.stop="remove(row as Department)"
            >
              <Trash2 class="size-4" />
            </UiButton>
          </div>
        </template>
      </UiDataTable>
    </UiCard>

    <!-- ── Состав подразделения ────────────────────────────────────── -->
    <UiDialog
      v-model:open="membersOpen"
      :title="active?.name ?? 'Состав'"
      description="Перевод меняет область видимости: коллеги по отделу увидят друг друга"
    >
      <div class="space-y-4">
        <p v-if="membersLoading" class="text-muted-foreground text-sm">Загрузка…</p>

        <div v-else class="space-y-1">
          <p v-if="members.length === 0" class="text-muted-foreground text-sm">
            В подразделении пока никого нет
          </p>
          <div
            v-for="member in members"
            :key="member.employeeId"
            class="flex items-center gap-2 py-1"
          >
            <UiAvatar :name="member.fullName" :id="member.employeeId" size="sm" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm">{{ member.fullName }}</p>
              <p v-if="member.position" class="text-muted-foreground truncate text-xs">
                {{ member.position }}
              </p>
            </div>
            <UiBadge v-if="!member.active" variant="muted">уволен</UiBadge>
          </div>
        </div>

        <div v-if="canAssignHere" class="space-y-2 border-t pt-4">
          <p class="text-muted-foreground text-xs font-medium">Перевести сюда</p>
          <EmployeePicker
            v-model="toAssign"
            multiple
            :relation="canManage ? undefined : 'subordinates'"
            :exclude="members.map((member) => member.employeeId)"
          />
          <p v-if="!canManage" class="text-muted-foreground text-xs">
            Руководителю доступны только собственные подчинённые: перевод в свой отдел даёт
            доступ к данным сотрудника, и переводить чужих людей нельзя
          </p>
          <div class="flex justify-end">
            <UiButton :disabled="toAssign.length === 0" :loading="assigning" @click="assign">
              Перевести
            </UiButton>
          </div>
        </div>

        <p v-else class="text-muted-foreground border-t pt-4 text-xs">
          Переводить сотрудников в это подразделение может кадровая служба
        </p>
      </div>
    </UiDialog>

    <!-- ── Заведение ───────────────────────────────────────────────── -->
    <UiDialog v-model:open="createOpen" title="Новое подразделение">
      <form class="space-y-4" @submit.prevent="create">
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Название</label>
          <UiInput v-model="form.name" placeholder="Например, Отдел разработки" required />
        </div>
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Входит в</label>
          <UiSelect
            v-model="form.parentId"
            :options="parentOptions"
            placeholder="Верхний уровень"
          />
        </div>
        <div class="flex justify-end gap-2">
          <UiButton type="button" variant="outline" @click="createOpen = false">Отмена</UiButton>
          <UiButton type="submit" :disabled="!form.name.trim()">Завести</UiButton>
        </div>
      </form>
    </UiDialog>

    <!-- ── Переименование и перенос ────────────────────────────────── -->
    <UiDialog v-model:open="renameOpen" :title="active?.name ?? 'Подразделение'">
      <form class="space-y-4" @submit.prevent="rename">
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Название</label>
          <UiInput v-model="renameForm.name" required />
        </div>
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Входит в</label>
          <UiSelect
            v-model="renameForm.parentId"
            :options="parentOptions"
            placeholder="Верхний уровень"
          />
          <p class="text-muted-foreground text-xs">
            Подчинить подразделение собственному потомку нельзя — ветка замкнулась бы в кольцо
          </p>
        </div>
        <div class="flex justify-end gap-2">
          <UiButton type="button" variant="outline" @click="renameOpen = false">Отмена</UiButton>
          <UiButton type="submit" :disabled="!renameForm.name.trim()">Сохранить</UiButton>
        </div>
      </form>
    </UiDialog>
  </div>
</template>
