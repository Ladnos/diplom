<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Plus, Trello } from 'lucide-vue-next';
import type { Board } from '~/types/api';

const api = useApi();
const { run } = useToast();

const boards = ref<Board[]>([]);
const loading = ref(true);
const createOpen = ref(false);
const name = ref('');

onMounted(load);

async function load() {
  loading.value = true;
  try {
    const result = await api.get<{ boards: Board[] }>('/api/boards');
    boards.value = result.boards;
  } finally {
    loading.value = false;
  }
}

async function create() {
  const board = await run(() => api.post<Board>('/api/boards', { name: name.value }), 'Доска создана');
  if (!board) return;

  createOpen.value = false;
  name.value = '';
  await navigateTo(`/boards/${board.boardId}`);
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">Доски</h1>
        <p class="text-muted-foreground text-sm">Задачи команды в колонках с ограничением WIP</p>
      </div>
      <UiButton @click="createOpen = true">
        <Plus class="size-4" />
        Новая доска
      </UiButton>
    </div>

    <UiEmptyState
      v-if="!loading && boards.length === 0"
      title="Досок пока нет"
      description="Создайте первую — колонки появятся автоматически"
      :icon="Trello"
    >
      <UiButton class="mt-2" @click="createOpen = true">Создать доску</UiButton>
    </UiEmptyState>

    <div v-else class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <NuxtLink v-for="board in boards" :key="board.boardId" :to="`/boards/${board.boardId}`">
        <UiCard class="hover:border-foreground/20 h-full transition-colors">
          <h2 class="truncate text-sm font-semibold">{{ board.name }}</h2>
          <p class="text-muted-foreground mt-1 text-xs">
            {{ board.members?.length ?? 0 }} участников
          </p>

          <div class="mt-4 flex -space-x-2">
            <UiAvatar
              v-for="member in (board.members ?? []).slice(0, 5)"
              :key="member.employeeId"
              :name="member.fullName"
              :id="member.employeeId"
              size="sm"
              class="ring-card ring-2"
            />
            <span
              v-if="(board.members?.length ?? 0) > 5"
              class="bg-muted text-muted-foreground ring-card grid size-6 place-items-center rounded-full text-[10px] ring-2"
            >
              +{{ board.members!.length - 5 }}
            </span>
          </div>
        </UiCard>
      </NuxtLink>
    </div>

    <UiDialog v-model:open="createOpen" title="Новая доска" description="Колонки создадутся сами">
      <form class="space-y-4" @submit.prevent="create">
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Название</label>
          <UiInput v-model="name" placeholder="Например, Разработка" required />
        </div>
        <div class="flex justify-end gap-2">
          <UiButton type="button" variant="outline" @click="createOpen = false">Отмена</UiButton>
          <UiButton type="submit" :disabled="!name.trim()">Создать</UiButton>
        </div>
      </form>
    </UiDialog>
  </div>
</template>
