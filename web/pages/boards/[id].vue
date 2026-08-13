<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ArrowLeft, Paperclip, Plus, Users } from 'lucide-vue-next';
import { formatDate, formatMinutes } from '~/lib/utils';
import type { Board, Card } from '~/types/api';

const route = useRoute();
const api = useApi();
const realtime = useRealtime();
const { run, error } = useToast();

const boardId = route.params.id as string;
const board = ref<Board | null>(null);
const cards = ref<Card[]>([]);
const loading = ref(true);

const createOpen = ref(false);
const createColumn = ref('');
const newCard = ref({ title: '', description: '', estimateMinutes: 0 });

/** Перетаскиваемая карточка. Держим id, а не объект: список пересобирается. */
const dragging = ref<string | null>(null);
const dragOverColumn = ref<string | null>(null);

const unsubscribers: (() => void)[] = [];

onMounted(async () => {
  await load();

  // Комната доски: изменения от других участников придут сюда же (§8.1)
  await realtime.join(`board:${boardId}`);

  unsubscribers.push(
    realtime.on('task.card.created', (payload) => {
      if (payload.boardId === boardId) void load();
    }),
    realtime.on('task.card.moved', applyRemoteMove),
    realtime.on('task.card.deleted', (payload) => {
      cards.value = cards.value.filter((card) => card.cardId !== payload.cardId);
    }),
    realtime.on('task.card.closed', () => void load()),
  );
});

onUnmounted(() => {
  realtime.leave(`board:${boardId}`);
  for (const off of unsubscribers) off();
});

async function load() {
  loading.value = true;
  try {
    const result = await api.get<Board & { cards: Card[] }>(`/api/boards/${boardId}`);
    board.value = result;
    cards.value = result.cards ?? [];
  } finally {
    loading.value = false;
  }
}

/**
 * Чужое перемещение.
 *
 * Событие несёт версию карточки, и меньшая отбрасывается: наше
 * оптимистичное изменение уже применено, а пришедшее следом эхо с
 * устаревшим номером заставило бы карточку прыгнуть назад.
 */
function applyRemoteMove(payload: Record<string, unknown>) {
  const card = cards.value.find((item) => item.cardId === payload.cardId);
  if (!card) return;
  if (Number(payload.version) <= card.version) return;

  card.columnId = String(payload.toColumnId);
  card.version = Number(payload.version);
}

/**
 * Раскладка карточек по колонкам.
 *
 * Закрытые карточки остаются на доске: попадание в колонку «Готово»
 * проставляет closedAt, и прятать их значило бы, что карточка исчезает
 * ровно в тот момент, когда её туда перетащили. Из вида их убирает
 * архивация колонки, а не сам факт завершения.
 */
const byColumn = computed(() => {
  const map = new Map<string, Card[]>();
  for (const column of board.value?.columns ?? []) map.set(column.columnId, []);
  for (const card of cards.value) map.get(card.columnId)?.push(card);
  for (const list of map.values()) list.sort((a, b) => a.position - b.position);
  return map;
});

function onDragStart(card: Card) {
  dragging.value = card.cardId;
}

async function onDrop(columnId: string) {
  dragOverColumn.value = null;
  const cardId = dragging.value;
  dragging.value = null;
  if (!cardId) return;

  const card = cards.value.find((item) => item.cardId === cardId);
  if (!card || card.columnId === columnId) return;

  const previousColumn = card.columnId;
  const previousVersion = card.version;

  // Оптимистичное перемещение: карточка встаёт на место сразу, иначе
  // перетаскивание ощущается как заедающее. При отказе возвращаем.
  card.columnId = columnId;

  const target = byColumn.value.get(columnId)?.length ?? 0;
  const result = await api
    .post<Card>(`/api/cards/${cardId}/move`, {
      toColumnId: columnId,
      targetIndex: target,
      expectedVersion: previousVersion,
    })
    .catch((caught: Error & { status?: number }) => {
      card.columnId = previousColumn;
      // 409 — кто-то передвинул ту же карточку раньше. Это не сбой, а
      // штатный исход одновременной работы: перечитываем доску.
      if (caught.status === 409) {
        error('Карточку уже передвинули', 'Доска обновлена — попробуйте ещё раз');
        void load();
      } else {
        error('Не удалось передвинуть', caught.message);
      }
      return null;
    });

  if (result) {
    card.version = result.version;
    card.position = result.position;
  }
}

async function addCard() {
  const created = await run(
    () =>
      api.post<Card>(`/api/boards/${boardId}/cards`, {
        columnId: createColumn.value,
        title: newCard.value.title,
        description: newCard.value.description || undefined,
        estimateMinutes: newCard.value.estimateMinutes || undefined,
      }),
    'Карточка создана',
  );
  if (!created) return;

  createOpen.value = false;
  newCard.value = { title: '', description: '', estimateMinutes: 0 };
  cards.value = [...cards.value, created];
}

