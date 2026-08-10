/**
 * Общий контракт канала доставки.
 *
 * Три исхода вместо привычных двух, и различие принципиально:
 *   • ok      — доставлено;
 *   • retry   — виноват транспорт (SMTP не ответил, шлюз вернул 503).
 *               Повторять имеет смысл;
 *   • dropped — виноват адрес (подписка протухла, ящик не существует).
 *               Повторять бессмысленно, а место назначения нужно убрать.
 *
 * Без третьего исхода протухшая push-подписка тратила бы все попытки
 * при каждом уведомлении, и очередь доставки постепенно вырождалась
 * в перебор мёртвых адресов.
 */
export type SendResult =
  | { outcome: 'ok' }
  | { outcome: 'retry'; error: string }
  | { outcome: 'dropped'; error: string };

export interface OutgoingMessage {
  /** Адрес: e-mail или endpoint push-подписки. */
  target: string;
  title: string;
  body: string;
  /** Абсолютный адрес — относительный путь из уведомления уже развёрнут. */
  url?: string;
  recipientName: string;
  priority: string;
  notificationId: string;
}

export interface ChannelSender {
  /** Готов ли канал отправлять: без ключей VAPID push не отправить. */
  readonly available: boolean;
  send(message: OutgoingMessage): Promise<SendResult>;
}
