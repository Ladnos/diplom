<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Check, Search, X } from 'lucide-vue-next';
import { cn } from '~/lib/utils';

/**
 * Выбор сотрудника из списка с поиском.
 *
 * Заменяет поля, куда идентификатор вводили руками: UUID неоткуда взять,
 * а опечатка в нём доходила до сервера и возвращалась четырёхсотым
 * ответом без объяснения, что именно не так.
 *
 * Список приходит с сервера на каждый ввод, а не фильтруется на клиенте:
 * выдача ограничена правами (сотрудник видит свой отдел, руководитель —
 * подчинённых, кадровик — всех), и подгрузить «всех» разом, чтобы искать
 * локально, нельзя ни по объёму, ни по доступу.
 */
export interface PickerEmployee {
  employeeId: string;
  fullName: string;
  position?: string | null;
}

const props = withDefaults(
  defineProps<{
    /** Несколько человек — приглашение в звонок, участники канала. */
    multiple?: boolean;
    placeholder?: string;
    /** Кого не предлагать: себя, уже добавленных. */
    exclude?: string[];
    /**
     * Искать только среди подчинённых.
     *
     * Нужно там, где выбор ограничен подчинением, а не отделом: перевод
     * в свой отдел. Без этого руководитель искал бы по собственному
     * отделу и не нашёл бы того, кого туда переводит.
     */
    relation?: 'subordinates';
    disabled?: boolean;
    class?: string;
  }>(),
  { multiple: false, exclude: () => [] },
);

const api = useApi();

/** Одиночный выбор хранит строку, множественный — массив. */
const model = defineModel<string | string[] | undefined>();

const query = ref('');
const open = ref(false);
const loading = ref(false);
const found = ref<PickerEmployee[]>([]);
const note = ref('');

/**
 * Имена выбранных нужны для подписей на чипах, но выбор мог прийти извне
 * (например, из ссылки), и в найденных его не окажется. Поэтому имена
 * копятся отдельным справочником по мере того, как встречаются.
 */
const known = ref(new Map<string, PickerEmployee>());

/** Строка при одиночном выборе, массив при множественном. */

const selected = computed<string[]>(() => {
  const value = model.value;
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
});

const visible = computed(() =>
  found.value.filter((employee) => !props.exclude.includes(employee.employeeId)),
);

/**
 * Имена для выбранных заранее.
 *
 * Значение приходит из карточки уже проставленным — например, текущий
 * руководитель сотрудника. Пока его нет среди найденных, на чипе стоял
 * бы обрезанный идентификатор, по которому человека не узнать.
 */
watch(
  selected,
  async (ids) => {
    const missing = ids.filter((id) => !known.value.has(id));
    if (missing.length === 0) return;

    const resolved = await Promise.all(
      missing.map((id) =>
        api.get<PickerEmployee>(`/api/employees/${id}`).catch(() => null),
      ),
    );
    for (const employee of resolved) {
      if (employee) known.value.set(employee.employeeId, employee);
    }
    known.value = new Map(known.value);
  },
  { immediate: true },
);

let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * Запрос откладывается на 250 мс: без паузы каждая нажатая буква уходила
 * бы отдельным запросом, и ответы возвращались бы вперемешку.
 */
watch(query, () => {
  clearTimeout(timer);
  timer = setTimeout(() => void search(), 250);
});

onBeforeUnmount(() => clearTimeout(timer));

async function search() {
  loading.value = true;
  note.value = '';
  try {
    const result = await api.get<{ employees: PickerEmployee[]; note?: string }>('/api/employees', {
      search: query.value.trim() || undefined,
      relation: props.relation,
    });
    found.value = result.employees ?? [];
    for (const employee of found.value) known.value.set(employee.employeeId, employee);
    if (found.value.length === 0) {
      note.value = result.note ?? 'Никого не нашлось';
    }
  } catch {
    note.value = 'Не удалось получить список';
  } finally {
    loading.value = false;
  }
}

function focus() {
  open.value = true;
  if (found.value.length === 0 && !loading.value) void search();
}

function toggle(employee: PickerEmployee) {
  known.value.set(employee.employeeId, employee);

  if (!props.multiple) {
    model.value = employee.employeeId;
    open.value = false;
    query.value = '';
    return;
  }

  const current = selected.value;
  model.value = current.includes(employee.employeeId)
    ? current.filter((id) => id !== employee.employeeId)
    : [...current, employee.employeeId];
}

function remove(employeeId: string) {
  model.value = props.multiple
    ? selected.value.filter((id) => id !== employeeId)
    : undefined;
}

function labelOf(employeeId: string): string {
  return known.value.get(employeeId)?.fullName ?? employeeId.slice(0, 8);
}
</script>

<template>
  <div :class="cn('space-y-2', props.class)">
    <div v-if="selected.length > 0" class="flex flex-wrap gap-1.5">
      <span
        v-for="employeeId in selected"
        :key="employeeId"
        class="bg-muted inline-flex items-center gap-1.5 rounded-full py-0.5 pr-1 pl-1 text-xs"
      >
        <UiAvatar :name="labelOf(employeeId)" :id="employeeId" size="sm" />
        <span class="max-w-40 truncate">{{ labelOf(employeeId) }}</span>
        <button
          type="button"
          class="hover:bg-background rounded-full p-0.5"
          :title="'Убрать'"
          :disabled="props.disabled"
          @click="remove(employeeId)"
        >
          <X class="size-3" />
        </button>
      </span>
    </div>

    <div class="relative">
      <Search
        class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
      />
      <UiInput
        v-model="query"
        :placeholder="props.placeholder ?? 'Начните вводить имя или должность'"
        :disabled="props.disabled"
        class="pl-8"
        @focus="focus"
      />
    </div>

    <!-- Список раскрыт, пока идёт выбор: при множественном выборе
         закрывать его после каждого щелчка значило бы открывать заново
         на каждого следующего участника -->
    <div v-if="open" class="max-h-56 overflow-y-auto rounded-md border">
      <p v-if="loading" class="text-muted-foreground px-3 py-2 text-sm">Ищем…</p>

      <p v-else-if="visible.length === 0" class="text-muted-foreground px-3 py-2 text-sm">
        {{ note || 'Никого не нашлось' }}
      </p>

      <button
        v-for="employee in visible"
        :key="employee.employeeId"
        type="button"
        class="hover:bg-accent flex w-full items-center gap-2 px-3 py-2 text-left"
        @click="toggle(employee)"
      >
        <UiAvatar :name="employee.fullName" :id="employee.employeeId" size="sm" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm">{{ employee.fullName }}</span>
          <span v-if="employee.position" class="text-muted-foreground block truncate text-xs">
            {{ employee.position }}
          </span>
        </span>
        <Check
          v-if="selected.includes(employee.employeeId)"
          class="text-muted-foreground size-4 shrink-0"
        />
      </button>
    </div>

    <button
      v-if="open && props.multiple"
      type="button"
      class="text-muted-foreground hover:text-foreground text-xs"
      @click="open = false"
    >
      Свернуть список
    </button>
  </div>
</template>
