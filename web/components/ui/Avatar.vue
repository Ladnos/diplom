<script setup lang="ts">
import { computed } from 'vue';
import { cn, colorOf, initials } from '~/lib/utils';

const props = withDefaults(
  defineProps<{
    name?: string | null;
    id?: string;
    size?: 'sm' | 'md' | 'lg';
    online?: boolean;
    class?: string;
  }>(),
  { size: 'md' },
);

const sizes = { sm: 'size-6 text-[10px]', md: 'size-8 text-xs', lg: 'size-12 text-sm' };

// Цвет выводится из идентификатора, а не из имени: тёзки должны
// различаться, а переименование сотрудника не должно менять его аватар.
const background = computed(() => colorOf(props.id || props.name || '?'));
</script>

<template>
  <span class="relative inline-flex shrink-0">
    <span
      :class="
        cn(
          'flex items-center justify-center rounded-full font-semibold text-black/70 select-none',
          sizes[props.size],
          props.class,
        )
      "
      :style="{ background }"
      :title="props.name ?? undefined"
    >
      {{ initials(props.name) }}
    </span>
    <!-- Точка присутствия с обводкой цветом фона: без неё она сливается
         с самим аватаром на светлых оттенках -->
    <span
      v-if="props.online !== undefined"
      :class="
        cn(
          'border-background absolute -right-0.5 -bottom-0.5 rounded-full border-2',
          props.size === 'lg' ? 'size-3.5' : 'size-2.5',
          props.online ? 'bg-success' : 'bg-muted-foreground/40',
        )
      "
    />
  </span>
</template>
