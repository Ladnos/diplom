<script setup lang="ts">
import { cn } from '~/lib/utils';

const props = defineProps<{ class?: string }>();
const model = defineModel<string>();
</script>

<template>
  <textarea
    v-model="model"
    :class="
      cn(
        'border-input bg-background flex min-h-16 w-full rounded-md border px-3 py-2 text-sm shadow-sm',
        'placeholder:text-muted-foreground focus-visible:ring-ring transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
        props.class,
      )
    "
  />
</template>
