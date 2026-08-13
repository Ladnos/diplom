import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Склейка классов Tailwind с разрешением конфликтов.
 *
 * Без twMerge `class="p-2"` и `class="p-4"`, пришедшие из компонента и
 * снаружи, оба попадали бы в разметку, и какой победит — зависело бы от
 * порядка правил в собранном CSS. С ним побеждает переданный последним,
 * то есть тот, кем компонент настраивают в месте применения.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** «12 345» — узкий пробел между разрядами, как принято в русской типографике. */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat('ru-RU').format(value);
}

/** «1 ч 30 мин» из минут. Ноль показывается явно, а не пустотой. */
export function formatMinutes(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0 мин';

  const hours = Math.floor(total / 60);
  const minutes = Math.round(total % 60);
  if (hours === 0) return `${minutes} мин`;
  return minutes === 0 ? `${hours} ч` : `${hours} ч ${minutes} мин`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** power;
  return `${value >= 10 || power === 0 ? Math.round(value) : value.toFixed(1)} ${units[power]}`;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' })
    .format(date);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * «только что», «5 мин назад», «вчера».
 *
 * В переписке и уведомлениях точное время мешает: важно «недавно или
 * давно», а не «14:37:02». Точное значение остаётся в подсказке.
 */
export function formatRelative(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';

  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return 'только что';
  if (seconds < 3600) return `${Math.round(seconds / 60)} мин назад`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} ч назад`;
  if (seconds < 172800) return 'вчера';
  return formatDate(date);
}

/** Инициалы для аватара: «Иванов Иван» → «ИИ». */
export function initials(fullName?: string | null): string {
  if (!fullName) return '—';
  const parts = fullName.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || '—';
}

/**
 * Устойчивый цвет по строке.
 *
 * Аватар без картинки должен отличаться от соседнего, но цвет обязан
 * оставаться одним и тем же между перезагрузками — иначе список людей
 * при каждом открытии выглядит как новый.
 */
export function colorOf(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `oklch(0.72 0.12 ${hue})`;
}

/** Русское склонение: 1 задача, 2 задачи, 5 задач. */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
