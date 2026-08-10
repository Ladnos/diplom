/**
 * Тихие часы. docs/architecture.md §2.1
 *
 * Уведомление, попавшее в тихие часы, ОТКЛАДЫВАЕТСЯ, а не теряется:
 * человек, включивший тишину с 22:00 до 08:00, хочет не пропустить
 * назначение смены, а не узнать о нём ночью.
 *
 * Интервал задан стенными часами пользователя («с 22:00 до 08:00»), а не
 * моментами времени, поэтому вычисление обязано идти в его зоне. Считать
 * в зоне сервера — значит будить москвичей по калининградскому времени.
 *
 * Внешних библиотек дат здесь нет: Intl в Node 22 знает базу IANA
 * целиком, и добавлять luxon ради двух функций не нужно.
 */

export interface QuietHours {
  enabled: boolean;
  /** HH:MM */
  from: string;
  to: string;
  timezone: string;
}

/** Смещение зоны от UTC в миллисекундах для конкретного момента. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  // hour24 в формате en-US для полуночи приходит как 24 — приводим к 0,
  // иначе Date.UTC уедет на сутки вперёд.
  const hour = get('hour') % 24;
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Календарные поля момента в указанной зоне. */
function zonedParts(instant: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  minutes: number;
} {
  const offset = zoneOffsetMs(instant, timeZone);
  const local = new Date(instant.getTime() + offset);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

/**
 * Момент UTC, соответствующий стенному времени в зоне.
 *
 * Смещение берётся дважды: первое приближение может попасть не в ту
 * сторону перевода часов, и без уточнения весной и осенью уведомления
 * уезжали бы на час.
 */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  minutes: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, 0, minutes);
  const firstGuess = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
  return new Date(naive - zoneOffsetMs(firstGuess, timeZone));
}

/** «22:00» → 1320. Некорректная строка трактуется как полночь. */
export function parseHhMm(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return 0;
  const hours = Math.min(23, Number(match[1]));
  const minutes = Math.min(59, Number(match[2]));
  return hours * 60 + minutes;
}

/**
 * Когда отправлять уведомление с учётом тихих часов.
 *
 * Возвращает `now`, если тишина не действует, иначе — момент её
 * окончания. Интервал, переходящий через полночь (22:00 → 08:00),
 * обрабатывается отдельной ветвью: у него точки входа и выхода лежат
 * в разных сутках, и обычное сравнение «from ≤ t < to» на нём ложно
 * всегда.
 */
export function scheduleAfterQuietHours(quiet: QuietHours, now: Date): Date {
  if (!quiet.enabled) return now;

  const from = parseHhMm(quiet.from);
  const to = parseHhMm(quiet.to);
  // Пустой интервал: тишина ни в один момент не действует
  if (from === to) return now;

  let local: ReturnType<typeof zonedParts>;
  try {
    local = zonedParts(now, quiet.timezone);
  } catch {
    // Неизвестная зона в настройках не должна ронять доставку:
    // отправляем немедленно, тишина просто не применяется.
    return now;
  }

  const overnight = from > to;
  const inQuiet = overnight
    ? local.minutes >= from || local.minutes < to
    : local.minutes >= from && local.minutes < to;

  if (!inQuiet) return now;

  // Конец тишины наступает завтра, если мы вошли в неё до полуночи
  const endsTomorrow = overnight && local.minutes >= from;
  const target = zonedTimeToUtc(
    local.year,
    local.month,
    local.day + (endsTomorrow ? 1 : 0),
    to,
    quiet.timezone,
  );

  // Защита от вырожденного случая: перевод часов может дать момент
  // в прошлом, и тогда доставка ушла бы в бесконечный «уже пора».
  return target.getTime() > now.getTime() ? target : now;
}
