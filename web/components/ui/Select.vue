<script setup lang="ts">
import {
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from 'reka-ui';
import { Check, ChevronDown } from 'lucide-vue-next';
import { cn } from '~/lib/utils';

export interface SelectOption {
  value: string;
  label: string;
}

const props = defineProps<{
  options: SelectOption[];
  placeholder?: string;
  class?: string;
  disabled?: boolean;
}>();

const model = defineModel<string | undefined>();
</script>

<template>
  <SelectRoot v-model="model" :disabled="props.disabled">
    <SelectTrigger
      :class="
        cn(
          'border-input bg-background flex h-9 w-full items-center justify-between gap-2 rounded-md border px-3 py-1 text-sm shadow-sm',
          'focus:ring-ring focus:ring-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
          '[&>span]:truncate',
          props.class,
        )
      "
    >
      <SelectValue :placeholder="props.placeholder ?? 'Выберите…'" />
      <ChevronDown class="size-4 shrink-0 opacity-50" />
    </SelectTrigger>

    <SelectPortal>
      <SelectContent
        position="popper"
        :side-offset="4"
        class="bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out z-50 max-h-72 min-w-(--reka-select-trigger-width) overflow-hidden rounded-md border shadow-md"
      >
        <SelectViewport class="p-1">
          <SelectItem
            v-for="option in props.options"
            :key="option.value"
            :value="option.value"
            class="focus:bg-accent focus:text-accent-foreground relative flex w-full cursor-pointer items-center rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none"
          >
            <SelectItemText>{{ option.label }}</SelectItemText>
            <SelectItemIndicator class="absolute right-2 flex items-center">
              <Check class="size-4" />
            </SelectItemIndicator>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
