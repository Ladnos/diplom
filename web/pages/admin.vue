<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Shield, ShieldOff } from 'lucide-vue-next';
import { formatDateTime } from '~/lib/utils';
import { ROLE_TITLES } from '~/lib/domain';

const api = useApi();
const { run, success } = useToast();

interface Role {
  code: string;
  name: string;
  userCount: number;
  permissions: { resource: string; action: string; scope: string }[];
}

interface UserRow {
  userId: string;
  email: string;
  status: string;
  employeeId: string | null;
  fullName: string | null;
  /** Коды ролей строками: признак «выдана автоматически» есть только в карточке. */
  roles: string[];
}

/**
 * Карточка пользователя.
 *
 * Список отдаёт роли кодами, и по нему нельзя понять, какие из них выданы
 * системой из оргструктуры: снять такую роль вручную нельзя, и кнопка
 * «Снять» рядом с ней вводила бы в заблуждение. Признак приходит только
 * в GET /api/admin/users/:id, поэтому карточка грузится отдельно.
 */
interface UserDetails extends UserRow {
  grants: {
    roleCode: string;
    roleName: string;
    auto: boolean;
    assignedAt: number;
  }[];
}

const users = ref<UserRow[]>([]);
const roles = ref<Role[]>([]);
const loading = ref(true);
const search = ref('');

const rolesOpen = ref(false);
const active = ref<UserDetails | null>(null);
const activeLoading = ref(false);
const roleToGrant = ref('');

onMounted(async () => {
  await Promise.all([loadUsers(), loadRoles()]);
  loading.value = false;
});

async function loadUsers() {
  const result = await api.get<{ users: UserRow[] }>('/api/admin/users', { limit: 200 });
  users.value = result.users;
}

async function loadRoles() {
  const result = await api.get<{ roles: Role[] }>('/api/admin/roles');
  roles.value = result.roles;
}

const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return users.value;
  return users.value.filter(
    (user) =>
      user.email.toLowerCase().includes(query) ||
      (user.fullName ?? '').toLowerCase().includes(query),
  );
});

async function openRoles(user: UserRow) {
  roleToGrant.value = '';
  rolesOpen.value = true;
  activeLoading.value = true;
  try {
    active.value = await api.get<UserDetails>(`/api/admin/users/${user.userId}`);
  } finally {
    activeLoading.value = false;
  }
}

async function grant() {
  if (!active.value || !roleToGrant.value) return;

  // Обе команды отдают обновлённую карточку — перечитывать её отдельным
  // запросом не нужно, а список обновляем ради колонки «Роли».
  const details = await run(
    () =>
      api.post<UserDetails>(`/api/admin/users/${active.value!.userId}/roles`, {
        roleCode: roleToGrant.value,
      }),
    'Роль выдана',
  );
  if (!details) return;

  active.value = details;
  roleToGrant.value = '';
  await loadUsers();
}

async function revoke(code: string) {
  if (!active.value) return;

  const details = await run(
    () => api.delete<UserDetails>(`/api/admin/users/${active.value!.userId}/roles/${code}`),
    'Роль снята',
  );
  if (!details) return;

  active.value = details;
  await loadUsers();
}

async function toggleBlock(user: UserRow) {
  const blocked = user.status === 'BLOCKED';
  const result = await run(() =>
    api.post(`/api/admin/users/${user.userId}/${blocked ? 'unblock' : 'block'}`, {
      reason: blocked ? undefined : 'заблокирован администратором',
    }),
  );
  if (result === null) return;

  success(blocked ? 'Доступ восстановлен' : 'Доступ заблокирован');
  await loadUsers();
}

