<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { MessageSquare, Paperclip, Plus, Send, Video } from 'lucide-vue-next';
import { useAuthStore } from '~/stores/auth';
import { cn, formatRelative, formatBytes } from '~/lib/utils';
import { CHANNEL_TYPES } from '~/lib/domain';
import type { Channel, Message } from '~/types/api';

const auth = useAuthStore();
const api = useApi();
const realtime = useRealtime();
const { run, error } = useToast();

const channels = ref<Channel[]>([]);
const active = ref<Channel | null>(null);
const messages = ref<Message[]>([]);
const draft = ref('');
const loading = ref(true);
const sending = ref(false);
const typing = ref<Map<string, number>>(new Map());
const scroller = ref<HTMLElement | null>(null);
const pendingFiles = ref<{ file: File; progress: number }[]>([]);

const createOpen = ref(false);
const newChannel = ref({ name: '', type: 'PRIVATE' });

const unsubscribers: (() => void)[] = [];
let typingSentAt = 0;

onMounted(async () => {
  await loadChannels();
  loading.value = false;

  unsubscribers.push(
    realtime.on('chat.message.sent', onIncoming),
    realtime.on('chat.message.deleted', (payload) => {
      const message = messages.value.find((item) => item.messageId === payload.messageId);
      if (message) {
        message.deleted = true;
        message.body = '';
      }
    }),
    realtime.on('chat.typing', (payload) => {
      if (payload.channelId !== active.value?.channelId) return;
      typing.value.set(String(payload.employeeId), Date.now());
      typing.value = new Map(typing.value);
    }),
  );

  // Индикатор живёт три секунды — убираем истёкшие сами, событий об
  // окончании набора не бывает (§8.2)
  const cleaner = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [id, at] of typing.value) {
      if (now - at > 3000) {
        typing.value.delete(id);
        changed = true;
      }
    }
    if (changed) typing.value = new Map(typing.value);
  }, 1000);
  unsubscribers.push(() => clearInterval(cleaner));
});

onUnmounted(() => {
  if (active.value) realtime.leave(`channel:${active.value.channelId}`);
  for (const off of unsubscribers) off();
});

async function loadChannels() {
  const result = await api.get<{ channels: Channel[]; totalUnread: number }>('/api/channels');
  channels.value = result.channels;
  if (!active.value && result.channels.length > 0) await open(result.channels[0]);
}

async function open(channel: Channel) {
  if (active.value) realtime.leave(`channel:${active.value.channelId}`);

  active.value = channel;
  messages.value = [];
  typing.value = new Map();

  const [history] = await Promise.all([
    api.get<{ messages: Message[] }>(`/api/channels/${channel.channelId}/messages`, { limit: 50 }),
    realtime.join(`channel:${channel.channelId}`),
  ]);

  // История приходит от новых к старым — разворачиваем для ленты
  messages.value = [...history.messages].reverse();
  await scrollDown();
  await markRead();
}

function onIncoming(payload: Record<string, unknown>) {
  if (payload.channelId !== active.value?.channelId) {
    // Сообщение в другом канале — поднимаем счётчик в списке
    const channel = channels.value.find((item) => item.channelId === payload.channelId);
    if (channel) channel.unread = (channel.unread ?? 0) + 1;
    return;
  }

  // Событие несёт превью, а не полное сообщение: дочитываем историю с
  // того номера, который уже есть. Так же клиент восстанавливает
  // пропущенное после разрыва (§8.2).
  void refreshTail();
}

async function refreshTail() {
  if (!active.value) return;
  const history = await api.get<{ messages: Message[] }>(
    `/api/channels/${active.value.channelId}/messages`,
    { limit: 20 },
  );

  const known = new Set(messages.value.map((item) => item.messageId));
  const fresh = [...history.messages].reverse().filter((item) => !known.has(item.messageId));
  if (fresh.length === 0) return;

  messages.value = [...messages.value, ...fresh];
  await scrollDown();
  await markRead();
}

async function markRead() {
  const last = messages.value.at(-1);
  if (!active.value || !last) return;

  await api.post(`/api/channels/${active.value.channelId}/read`, { upToSeq: last.seq }).catch(() => undefined);
  const channel = channels.value.find((item) => item.channelId === active.value!.channelId);
  if (channel) channel.unread = 0;
}

