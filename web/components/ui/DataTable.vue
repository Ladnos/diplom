<script setup lang="ts" generic="T extends Record<string, unknown>">
import { cn } from '~/lib/utils';

export interface Column<Row> {
  key: string;
  label: string;
  /** Числовые колонки прижимаются вправо: так разряды выстраиваются в столбец. */
  numeric?: boolean;
  class?: string;
  width?: string;
}

const props = defineProps<{
  columns: Column<T>[];
  rows: T[];
  loading?: boolean;
  empty?: string;
  rowKey?: (row: T, index: number) => string | number;
  class?: string;
}>();

const emit = defineEmits<{ rowClick: [row: T] }>();
</script>

<template>
  <div :class="cn('w-full overflow-x-auto', props.class)">
    <table class="w-full text-sm">
      <thead>
        <tr class="text-muted-foreground border-b text-left">
          <th
            v-for="column in props.columns"
            :key="column.key"
            :style="column.width ? { width: column.width } : undefined"
            :class="
              cn('px-3 py-2 text-xs font-medium', column.numeric && 'text-right', column.class)
            "
          >
            {{ column.label }}
          </th>
        </tr>
      </thead>

      <tbody>
        <!-- Скелет вместо спиннера: он держит высоту таблицы, и содержимое
             под ней не подпрыгивает, когда данные приедут -->
        <tr v-if="props.loading" v-for="row in 3" :key="`skeleton-${row}`" class="border-b">
          <td v-for="column in props.columns" :key="column.key" class="px-3 py-3">
            <div class="bg-muted h-4 w-full animate-pulse rounded" />
          </td>
        </tr>

        <tr v-else-if="props.rows.length === 0">
          <td
            :colspan="props.columns.length"
            class="text-muted-foreground px-3 py-10 text-center text-sm"
          >
            {{ props.empty ?? 'Пока пусто' }}
          </td>
        </tr>

        <tr
          v-else
          v-for="(row, index) in props.rows"
          :key="props.rowKey?.(row, index) ?? index"
          class="hover:bg-muted/50 border-b transition-colors last:border-0"
          @click="emit('rowClick', row)"
        >
          <td
            v-for="column in props.columns"
            :key="column.key"
            :class="cn('px-3 py-2.5', column.numeric && 'tabular text-right')"
          >
            <slot :name="column.key" :row="row" :value="row[column.key]">
              {{ row[column.key] ?? '—' }}
            </slot>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
