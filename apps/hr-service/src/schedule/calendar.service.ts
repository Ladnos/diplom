import { Injectable, Logger } from '@nestjs/common';
import type { CalendarDayKind } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, eachDate, isWeekend, parseDate, toIsoDate, type IsoDate } from './date.util';

/**
 * Производственный календарь.
 *
 * В базе хранятся ТОЛЬКО исключения: нерабочие праздничные дни и
 * перенесённые рабочие субботы. Обычные будни и выходные выводятся из
 * дня недели — хранить 250 одинаковых строк на год бессмысленно.
 *
 * Сокращённый предпраздничный день не хранится, а ВЫВОДИТСЯ: по ст. 95
 * ТК РФ рабочий день, непосредственно предшествующий нерабочему
 * праздничному, сокращается на час. Это правило, а не данные, — значит,
 * оно не может разъехаться с фактическим списком праздников.
 */

export type DayKind = 'WORKING' | 'WEEKEND' | 'HOLIDAY' | 'SHORTENED';

/**
 * Нерабочие праздничные дни по ст. 112 ТК РФ. Даты закреплены в кодексе
 * и не меняются год от года — их можно засеять.
 *
 * ПЕРЕНОСЫ выходных (когда праздник выпал на субботу) устанавливаются
 * отдельным постановлением Правительства на каждый год и здесь НЕ
 * прописаны: угадывать их нельзя, они добавляются администратором через
 * записи kind = WORKDAY и kind = HOLIDAY.
 */
const STATUTORY_HOLIDAYS: { month: number; day: number; note: string }[] = [
  { month: 1, day: 1, note: 'Новогодние каникулы' },
  { month: 1, day: 2, note: 'Новогодние каникулы' },
  { month: 1, day: 3, note: 'Новогодние каникулы' },
  { month: 1, day: 4, note: 'Новогодние каникулы' },
  { month: 1, day: 5, note: 'Новогодние каникулы' },
  { month: 1, day: 6, note: 'Новогодние каникулы' },
  { month: 1, day: 7, note: 'Рождество Христово' },
  { month: 1, day: 8, note: 'Новогодние каникулы' },
  { month: 2, day: 23, note: 'День защитника Отечества' },
  { month: 3, day: 8, note: 'Международный женский день' },
  { month: 5, day: 1, note: 'Праздник Весны и Труда' },
  { month: 5, day: 9, note: 'День Победы' },
  { month: 6, day: 12, note: 'День России' },
  { month: 11, day: 4, note: 'День народного единства' },
];

/** Сокращение предпраздничного дня, ст. 95 ТК РФ. */
export const SHORTENED_DAY_REDUCTION_MINUTES = 60;

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Вид дня с учётом исключений календаря.
   *
   * Порядок важен: явная запись перекрывает правило, правило перекрывает
   * день недели. Иначе перенесённая рабочая суббота осталась бы выходным.
   */
  async getDayKinds(from: Date, to: Date): Promise<Map<IsoDate, DayKind>> {
    // Захватываем день после периода: он нужен, чтобы определить,
    // является ли последний день периода предпраздничным.
    const overrides = await this.prisma.calendarDay.findMany({
      where: { date: { gte: from, lte: addDays(to, 1) } },
      select: { date: true, kind: true },
    });

    const explicit = new Map<IsoDate, CalendarDayKind>(
      overrides.map((day) => [toIsoDate(day.date), day.kind]),
    );

    const result = new Map<IsoDate, DayKind>();

    for (const date of eachDate(from, to)) {
      const iso = toIsoDate(date);
      const override = explicit.get(iso);

      if (override === 'HOLIDAY') {
        result.set(iso, 'HOLIDAY');
        continue;
      }
      if (override === 'SHORTENED') {
        result.set(iso, 'SHORTENED');
        continue;
      }

      // WORKDAY — перенесённая рабочая суббота: выходной становится рабочим
      const working = override === 'WORKDAY' || !isWeekend(date);
      if (!working) {
        result.set(iso, 'WEEKEND');
        continue;
      }

      // Правило ст. 95: рабочий день перед нерабочим праздничным короче на час
      const nextIso = toIsoDate(addDays(date, 1));
      result.set(iso, explicit.get(nextIso) === 'HOLIDAY' ? 'SHORTENED' : 'WORKING');
    }

    return result;
  }

  /** Засев праздников на год. Идемпотентен: повторный вызов ничего не ломает. */
  async seedYear(year: number): Promise<number> {
    let created = 0;

    for (const holiday of STATUTORY_HOLIDAYS) {
      const date = parseDate(
        `${year}-${String(holiday.month).padStart(2, '0')}-${String(holiday.day).padStart(2, '0')}`,
      );
      const result = await this.prisma.calendarDay.upsert({
        where: { date },
        create: { date, kind: 'HOLIDAY', note: holiday.note },
        update: { kind: 'HOLIDAY', note: holiday.note },
      });
      if (result) created += 1;
    }

    this.logger.log({
      message: 'производственный календарь засеян',
      year,
      holidays: created,
      note: 'переносы выходных задаются отдельно: их устанавливает постановление Правительства',
    });
    return created;
  }

  async listExceptions(from: Date, to: Date) {
    return this.prisma.calendarDay.findMany({
      where: { date: { gte: from, lte: to } },
      orderBy: { date: 'asc' },
    });
  }

  /** Ручная правка календаря: перенос выходного, региональный праздник. */
  async setDay(date: Date, kind: CalendarDayKind, note?: string) {
    return this.prisma.calendarDay.upsert({
      where: { date },
      create: { date, kind, note },
      update: { kind, note },
    });
  }

  async removeDay(date: Date): Promise<void> {
    await this.prisma.calendarDay.deleteMany({ where: { date } });
  }
}
