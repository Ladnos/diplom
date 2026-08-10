/**
 * Дробные позиции для упорядочивания карточек и колонок.
 *
 * Перетаскивание карточки между двумя соседями не должно переписывать
 * позиции всех остальных: при доске в тысячу карточек это тысяча UPDATE
 * на каждое движение мыши. Вместо этого новая позиция — среднее между
 * соседями, и меняется ровно одна строка.
 *
 * Плата — конечная точность double. После примерно пятидесяти вставок
 * в одно и то же место соседние позиции перестают различаться, и колонку
 * нужно перенумеровать. Проверка ниже это отслеживает.
 */

/** Шаг между позициями при первичном заполнении. */
export const POSITION_STEP = 1024;

/**
 * Минимальный зазор, ниже которого точности уже не хватает.
 *
 * double надёжно различает числа с относительной погрешностью ~1e-15;
 * порог взят с большим запасом, чтобы перебалансировка случалась
 * заведомо раньше реальной потери порядка.
 */
const MIN_GAP = 1e-6;

/**
 * Позиция между двумя соседями.
 *
 * before — позиция карточки, ПОСЛЕ которой вставляем (null, если в начало)
 * after  — позиция карточки, ПЕРЕД которой вставляем (null, если в конец)
 */
export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return POSITION_STEP;
  if (before === null) return after! - POSITION_STEP;
  if (after === null) return before + POSITION_STEP;
  return (before + after) / 2;
}

/** Нужна ли перенумерация: соседи сошлись слишком близко. */
export function needsRebalance(before: number | null, after: number | null): boolean {
  if (before === null || after === null) return false;
  return Math.abs(after - before) < MIN_GAP;
}

/**
 * Новые позиции для списка элементов в текущем порядке.
 * Возвращает пары «id → позиция» с равномерным шагом.
 */
export function rebalance<T extends { id: string }>(items: T[]): { id: string; position: number }[] {
  return items.map((item, index) => ({ id: item.id, position: (index + 1) * POSITION_STEP }));
}

/**
 * Куда встанет элемент при вставке на указанный индекс.
 *
 * Индекс — то, что присылает интерфейс после перетаскивания: «карточка
 * теперь третья сверху». Соседей определяем по отсортированному списку.
 */
export function positionForIndex(sortedPositions: number[], targetIndex: number): number {
  const clamped = Math.max(0, Math.min(targetIndex, sortedPositions.length));
  const before = clamped === 0 ? null : sortedPositions[clamped - 1];
  const after = clamped >= sortedPositions.length ? null : sortedPositions[clamped];
  return positionBetween(before, after);
}
