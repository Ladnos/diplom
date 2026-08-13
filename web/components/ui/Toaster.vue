<script setup lang="ts">
import { CheckCircle2, Info, X, XCircle } from 'lucide-vue-next';
import { cn } from '~/lib/utils';

const { toasts, dismiss } = useToast();

const icons = { default: Info, success: CheckCircle2, destructive: XCircle };
</script>

<template>
  <!-- aria-live: программа чтения с экрана произнесёт сообщение, не
       уводя фокус с того, что человек делает -->
  <div
    class="pointer-events-none fixed right-4 bottom-4 z-100 flex w-full max-w-sm flex-col gap-2"
    role="status"
    aria-live="polite"
  >
    <TransitionGroup
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-2 opacity-0"
      leave-active-class="transition duration-150 ease-in absolute"
      leave-to-class="translate-x-4 opacity-0"
    >
      <div
        v-for="item in toasts"
        :key="item.id"
        :class="
          cn(
            'bg-popover text-popover-foreground pointer-events-auto flex gap-3 rounded-lg border p-4 shadow-lg',
            item.variant === 'destructive' && 'border-destructive/40',
            item.variant === 'success' && 'border-success/40',
          )
        "
      >
        <component
          :is="icons[item.variant]"
          :class="
            cn(
              'mt-0.5 size-4 shrink-0',
              item.variant === 'destructive' && 'text-destructive',
              item.variant === 'success' && 'text-success',
              item.variant === 'default' && 'text-muted-foreground',
            )
          "
        />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">{{ item.title }}</p>
          <p v-if="item.description" class="text-muted-foreground mt-0.5 text-xs break-words">
            {{ item.description }}
          </p>
        </div>
        <button
          class="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
          aria-label="Закрыть"
          @click="dismiss(item.id)"
        >
          <X class="size-4" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>
