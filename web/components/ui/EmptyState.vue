<script setup lang="ts">
import { Inbox } from 'lucide-vue-next';
import type { Component } from 'vue';

/**
 * Пустое состояние.
 *
 * Отдельный компонент, потому что «пусто» и «не загрузилось» — разные
 * вещи, и показывать вместо данных просто ничего значит оставить человека
 * гадать, какая из двух. Здесь всегда есть объяснение и, по возможности,
 * действие.
 */
const props = defineProps<{
  title: string;
  description?: string;
  icon?: Component;
}>();
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
    <div class="bg-muted text-muted-foreground rounded-full p-3">
      <component :is="props.icon ?? Inbox" class="size-6" />
    </div>
    <div class="space-y-1">
      <p class="text-sm font-medium">{{ props.title }}</p>
      <p v-if="props.description" class="text-muted-foreground max-w-sm text-xs">
        {{ props.description }}
      </p>
    </div>
    <slot />
  </div>
</template>
