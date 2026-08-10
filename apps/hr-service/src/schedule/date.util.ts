/**
 * Работа с календарными датами.
 *
 * Всё считается в UTC. Причина не в удобстве, а в корректности: колонки
 * типа DATE не имеют часового пояса, и если разбирать «2026-03-08» в
 * местной зоне, то при отрицательном смещении получится 7 марта, а при
 * положительном — 8-е, но с ненулевым временем. Табель начинает «терять»
 * дни на границах месяца. Поэтому дата здесь — это всегда полночь UTC.
 */

export type IsoDate = string; // YYYY-MM-DD

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** '2026-03-08' → Date(2026-03-08T00:00:00.000Z) */
export function parseDate(iso: IsoDate): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) throw new Error(`некорректная дата: ${iso}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

/** Date → '2026-03-08' */
export function toIsoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

/** Полночь UTC того же календарного дня. */
export function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

export function daysBetween(from: Date, to: Date): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / MS_PER_DAY);
}

/** Все даты периода включительно. */
export function eachDate(from: Date, to: Date): Date[] {
  const result: Date[] = [];
  for (let date = startOfDay(from); date <= to; date = addDays(date, 1)) {
    result.push(date);
  }
  return result;
}

/** День недели по ISO 8601: 1 = понедельник … 7 = воскресенье. */
export function isoWeekday(date: Date): number {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

export function isWeekend(date: Date): boolean {
  return isoWeekday(date) >= 6;
}

/** 'HH:MM' → минуты от начала суток. */
export function parseTime(time: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) throw new Error(`некорректное время: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatTime(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  return `${String(hours).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

/**
 * Длительность смены в минутах.
 *
 * Ночная смена (22:00–06:00) даёт отрицательную разницу — к ней
 * добавляются сутки. Без этой поправки сменный график «сутки через трое»
 * считался бы отрицательным временем.
 */
export function shiftDurationMinutes(startsAt: string, endsAt: string, breakMinutes: number): number {
  const start = parseTime(startsAt);
  const end = parseTime(endsAt);
  const raw = end >= start ? end - start : end + 1440 - start;
  return Math.max(0, raw - breakMinutes);
}

/** Границы периода с проверкой: from не позже to, длина в разумных пределах. */
export function normalizePeriod(from: IsoDate, to: IsoDate, maxDays = 400): { from: Date; to: Date } {
  const start = parseDate(from);
  const end = parseDate(to);
  if (end < start) throw new Error('конец периода раньше начала');
  if (daysBetween(start, end) > maxDays) {
    throw new Error(`период длиннее ${maxDays} дней`);
  }
  return { from: start, to: end };
}