const grantOptions = computed(() =>
  roles.value
    .filter((role) => !(active.value?.grants ?? []).some((grant) => grant.roleCode === role.code))
    .map((role) => ({ value: role.code, label: ROLE_TITLES[role.code] || role.name || role.code })),
);
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">Администрирование</h1>
        <p class="text-muted-foreground text-sm">Учётные записи, роли и доступ</p>
      </div>
      <UiInput v-model="search" placeholder="Поиск по почте или имени" class="w-64" />
    </div>

    <UiCard body-class="p-0">
      <UiDataTable
        :loading="loading"
        :rows="filtered"
        :row-key="(row) => (row as UserRow).userId"
        :columns="[
          { key: 'user', label: 'Пользователь' },
          { key: 'roles', label: 'Роли' },
          { key: 'status', label: 'Статус' },
          { key: 'actions', label: '', width: '1%' },
        ]"
        empty="Пользователей не найдено"
      >
        <template #user="{ row }">
          <div class="flex items-center gap-2">
            <UiAvatar
              :name="(row as UserRow).fullName ?? (row as UserRow).email"
              :id="(row as UserRow).userId"
              size="sm"
            />
            <div class="min-w-0">
              <p class="truncate text-sm font-medium">
                {{ (row as UserRow).fullName ?? '— без профиля —' }}
              </p>
              <p class="text-muted-foreground truncate text-xs">{{ (row as UserRow).email }}</p>
            </div>
          </div>
        </template>

        <template #roles="{ row }">
          <div class="flex flex-wrap gap-1">
            <UiBadge v-for="code in (row as UserRow).roles" :key="code" variant="secondary">
              {{ ROLE_TITLES[code] ?? code }}
            </UiBadge>
            <span v-if="(row as UserRow).roles.length === 0" class="text-muted-foreground text-xs">
              нет ролей
            </span>
          </div>
        </template>

        <template #status="{ row }">
          <UiBadge :variant="(row as UserRow).status === 'BLOCKED' ? 'destructive' : 'success'">
            {{ (row as UserRow).status === 'BLOCKED' ? 'заблокирован' : 'активен' }}
          </UiBadge>
        </template>

        <template #actions="{ row }">
          <div class="flex justify-end gap-2">
            <UiButton size="sm" variant="outline" @click.stop="openRoles(row as UserRow)">
              Роли
            </UiButton>
            <UiButton
              size="sm"
              :variant="(row as UserRow).status === 'BLOCKED' ? 'secondary' : 'ghost'"
              :title="(row as UserRow).status === 'BLOCKED' ? 'Разблокировать' : 'Заблокировать'"
              @click.stop="toggleBlock(row as UserRow)"
            >
              <Shield v-if="(row as UserRow).status === 'BLOCKED'" class="size-4" />
              <ShieldOff v-else class="size-4" />
            </UiButton>
          </div>
        </template>
      </UiDataTable>
    </UiCard>

    <UiDialog
      v-model:open="rolesOpen"
      :title="active?.fullName ?? active?.email ?? 'Роли'"
      description="Роль MANAGER выдаётся автоматически тем, у кого есть подчинённые"
    >
      <div v-if="activeLoading" class="text-muted-foreground text-sm">Загрузка…</div>

      <div v-else-if="active" class="space-y-4">
        <div class="space-y-2">
          <p class="text-muted-foreground text-xs font-medium">Текущие роли</p>
          <div v-if="active.grants.length === 0" class="text-muted-foreground text-sm">
            Ролей нет
          </div>
          <div
            v-for="grant in active.grants"
            :key="grant.roleCode"
            class="flex items-center justify-between gap-3"
          >
            <div>
              <p class="text-sm font-medium">
                {{ ROLE_TITLES[grant.roleCode] ?? grant.roleName ?? grant.roleCode }}
              </p>
              <p v-if="grant.auto" class="text-muted-foreground text-xs">
                выдана автоматически — снимется, когда не останется подчинённых
              </p>
            </div>
            <UiButton v-if="!grant.auto" size="sm" variant="ghost" @click="revoke(grant.roleCode)">
              Снять
            </UiButton>
          </div>
        </div>

        <div v-if="grantOptions.length > 0" class="space-y-2 border-t pt-4">
          <p class="text-muted-foreground text-xs font-medium">Выдать роль</p>
          <div class="flex gap-2">
            <UiSelect v-model="roleToGrant" :options="grantOptions" placeholder="Выберите роль" />
            <UiButton :disabled="!roleToGrant" @click="grant">Выдать</UiButton>
          </div>
        </div>
      </div>
    </UiDialog>
  </div>
</template>