async function send() {
  if (!active.value || (!draft.value.trim() && pendingFiles.value.length === 0)) return;
  sending.value = true;

  try {
    // Файлы уходят первыми: сообщение ссылается на них идентификаторами,
    // и отправлять его до завершения загрузки нечем.
    const attachmentFileIds: string[] = [];
    for (const item of pendingFiles.value) {
      const uploaded = await api.upload(item.file, {}, (percent) => (item.progress = percent));
      attachmentFileIds.push(uploaded.fileId);
    }

    await api.post<Message>(`/api/channels/${active.value.channelId}/messages`, {
      body: draft.value,
      attachmentFileIds,
      // Идемпотентность: повтор при обрыве связи не создаст второе
      // сообщение (§8.2)
      clientMessageId: crypto.randomUUID(),
    });

    draft.value = '';
    pendingFiles.value = [];
    await refreshTail();
  } catch (caught) {
    error('Сообщение не отправлено', caught instanceof Error ? caught.message : '');
  } finally {
    sending.value = false;
  }
}

function onInput() {
  // Не чаще раза в секунду: шлюз всё равно отбросит частые сигналы
  const now = Date.now();
  if (!active.value || now - typingSentAt < 1000) return;
  typingSentAt = now;
  realtime.emit('typing', { channelId: active.value.channelId });
}

function pickFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  for (const file of Array.from(input.files ?? [])) {
    pendingFiles.value.push({ file, progress: 0 });
  }
  input.value = '';
}

async function startCall() {
  if (!active.value) return;
  const call = await run(
    () => api.post<{ roomId: string }>(`/api/channels/${active.value!.channelId}/call`, {}),
    'Звонок начат',
  );
  if (call) await navigateTo(`/calls?room=${call.roomId}`);
}

async function createChannel() {
  const channel = await run(
    () => api.post<Channel>('/api/channels', { name: newChannel.value.name, type: newChannel.value.type }),
    'Канал создан',
  );
  if (!channel) return;

  createOpen.value = false;
  newChannel.value.name = '';
  await loadChannels();
  await open(channel);
}

async function scrollDown() {
  await nextTick();
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
}

const typingNames = computed(() => {
  const members = active.value?.members ?? [];
  return [...typing.value.keys()]
    .filter((id) => id !== auth.employeeId)
    .map((id) => members.find((member) => member.employeeId === id)?.fullName ?? 'Кто-то')
    .slice(0, 3);
});

const channelTitle = (channel: Channel) =>
  channel.name || channel.members.find((m) => m.employeeId !== auth.employeeId)?.fullName || 'Переписка';

watch(messages, () => void 0, { deep: false });
</script>

