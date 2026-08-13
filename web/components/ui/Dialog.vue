<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import { X } from 'lucide-vue-next';
import { cn } from '~/lib/utils';

/**
 * Модальное окно поверх reka-ui.
 *
 * Своя реализация означала бы вручную писать возврат фокуса, ловушку
 * табуляции, закрытие по Escape и запрет прокрутки под окном — четыре
 * вещи, о которых вспоминают уже после того, как клавиатурой
 * пользоваться стало невозможно.
 */
const props = defineProps<{
  title?: string;
  description?: string;
  class?: string;
}>();

const open = defineModel<boolean>('open', { default: false });
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
      />
      <DialogContent
        :class="
          cn(
            'bg-background fixed top-1/2 left-1/2 z-50 grid w-[calc(100vw-2rem)] max-w-lg',
            '-translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border p-6 shadow-lg',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            'max-h-[calc(100vh-4rem)] overflow-y-auto',
            props.class,
          )
        "
      >
        <div v-if="props.title || $slots.title" class="flex flex-col gap-1.5">
          <DialogTitle class="text-base leading-none font-semibold">
            <slot name="title">{{ props.title }}</slot>
          </DialogTitle>
          <DialogDescription v-if="props.description" class="text-muted-foreground text-sm">
            {{ props.description }}
          </DialogDescription>
        </div>

        <slot :close="() => (open = false)" />

        <div v-if="$slots.footer" class="flex justify-end gap-2">
          <slot name="footer" :close="() => (open = false)" />
        </div>

        <DialogClose
          class="ring-offset-background focus:ring-ring absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:outline-none"
          aria-label="Закрыть"
        >
          <X class="size-4" />
        </DialogClose>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
