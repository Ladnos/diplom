<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAuthStore } from '~/stores/auth';
import { formatDate } from '~/lib/utils';
import { EMPLOYMENT_TYPES, PAYMENT_FORMS, ROLE_TITLES, TIME_POLICIES } from '~/lib/domain';

/**
 * Свой профиль.
 *
 * Право employee/write у рядового сотрудника выдано со scope SELF, и
 * шлюз отбрасывает в этой области отдел и руководителя: они определяют
 * маршрут согласования и видимость данных, менять их себе нельзя. Поэтому
 * здесь только имя и должность, а остальное показано как справка — с
 * пояснением, к кому идти за изменением.
 */
const auth = useAuthStore();
const api = useApi();
const { run, success } = useToast();

interface Profile {
  employeeId: string;
  fullName: string;
  position: string | null;
  departmentId: string | null;
  managerId: string | null;
  active: boolean;
  hiredAt: string | null;
  employment: {
    type: string;
    paymentForm: string;
    policy: string;
    rate: number;
  } | null;
}

const profile = ref<Profile | null>(null);
const manager = ref<{ fullName: string; position: string | null } | null>(null);
const loading = ref(true);
const saving = ref(false);
const form = ref({ fullName: '', position: '' });

onMounted(load);

async function load() {
  loading.value = true;
  try {
    if (!auth.employeeId) return;

    profile.value = await api.get<Profile>(`/api/employees/${auth.employeeId}`);
    form.value = {
      fullName: profile.value.fullName,
      position: profile.value.position ?? '',
    };

    // Руководителя показываем по имени: идентификатор сотруднику
    // ничего не говорит. Отказ здесь не должен ломать страницу — он
    // означает лишь то, что карточка руководителя вне его видимости.
    manager.value = profile.value.managerId
      ? await api
          .get<{ fullName: string; position: string | null }>(
            `/api/employees/${profile.value.managerId}`,
          )
          .catch(() => null)
      : null;
  } finally {
    loading.value = false;
  }
}

const changed = computed(
  () =>
    profile.value !== null &&
    (form.value.fullName.trim() !== profile.value.fullName ||
      form.value.position.trim() !== (profile.value.position ?? '')),
);

async function save() {
  if (!profile.value || !changed.value) return;
  saving.value = true;
  try {
    const result = await run(() =>
      api.patch<Profile>(`/api/employees/${profile.value!.employeeId}`, {
        fullName: form.value.fullName.trim(),
        position: form.value.position.trim(),
      }),
    );
    if (result === null) return;

    // Имя показано в меню и в шапке: перечитываем сессию, иначе
    // изменение станет заметно только после следующего входа.
    await auth.loadMe();
    await load();
    success('Профиль сохранён');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-xl font-semibold">Профиль</h1>
      <p class="text-muted-foreground text-sm">Имя и должность вы меняете сами</p>
    </div>

    <div v-if="loading" class="bg-muted h-40 animate-pulse rounded-xl" />

    <UiEmptyState
      v-else-if="!profile"
      title="Профиль сотрудника ещё не создан"
      description="Он появится автоматически — кадровая карточка заводится по событию регистрации"
    />

    <template v-else>
      <UiCard>
        <form class="space-y-4" @submit.prevent="save">
          <div class="flex items-center gap-4">
            <UiAvatar :name="profile.fullName" :id="profile.employeeId" size="lg" />
            <div class="min-w-0">
              <p class="truncate text-sm font-medium">{{ profile.fullName }}</p>
              <p class="text-muted-foreground truncate text-xs">
                {{ auth.roles.map((role) => ROLE_TITLES[role] ?? role).join(', ') || 'без ролей' }}
              </p>
            </div>
          </div>

          <div class="space-y-1.5">
            <label class="text-sm font-medium">Имя</label>
            <UiInput v-model="form.fullName" required />
          </div>

          <div class="space-y-1.5">
            <label class="text-sm font-medium">Должность</label>
            <UiInput v-model="form.position" placeholder="Например, ведущий инженер" />
          </div>

          <div class="flex justify-end">
            <UiButton type="submit" :disabled="!changed || !form.fullName.trim()" :loading="saving">
              Сохранить
            </UiButton>
          </div>
        </form>
      </UiCard>

      <UiCard title="Кадровые данные">
        <p class="text-muted-foreground mb-4 text-xs">
          Эти сведения меняет кадровая служба — от них зависят маршруты согласования и учёт времени
        </p>

        <dl class="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <div>
            <dt class="text-muted-foreground text-xs">Руководитель</dt>
            <dd class="text-sm">
              <template v-if="manager">{{ manager.fullName }}</template>
              <template v-else-if="profile.managerId">указан, карточка недоступна</template>
              <span v-else class="text-warning">
                не назначен — заявки утверждаются сразу, согласовывать их некому
              </span>
            </dd>
          </div>

          <div>
            <dt class="text-muted-foreground text-xs">Отдел</dt>
            <dd class="text-sm">{{ profile.departmentId ?? 'не указан' }}</dd>
          </div>

          <div>
            <dt class="text-muted-foreground text-xs">Тип найма</dt>
            <dd class="text-sm">
              <template v-if="profile.employment">
                {{ EMPLOYMENT_TYPES[profile.employment.type] ?? profile.employment.type }} ·
                {{ PAYMENT_FORMS[profile.employment.paymentForm] ?? '' }} · ставка
                {{ profile.employment.rate }}
              </template>
              <template v-else>не оформлен</template>
            </dd>
          </div>

          <div>
            <dt class="text-muted-foreground text-xs">Учёт времени</dt>
            <dd class="text-sm">
              <span v-if="profile.employment" :title="TIME_POLICIES[profile.employment.policy]?.hint">
                {{ TIME_POLICIES[profile.employment.policy]?.label ?? profile.employment.policy }}
              </span>
              <span v-else>—</span>
            </dd>
          </div>

          <div>
            <dt class="text-muted-foreground text-xs">Принят</dt>
            <dd class="text-sm">{{ profile.hiredAt ? formatDate(profile.hiredAt) : '—' }}</dd>
          </div>
        </dl>
      </UiCard>
    </template>
  </div>
</template>