function openCreate(columnId: string) {
  createColumn.value = columnId;
  createOpen.value = true;
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center gap-3">
      <UiButton as="a" variant="ghost" size="icon" href="/boards" title="К списку досок">
        <ArrowLeft class="size-4" />
      </UiButton>
      <div class="min-w-0 flex-1">
        <h1 class="truncate text-xl font-semibold">{{ board?.name ?? 'Доска' }}</h1>
        <p class="text-muted-foreground text-sm">
          {{ cards.filter((card) => !card.closedAt).length }} открытых карточек
        </p>
      </div>
      <div class="flex -space-x-2">
        <UiAvatar
          v-for="member in (board?.members ?? []).slice(0, 6)"
          :key="member.employeeId"
          :name="member.fullName"
          :id="member.employeeId"
          size="sm"
          class="ring-background ring-2"
        />
      </div>
    </div>

    <div v-if="loading" class="flex gap-4 overflow-x-auto pb-4">
      <div v-for="index in 4" :key="index" class="w-72 shrink-0 space-y-3">
        <div class="bg-muted h-8 animate-pulse rounded-lg" />
        <div class="bg-muted h-24 animate-pulse rounded-lg" />
      </div>
    </div>

    <div v-else class="flex gap-4 overflow-x-auto pb-4">
      <section
        v-for="column in board?.columns ?? []"
        :key="column.columnId"
        class="bg-muted/40 flex w-72 shrink-0 flex-col rounded-xl transition-colors"
        :class="dragOverColumn === column.columnId && 'ring-foreground/20 bg-muted ring-2'"
        @dragover.prevent="dragOverColumn = column.columnId"
        @dragleave="dragOverColumn = null"
        @drop.prevent="onDrop(column.columnId)"
      >
        <header class="flex items-center justify-between gap-2 px-3 py-2.5">
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate text-sm font-medium">{{ column.name }}</span>
            <span class="text-muted-foreground text-xs tabular">
              {{ byColumn.get(column.columnId)?.length ?? 0 }}
            </span>
          </div>
          <!-- Предел WIP показан числом, а не только цветом: «3/3» понятно
               без легенды, а красная рамка сама по себе — нет -->
          <UiBadge
            v-if="column.wipLimit"
            :variant="column.wipReached ? 'destructive' : 'muted'"
            :title="column.wipReached ? 'Достигнут предел незавершённой работы' : 'Предел WIP'"
          >
            {{ byColumn.get(column.columnId)?.length ?? 0 }}/{{ column.wipLimit }}
          </UiBadge>
        </header>

        <div class="flex-1 space-y-2 px-2 pb-2">
          <article
            v-for="card in byColumn.get(column.columnId) ?? []"
            :key="card.cardId"
            draggable="true"
            class="bg-card cursor-grab rounded-lg border p-3 shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing"
            :class="[
              dragging === card.cardId && 'opacity-50',
              card.closedAt && 'border-dashed',
            ]"
            @dragstart="onDragStart(card)"
            @dragend="dragging = null"
          >
            <p
              class="text-sm leading-snug font-medium"
              :class="card.closedAt && 'text-muted-foreground line-through'"
            >
              {{ card.title }}
            </p>

            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              <UiBadge v-for="label in card.labels" :key="label.labelId" variant="outline">
                {{ label.name }}
              </UiBadge>
            </div>

            <div class="text-muted-foreground mt-3 flex items-center gap-3 text-xs">
              <UiAvatar
                v-if="card.assignee"
                :name="card.assignee.fullName"
                :id="card.assignee.employeeId"
                size="sm"
              />
              <span v-if="card.dueDate" :title="'Срок'">{{ formatDate(card.dueDate) }}</span>
              <span v-if="card.estimateMinutes">{{ formatMinutes(card.estimateMinutes) }}</span>
              <span v-if="card.attachments?.length" class="flex items-center gap-1">
                <Paperclip class="size-3" />
                {{ card.attachments.length }}
              </span>
            </div>

            <!-- Отсутствие исполнителя видно прямо на карточке: назначать
                 задачу со сроком внутри отпуска бессмысленно -->
            <p v-if="card.assignee?.absentUntil" class="text-warning mt-2 text-xs">
              исполнитель отсутствует до {{ formatDate(card.assignee.absentUntil) }}
            </p>
          </article>

          <button
            class="text-muted-foreground hover:bg-muted hover:text-foreground flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors"
            @click="openCreate(column.columnId)"
          >
            <Plus class="size-4" />
            Добавить
          </button>
        </div>
      </section>

      <UiEmptyState
        v-if="(board?.columns ?? []).length === 0"
        title="У доски нет колонок"
        :icon="Users"
      />
    </div>

    <UiDialog v-model:open="createOpen" title="Новая карточка">
      <form class="space-y-4" @submit.prevent="addCard">
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Название</label>
          <UiInput v-model="newCard.title" placeholder="Что нужно сделать" required />
        </div>
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Описание</label>
          <UiTextarea v-model="newCard.description" placeholder="Необязательно" />
        </div>
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Оценка, минут</label>
          <UiInput v-model.number="newCard.estimateMinutes" type="number" min="0" step="30" />
        </div>
        <div class="flex justify-end gap-2">
          <UiButton type="button" variant="outline" @click="createOpen = false">Отмена</UiButton>
          <UiButton type="submit" :disabled="!newCard.title.trim()">Создать</UiButton>
        </div>
      </form>
    </UiDialog>
  </div>
</template>
