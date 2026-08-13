<script setup lang="ts">
import { cn } from '~/lib/utils';

const props = defineProps<{ class?: string }>();
const model = defineModel<string | number | null>();
</script>

<template>
  <input
    v-model="model"
    :class="
      cn(
        'border-input bg-background flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-sm',
        'placeholder:text-muted-foreground focus-visible:ring-ring transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
        // aria-invalid ставит форма при ошибке валидации: рамка меняется
        // без дополнительного класса в каждом месте применения
        'aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive',
        props.class,
      )
    "
  />
</template>
