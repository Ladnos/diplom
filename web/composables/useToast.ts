import { ref } from 'vue';

export interface Toast {
  id: number;
  title: string;
  description?: string;
  variant: 'default' | 'success' | 'destructive';
  /** 0 — не скрывать: ошибку человек закрывает сам, прочитав. */
  duration: number;
}

const toasts = ref<Toast[]>([]);
let nextId = 1;

/**
 * Всплывающие сообщения.
 *
 * Состояние вынесено за пределы функции — оно общее для всего
 * приложения: уведомление, вызванное из глубоко вложенного компонента,
 * должно показаться в единственном контейнере, а не рядом с вызвавшим.
 */
export function useToast() {
  function push(toast: Omit<Toast, 'id' | 'duration' | 'variant'> & Partial<Toast>) {
    const item: Toast = {
      id: nextId++,
      variant: toast.variant ?? 'default',
      // Ошибку не прячем по таймеру: она обычно требует действия, а
      // исчезнувший до прочтения текст заставляет повторять операцию,
      // чтобы увидеть его снова.
      duration: toast.duration ?? (toast.variant === 'destructive' ? 0 : 4000),
      title: toast.title,
      description: toast.description,
    };

    toasts.value = [...toasts.value, item];
    if (item.duration > 0) setTimeout(() => dismiss(item.id), item.duration);
    return item.id;
  }

  function dismiss(id: number) {
    toasts.value = toasts.value.filter((item) => item.id !== id);
  }

  return {
    toasts,
    dismiss,
    toast: (title: string, description?: string) => push({ title, description }),
    success: (title: string, description?: string) =>
      push({ title, description, variant: 'success' }),
    error: (title: string, description?: string) =>
      push({ title, description, variant: 'destructive' }),

    /**
     * Обёртка вокруг действия: показывает ошибку и возвращает признак
     * успеха. Позволяет не писать try/catch в каждом обработчике кнопки,
     * не теряя при этом сообщения об ошибке.
     */
    async run<T>(action: () => Promise<T>, successMessage?: string): Promise<T | null> {
      try {
        const result = await action();
        if (successMessage) push({ title: successMessage, variant: 'success' });
        return result;
      } catch (error) {
        push({
          title: 'Не получилось',
          description: error instanceof Error ? error.message : String(error),
          variant: 'destructive',
        });
        return null;
      }
    },
  };
}
