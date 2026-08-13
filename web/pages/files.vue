<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Files, Upload } from 'lucide-vue-next';
import { formatBytes } from '~/lib/utils';

const api = useApi();
const { error, success } = useToast();

interface Quota {
  usedBytes: number;
  limitBytes: number;
  fileCount: number;
  usedRatio: number;
}

interface Uploaded {
  fileId: string;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  deduplicated: boolean;
}

const quota = ref<Quota | null>(null);
const uploaded = ref<Uploaded[]>([]);
const uploading = ref<{ name: string; progress: number } | null>(null);
const dragActive = ref(false);

onMounted(loadQuota);

async function loadQuota() {
  quota.value = await api.get<Quota>('/api/files/quota').catch(() => null);
}

async function upload(files: FileList | File[]) {
  for (const file of Array.from(files)) {
    uploading.value = { name: file.name, progress: 0 };
    try {
      const result = await api.upload(file, {}, (percent) => {
        if (uploading.value) uploading.value.progress = percent;
      });

      uploaded.value = [{ ...result, deduplicated: false }, ...uploaded.value];
      success(
        'Файл загружен',
        // Дедупликация не скрывается: она объясняет, почему квота не
        // выросла, а файл появился
        (result as Uploaded).deduplicated
          ? 'Такое содержимое уже было — на диске оно хранится один раз'
          : undefined,
      );
    } catch (caught) {
      error('Не удалось загрузить', caught instanceof Error ? caught.message : '');
    } finally {
      uploading.value = null;
    }
  }
  await loadQuota();
}

function onDrop(event: DragEvent) {
  dragActive.value = false;
  if (event.dataTransfer?.files.length) void upload(event.dataTransfer.files);
}

function onPick(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files?.length) void upload(input.files);
  input.value = '';
}

const usedPercent = computed(() =>
  quota.value?.limitBytes ? Math.min(100, (quota.value.usedBytes / quota.value.limitBytes) * 100) : 0,
);
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-xl font-semibold">Файлы</h1>
      <p class="text-muted-foreground text-sm">
        Загрузка идёт напрямую в файловый сервис, минуя шлюз
      </p>
    </div>

    <UiCard v-if="quota" title="Занятая квота">
      <div class="space-y-3">
        <div class="flex items-baseline justify-between">
          <span class="text-2xl font-semibold tabular">{{ formatBytes(quota.usedBytes) }}</span>
          <span class="text-muted-foreground text-sm">из {{ formatBytes(quota.limitBytes) }}</span>
        </div>

        <div class="bg-muted h-2 overflow-hidden rounded-full">
          <div
            class="h-full rounded-full transition-all"
            :class="usedPercent > 90 ? 'bg-destructive' : usedPercent > 70 ? 'bg-warning' : 'bg-success'"
            :style="{ width: `${Math.max(usedPercent, 1)}%` }"
          />
        </div>

        <p class="text-muted-foreground text-xs">
          {{ quota.fileCount }} загрузок. Одинаковое содержимое хранится на диске один раз, но
          в квоту засчитывается каждому загрузившему.
        </p>
      </div>
    </UiCard>

    <!-- ── Загрузка ────────────────────────────────────────────────── -->
    <label
      class="hover:border-foreground/30 flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 transition-colors"
      :class="dragActive && 'border-foreground/40 bg-accent/40'"
      @dragover.prevent="dragActive = true"
      @dragleave="dragActive = false"
      @drop.prevent="onDrop"
    >
      <div class="bg-muted text-muted-foreground rounded-full p-3">
        <Upload class="size-6" />
      </div>
      <div class="text-center">
        <p class="text-sm font-medium">Перетащите файл сюда или выберите</p>
        <p class="text-muted-foreground mt-1 text-xs">До 50 МБ на файл</p>
      </div>
      <input type="file" multiple class="hidden" @change="onPick" />
    </label>

    <div v-if="uploading" class="space-y-2">
      <div class="flex items-center justify-between text-sm">
        <span class="truncate">{{ uploading.name }}</span>
        <span class="text-muted-foreground tabular">{{ uploading.progress }}%</span>
      </div>
      <div class="bg-muted h-1.5 overflow-hidden rounded-full">
        <div class="bg-primary h-full transition-all" :style="{ width: `${uploading.progress}%` }" />
      </div>
    </div>

    <UiCard title="Загружено в этой сессии" body-class="p-0">
      <UiEmptyState
        v-if="uploaded.length === 0"
        title="Пока ничего не загружено"
        description="Файлы, приложенные к сообщениям и карточкам, видны там же"
        :icon="Files"
      />

      <UiDataTable
        v-else
        :rows="uploaded"
        :row-key="(row) => (row as Uploaded).fileId"
        :columns="[
          { key: 'filename', label: 'Имя' },
          { key: 'mimeType', label: 'Тип' },
          { key: 'sizeBytes', label: 'Размер', numeric: true },
          { key: 'actions', label: '', width: '1%' },
        ]"
      >
        <template #sizeBytes="{ row }">{{ formatBytes((row as Uploaded).sizeBytes) }}</template>
        <template #mimeType="{ row }">
          <span class="text-muted-foreground text-xs">{{ (row as Uploaded).mimeType }}</span>
        </template>
        <template #actions="{ row }">
          <div class="flex justify-end">
            <UiButton
              size="sm"
              variant="outline"
              @click="api.download(`/api/files/${(row as Uploaded).fileId}`, (row as Uploaded).filename)"
            >
              Скачать
            </UiButton>
          </div>
        </template>
      </UiDataTable>
    </UiCard>

    <p class="text-muted-foreground text-xs">
      Приватный файл отдаётся с проверкой прав на каждое обращение: доступ к вложению следует за
      доступом к сообщению или карточке, в которых оно висит.
    </p>
  </div>
</template>
