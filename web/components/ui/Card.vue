<script setup lang="ts">
import { cn } from '~/lib/utils';

const props = defineProps<{
  title?: string;
  description?: string;
  class?: string;
  bodyClass?: string;
}>();
</script>

<template>
  <section :class="cn('bg-card text-card-foreground rounded-xl border shadow-sm', props.class)">
    <header
      v-if="props.title || $slots.header || $slots.actions"
      class="flex items-start justify-between gap-4 border-b px-5 py-4"
    >
      <div class="min-w-0">
        <slot name="header">
          <h2 class="truncate text-sm font-semibold">{{ props.title }}</h2>
          <p v-if="props.description" class="text-muted-foreground mt-0.5 text-xs">
            {{ props.description }}
          </p>
        </slot>
      </div>
      <div v-if="$slots.actions" class="flex shrink-0 items-center gap-2">
        <slot name="actions" />
      </div>
    </header>

    <div :class="cn('p-5', props.bodyClass)">
      <slot />
    </div>

    <footer v-if="$slots.footer" class="border-t px-5 py-3">
      <slot name="footer" />
    </footer>
  </section>
</template>
