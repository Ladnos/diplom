<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { Mic, MicOff, PhoneOff, Video as VideoIcon, VideoOff, PhoneCall } from 'lucide-vue-next';
import { useAuthStore } from '~/stores/auth';
import { formatDateTime } from '~/lib/utils';
import type { Call, JoinTicket } from '~/types/api';

const auth = useAuthStore();
const api = useApi();
const call = useCall();
const realtime = useRealtime();
const { run, error } = useToast();

const active = ref<Call[]>([]);
const loading = ref(true);
const inRoom = ref<string | null>(null);
const localVideo = ref<HTMLVideoElement | null>(null);

const createOpen = ref(false);
const invited = ref('');
const title = ref('');

const unsubscribers: (() => void)[] = [];

onMounted(async () => {
  await load();
  loading.value = false;

  // Приглашение приходит уведомлением с приоритетом URGENT (§7.3)
  unsubscribers.push(realtime.on('video.call.started', () => void load()));

  const room = useRoute().query.room as string | undefined;
  if (room) await enter(room);
});

onUnmounted(() => {
  if (inRoom.value) call.leave();
  for (const off of unsubscribers) off();
});

async function load() {
  const result = await api.get<{ calls: Call[] }>('/api/calls/active').catch(() => ({ calls: [] }));
  active.value = result.calls;
}

async function start() {
  const created = await run(
    () =>
      api.post<Call & { join: JoinTicket }>('/api/calls', {
        title: title.value || 'Звонок',
        invitedEmployeeIds: invited.value
          .split(/[\s,]+/)
          .map((item) => item.trim())
          .filter(Boolean),
      }),
    'Звонок создан',
  );
  if (!created) return;

  createOpen.value = false;
  await connect(created.roomId, created.join);
}

async function enter(roomId: string) {
  const ticket = await run(() => api.post<JoinTicket>(`/api/calls/${roomId}/join`, {}));
  if (ticket) await connect(roomId, ticket);
}

async function connect(roomId: string, ticket: JoinTicket) {
  try {
    await call.join(ticket, { video: true });
    inRoom.value = roomId;
  } catch (caught) {
    // Отказ в доступе к камере — самая частая причина, и звучит она
    // непонятно: поясняем прямо
    const message = caught instanceof Error ? caught.message : String(caught);
    error(
      'Не удалось войти в звонок',
      message.includes('Permission') || message.includes('NotAllowed')
        ? 'Браузер не дал доступ к камере и микрофону'
        : message,
    );
  }
}

async function hangUp() {
  const roomId = inRoom.value;
  call.leave();
  inRoom.value = null;

  // Комнату закрывает последний вышедший, но инициатор может завершить
  // её для всех — это право модератора
  if (roomId) await api.post(`/api/calls/${roomId}/end`, {}).catch(() => undefined);
  await load();
}

// Локальный поток подключается к элементу после того, как тот появился
watch([() => call.localStream.value, localVideo], () => {
  if (localVideo.value && call.localStream.value) {
    localVideo.value.srcObject = call.localStream.value;
  }
});

const gridClass = computed(() => {
  const count = call.remotes.value.length + 1;
  if (count <= 1) return 'grid-cols-1';
  if (count <= 4) return 'grid-cols-1 sm:grid-cols-2';
  return 'grid-cols-2 lg:grid-cols-3';
});

function nameOf(employeeId: string): string {
  const participant = call.participants.value.find(
    (item) => (item as { employeeId?: string }).employeeId === employeeId,
  ) as { fullName?: string } | undefined;
  return participant?.fullName ?? employeeId.slice(0, 8);
}
</script>