<template>
  <div class="flex h-[calc(100vh-7rem)] flex-col gap-4">
    <h1 class="sr-only">Переписка</h1>

    <div class="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
    <!-- ── Список каналов ──────────────────────────────────────────── -->
    <UiCard class="hidden overflow-hidden lg:flex lg:flex-col" body-class="p-0 flex-1 overflow-y-auto">
      <template #header>
        <h2 class="text-sm font-semibold">Переписка</h2>
      </template>
      <template #actions>
        <UiButton variant="ghost" size="icon-sm" title="Новый канал" @click="createOpen = true">
          <Plus class="size-4" />
        </UiButton>
      </template>

      <UiEmptyState v-if="!loading && channels.length === 0" title="Каналов нет" :icon="MessageSquare" />

      <button
        v-for="channel in channels"
        :key="channel.channelId"
        :class="
          cn(
            'hover:bg-accent/50 flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors',
            active?.channelId === channel.channelId && 'bg-accent',
          )
        "
        @click="open(channel)"
      >
        <UiAvatar :name="channelTitle(channel)" :id="channel.channelId" size="sm" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium">{{ channelTitle(channel) }}</p>
          <p class="text-muted-foreground truncate text-xs">{{ CHANNEL_TYPES[channel.type] }}</p>
        </div>
        <UiBadge v-if="channel.unread" variant="destructive">{{ channel.unread }}</UiBadge>
      </button>
    </UiCard>

    <!-- ── Переписка ───────────────────────────────────────────────── -->
    <UiCard class="flex flex-col overflow-hidden" body-class="p-0 flex-1 flex flex-col min-h-0">
      <template #header>
        <div v-if="active" class="flex items-center gap-2">
          <UiAvatar :name="channelTitle(active)" :id="active.channelId" size="sm" />
          <div class="min-w-0">
            <h2 class="truncate text-sm font-semibold">{{ channelTitle(active) }}</h2>
            <p class="text-muted-foreground text-xs">{{ active.members.length }} участников</p>
          </div>
        </div>
        <h2 v-else class="text-sm font-semibold">Выберите канал</h2>
      </template>
      <template #actions>
        <UiButton v-if="active" variant="outline" size="sm" @click="startCall">
          <Video class="size-4" />
          Позвонить
        </UiButton>
      </template>

      <div ref="scroller" class="flex-1 space-y-3 overflow-y-auto p-4">
        <UiEmptyState
          v-if="active && messages.length === 0"
          title="Сообщений пока нет"
          description="Напишите первым"
          :icon="MessageSquare"
        />

        <div
          v-for="message in messages"
          :key="message.messageId"
          class="flex gap-3"
          :class="!message.author && 'justify-center'"
        >
          <!-- Системная запись без автора: «звонок завершён, 42 мин» -->
          <p v-if="!message.author" class="text-muted-foreground bg-muted rounded-full px-3 py-1 text-xs">
            {{ message.body }}
          </p>

          <template v-else>
            <UiAvatar :name="message.author.fullName" :id="message.author.employeeId" size="sm" />
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline gap-2">
                <span class="text-sm font-medium">{{ message.author.fullName ?? '—' }}</span>
                <span class="text-muted-foreground text-xs" :title="message.createdAt">
                  {{ formatRelative(message.createdAt) }}
                </span>
                <span v-if="message.editedAt" class="text-muted-foreground text-xs">изменено</span>
              </div>

              <p v-if="message.deleted" class="text-muted-foreground text-sm italic">сообщение удалено</p>
              <p v-else class="text-sm whitespace-pre-wrap">{{ message.body }}</p>

              <div v-if="message.attachments?.length" class="mt-2 flex flex-wrap gap-2">
                <a
                  v-for="file in message.attachments"
                  :key="file.fileId"
                  :href="file.url"
                  class="bg-muted hover:bg-accent flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors"
                  download
                >
                  <Paperclip class="size-3" />
                  <span class="max-w-40 truncate">{{ file.filename ?? 'файл' }}</span>
                  <span v-if="file.sizeBytes" class="text-muted-foreground">
                    {{ formatBytes(file.sizeBytes) }}
                  </span>
                </a>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- Индикатор набора: живёт три секунды и исчезает сам -->
      <p v-if="typingNames.length > 0" class="text-muted-foreground px-4 pb-1 text-xs">
        {{ typingNames.join(', ') }} печатает…
      </p>

      <div v-if="active" class="border-t p-3">
        <div v-if="pendingFiles.length" class="mb-2 flex flex-wrap gap-2">
          <span
            v-for="item in pendingFiles"
            :key="item.file.name"
            class="bg-muted flex items-center gap-2 rounded-md px-2 py-1 text-xs"
          >
            {{ item.file.name }}
            <span v-if="item.progress > 0" class="text-muted-foreground">{{ item.progress }}%</span>
          </span>
        </div>

        <form class="flex items-end gap-2" @submit.prevent="send">
          <label
            class="hover:bg-accent grid size-9 shrink-0 cursor-pointer place-items-center rounded-md border transition-colors"
            title="Прикрепить файл"
          >
            <Paperclip class="size-4" />
            <input type="file" multiple class="hidden" @change="pickFiles" />
          </label>

          <UiTextarea
            v-model="draft"
            placeholder="Сообщение…"
            class="max-h-32 min-h-9 resize-none py-2"
            rows="1"
            @input="onInput"
            @keydown.enter.exact.prevent="send"
          />

          <UiButton type="submit" size="icon" :loading="sending" :disabled="!draft.trim() && !pendingFiles.length">
            <Send v-if="!sending" class="size-4" />
          </UiButton>
        </form>
      </div>
    </UiCard>

    <UiDialog v-model:open="createOpen" title="Новый канал">
      <form class="space-y-4" @submit.prevent="createChannel">
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Название</label>
          <UiInput v-model="newChannel.name" placeholder="Например, Разработка" required />
        </div>
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Тип</label>
          <UiSelect
            v-model="newChannel.type"
            :options="[
              { value: 'PRIVATE', label: 'Закрытый' },
              { value: 'PUBLIC', label: 'Открытый' },
              { value: 'GROUP', label: 'Групповой' },
              { value: 'ANNOUNCEMENT', label: 'Объявления — пишет руководитель' },
            ]"
          />
        </div>
        <div class="flex justify-end gap-2">
          <UiButton type="button" variant="outline" @click="createOpen = false">Отмена</UiButton>
          <UiButton type="submit" :disabled="!newChannel.name.trim()">Создать</UiButton>
        </div>
      </form>
    </UiDialog>
    </div>
  </div>
</template>
