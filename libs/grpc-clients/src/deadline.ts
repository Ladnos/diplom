import { Metadata } from '@grpc/grpc-js';
import { CORRELATION_HEADER, getRequestContext } from '@crm/common';

/**
 * Дедлайны и трассировка исходящих gRPC-вызовов.
 * docs/architecture.md §6.4
 *
 * Дедлайн обязателен для каждого вызова. Без него зависший сервис-адресат
 * держит вызывающего до TCP-таймаута, тот держит своего вызывающего — и
 * отказ одного сервиса поднимается вверх по цепочке до пользователя.
 */

export const DEADLINES_MS = {
  /** Обычный запрос данных. */
  DEFAULT: 2_000,
  /** Проверка прав: вызывается на каждый запрос, должна быть быстрой. */
  PERMISSION: 500,
  /** Отчётные вызовы: агрегация по периоду допустимо дольше. */
  REPORTING: 5_000,
} as const;

/** Метаданные вызова с дедлайном и correlationId из текущего контекста. */
export function callMetadata(deadlineMs: number = DEADLINES_MS.DEFAULT): Metadata {
  const metadata = new Metadata();
  metadata.set(CORRELATION_HEADER, getRequestContext().correlationId);
  // grpc-js читает дедлайн из options вызова, но передача его в метаданных
  // позволяет адресату узнать оставшийся бюджет и не начинать работу,
  // на которую заведомо не хватит времени.
  metadata.set('grpc-timeout', `${deadlineMs}m`);
  return metadata;
}

/**
 * Идемпотентны ли повторы для метода.
 * Повторять можно только чтение: retry на CreateCard создаст две карточки.
 */
export function isRetryable(methodName: string): boolean {
  return /^(get|list|check|exists|search|is)/i.test(methodName);
}