<template>
  <div class="space-y-6">
    <!-- ── В звонке ────────────────────────────────────────────────── -->
    <template v-if="inRoom">
      <div class="flex items-center justify-between gap-3">
        <div>
          <h1 class="text-xl font-semibold">Идёт звонок</h1>
          <p class="text-muted-foreground text-sm">
            {{ call.remotes.value.length + 1 }} участников · медиа идёт напрямую к SFU
          </p>
        </div>
      </div>

      <div :class="['grid gap-3', gridClass]">
        <!-- Своё видео зеркалим: так привычнее, человек видит себя как в
             зеркале, а не как со стороны -->
        <div class="bg-muted relative aspect-video overflow-hidden rounded-xl">
          <video ref="localVideo" autoplay muted playsinline class="size-full scale-x-[-1] object-cover" />
          <div class="absolute inset-x-2 bottom-2 flex items-center gap-2">
            <span class="rounded bg-black/60 px-2 py-0.5 text-xs text-white">Вы</span>
            <MicOff v-if="!call.audioEnabled.value" class="size-4 text-white drop-shadow" />
          </div>
        </div>

        <div
          v-for="remote in call.remotes.value"
          :key="remote.employeeId"
          class="bg-muted relative aspect-video overflow-hidden rounded-xl transition-shadow"
          :class="call.speaking.value.has(remote.employeeId) && 'ring-success ring-2'"
        >
          <video
            :srcObject="remote.stream"
            autoplay
            playsinline
            class="size-full object-cover"
          />
          <div v-if="!remote.hasVideo" class="absolute inset-0 grid place-items-center">
            <UiAvatar :name="nameOf(remote.employeeId)" :id="remote.employeeId" size="lg" />
          </div>
          <span class="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
            {{ nameOf(remote.employeeId) }}
          </span>
        </div>
      </div>

      <div class="flex items-center justify-center gap-3">
        <UiButton
          :variant="call.audioEnabled.value ? 'secondary' : 'destructive'"
          size="icon"
          :title="call.audioEnabled.value ? 'Выключить микрофон' : 'Включить микрофон'"
          @click="call.toggle('audio')"
        >
          <Mic v-if="call.audioEnabled.value" class="size-4" />
          <MicOff v-else class="size-4" />
        </UiButton>

        <UiButton
          :variant="call.videoEnabled.value ? 'secondary' : 'destructive'"
          size="icon"
          :title="call.videoEnabled.value ? 'Выключить камеру' : 'Включить камеру'"
          @click="call.toggle('video')"
        >
          <VideoIcon v-if="call.videoEnabled.value" class="size-4" />
          <VideoOff v-else class="size-4" />
        </UiButton>

        <UiButton variant="destructive" @click="hangUp">
          <PhoneOff class="size-4" />
          Завершить
        </UiButton>
      </div>

      <p v-if="call.failure.value" class="text-destructive text-center text-sm">
        {{ call.failure.value }}
      </p>
    </template>

    <!-- ── Список звонков ──────────────────────────────────────────── -->
    <template v-else>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 class="text-xl font-semibold">Звонки</h1>
          <p class="text-muted-foreground text-sm">
            Сигналинг идёт мимо шлюза, медиапоток — напрямую к SFU
          </p>
        </div>
        <UiButton @click="createOpen = true">
          <PhoneCall class="size-4" />
          Позвонить
        </UiButton>
      </div>

      <UiEmptyState
        v-if="!loading && active.length === 0"
        title="Активных звонков нет"
        description="Начните новый или позвоните из переписки"
        :icon="PhoneCall"
      />

      <div v-else class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <UiCard v-for="room in active" :key="room.roomId">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="truncate text-sm font-semibold">{{ room.title }}</h2>
              <p class="text-muted-foreground mt-0.5 text-xs">
                начат {{ formatDateTime(room.startedAt) }}
              </p>
            </div>
            <UiBadge :variant="room.status === 'ACTIVE' ? 'success' : 'muted'">
              {{ room.status === 'ACTIVE' ? 'идёт' : 'ожидает' }}
            </UiBadge>
          </div>

          <div class="mt-4 flex -space-x-2">
            <UiAvatar
              v-for="participant in room.participants"
              :key="participant.employeeId"
              :name="participant.fullName"
              :id="participant.employeeId"
              size="sm"
              :online="participant.inCall"
              class="ring-card ring-2"
            />
          </div>

          <UiButton class="mt-4 w-full" @click="enter(room.roomId)">Присоединиться</UiButton>
        </UiCard>
      </div>
    </template>

    <UiDialog v-model:open="createOpen" title="Новый звонок">
      <form class="space-y-4" @submit.prevent="start">
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Название</label>
          <UiInput v-model="title" placeholder="Например, Планёрка" />
        </div>
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Участники</label>
          <UiTextarea v-model="invited" placeholder="Идентификаторы сотрудников через запятую" />
          <p class="text-muted-foreground text-xs">
            Приглашённым уйдёт уведомление с высшим приоритетом — оно проходит сквозь тихие часы
          </p>
        </div>
        <div class="flex justify-end gap-2">
          <UiButton type="button" variant="outline" @click="createOpen = false">Отмена</UiButton>
          <UiButton type="submit">Начать</UiButton>
        </div>
      </form>
    </UiDialog>
  </div>
</template>
