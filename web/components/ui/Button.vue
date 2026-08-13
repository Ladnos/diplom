<script setup lang="ts">
import { cva, type VariantProps } from 'class-variance-authority';
import { Primitive } from 'reka-ui';
import { cn } from '~/lib/utils';

/**
 * Кнопка.
 *
 * Варианты заданы через cva, а не условиями в разметке: набор допустимых
 * сочетаний виден одним списком, и «а какие вообще бывают кнопки» — это
 * вопрос к этому файлу, а не к поиску по проекту.
 *
 * Primitive из reka-ui даёт `as`: та же кнопка становится ссылкой при
 * `as="a"`, сохраняя вид. Без этого пришлось бы дублировать стили для
 * NuxtLink, и они бы разошлись при первой же правке.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ' +
    'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
    'disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-6',
        icon: 'size-9',
        'icon-sm': 'size-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

type Props = {
  variant?: VariantProps<typeof buttonVariants>['variant'];
  size?: VariantProps<typeof buttonVariants>['size'];
  class?: string;
  as?: string;
  disabled?: boolean;
  loading?: boolean;
};

const props = withDefaults(defineProps<Props>(), { as: 'button' });
</script>

<template>
  <Primitive
    :as="props.as"
    :disabled="props.disabled || props.loading"
    :class="cn(buttonVariants({ variant: props.variant, size: props.size }), props.class)"
  >
    <!-- Спиннер заменяет иконку, а не добавляется к ней: иначе кнопка
         прыгает по ширине в момент нажатия -->
    <span
      v-if="props.loading"
      class="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
    <slot />
  </Primitive>
</template>
