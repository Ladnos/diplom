import { io, type Socket } from 'socket.io-client';
import { ref, shallowRef } from 'vue';
import { useAuthStore } from '~/stores/auth';

type Handler = (payload: Record<string, unknown>) => void;

const socket = shallowRef<Socket | null>(null);
const connected = ref(false);
/** Комнаты, в которых мы состоим: их нужно восстановить после разрыва. */
const rooms = ref(new Set<string>());
const handlers = new Map<string, Set<Handler>>();

/**
 * Живое соединение со шлюзом. docs/architecture.md §8.1
 *
 * ОДНО СОЕДИНЕНИЕ НА ВСЁ ПРИЛОЖЕНИЕ. Через него приходят и обновления
 * доски, и сообщения чата, и счётчик уведомлений: держать по соединению
 * на раздел значило бы открывать новое при каждом переходе и терять
 * события в промежутке.
 *
 * Состояние вынесено из функции по той же причине, что и у всплывающих
 * сообщений: подписка, оформленная на одной странице, должна пережить
 * переход на другую, если та слушает то же событие.
 */
export function useRealtime() {
  const auth = useAuthStore();
  const config = useRuntimeConfig();

  function connect() {
    if (socket.value || !auth.accessToken) return;

    const instance = io(config.public.apiBase || window.location.origin, {
      path: '/ws',
      transports: ['websocket'],
      auth: { token: auth.accessToken },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
    });

    instance.on('connect', () => {
      connected.value = true;
    });

    instance.on('ready', () => {
      // Комнаты восстанавливаются ПОСЛЕ ready, а не после connect:
      // до рукопожатия шлюз ещё не знает, кто подключился, и проверять
      // право на комнату ему не по чему.
      if (rooms.value.size > 0) instance.emit('subscribe', { rooms: [...rooms.value] });
    });

    instance.on('disconnect', () => {
      connected.value = false;
    });

    /**
     * Токен истёк — шлюз закрывает соединение. Обновляем и переподключаемся
     * сами: библиотека попыталась бы переподключиться с тем же токеном и
     * получала бы отказ до бесконечности.
     */
    instance.on('unauthorized', () => {
      void auth.refresh().then((ok) => {
        disconnect();
        if (ok) connect();
      });
    });

    // Все события шлюза названы по routing key, поэтому слушаем разом:
    // подписываться на каждый тип отдельно означало бы перечислять их
    // здесь и забывать при добавлении нового.
    instance.onAny((event: string, payload: Record<string, unknown>) => {
      for (const handler of handlers.get(event) ?? []) handler(payload);
      for (const handler of handlers.get('*') ?? []) handler({ ...payload, __event: event });
    });

    socket.value = instance;
  }

  function disconnect() {
    socket.value?.close();
    socket.value = null;
    connected.value = false;
  }

  /** Подписка на событие. Возвращает функцию отписки для onUnmounted. */
  function on(event: string, handler: Handler): () => void {
    const set = handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    handlers.set(event, set);
    return () => set.delete(handler);
  }

  /**
   * Вход в комнаты.
   *
   * Список запоминается, чтобы восстановить подписку после разрыва:
   * сервер о ней не помнит — соединение новое, и для него это новый
   * клиент.
   */
  async function join(...names: string[]): Promise<void> {
    for (const name of names) rooms.value.add(name);
    if (!socket.value?.connected) return;

    await new Promise<void>((resolve) => {
      socket.value!.emit('subscribe', { rooms: names }, () => resolve());
      setTimeout(resolve, 3000);
    });
  }

  function leave(...names: string[]) {
    for (const name of names) rooms.value.delete(name);
    socket.value?.emit('unsubscribe', { rooms: names });
  }

  function emit(event: string, payload: unknown) {
    socket.value?.emit(event, payload);
  }

  return { connect, disconnect, on, join, leave, emit, connected, socket };
}
