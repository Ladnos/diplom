import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { PrismaService } from '../prisma/prisma.service';

export interface Period {
  from: Date;
  to: Date;
}

/**
 * Чтение витрин.
 *
 * Все четыре отчёта читают ТОЛЬКО собственные таблицы. Ни одного вызова в
 * чужие сервисы: в этом и смысл материализации — тяжёлый агрегирующий
 * запрос не должен ни конкурировать с OLTP-нагрузкой владельца данных, ни
 * зависеть от его доступности. Отчёт за прошлый квартал обязан строиться
 * и когда hr-service перезапускается.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Кого считать командой.
   *
   * Руководитель видит прямых подчинённых, отдел — своих сотрудников.
   * Транзитивного подчинения здесь нет намеренно: замыкание дерева живёт
   * в auth-service и служит проверке прав, а отчёт «по моей команде» —
   * это про тех, кем человек управляет непосредственно. Иначе директор
   * получал бы в одной таблице всю компанию поимённо.
   */
  async teamMembers(input: {
    managerEmployeeId?: string;
    departmentId?: string;
  }): Promise<string[]> {
    if (!input.managerEmployeeId && !input.departmentId) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'нужен руководитель или отдел',
      });
    }

    const employees = await this.prisma.employeeRef.findMany({
      where: {
        ...(input.managerEmployeeId ? { managerEmployeeId: input.managerEmployeeId } : {}),
        ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      },
      select: { employeeId: true },
    });
    return employees.map((item) => item.employeeId);
  }

  /**
   * Использование рабочего времени.
   *
   * total = норма − отсутствия + переработки: та же формула, по которой
   * hr-service считает табель (§3.2). Дублирование здесь осознанное —
   * витрина обязана давать те же числа, что и первоисточник, иначе
   * отчёт и расчётный лист разойдутся, и доверия не будет ни к одному.
   */
  async timeUtilization(employeeIds: string[], period: Period) {
    if (employeeIds.length === 0) {
      return { rows: [], totalNormMinutes: 0, totalOvertimeMinutes: 0 };
    }

    /*
     * Отсутствие приравнивается к норме ТОГО ЖЕ ДНЯ, и это приходится
     * делать запросом, а не суммой в коде.
     *
     * День отпуска записывается фиксированной восьмичасовой отметкой:
     * событие об отсутствии не несёт длительности — оно про календарные
     * даты, — а расписание смен живёт в hr-service. Отсутствия в системе
     * целодневные: полдня отпуска не бывает. Значит, если на этот день
     * была смена, человек не работал ровно столько, сколько она длилась.
     *
     * Без этой поправки смена в девять часов и отметка в восемь дают
     * «час отработан» в день отпуска, а смена в шесть часов — минус два.
     * Оба числа выглядят как данные, и оба неверны. Там, где смена
     * неизвестна, остаётся восьмичасовая оценка: это единственное, что
     * есть.
     */
    const rows = await this.prisma.$queryRaw<
      {
        employeeId: string;
        normMinutes: number;
        absenceMinutes: number;
        overtimeMinutes: number;
        totalMinutes: number;
      }[]
    >`
      SELECT employee_id AS "employeeId",
             SUM(norm_minutes)::int AS "normMinutes",
             SUM(effective_absence)::int AS "absenceMinutes",
             SUM(overtime_minutes)::int AS "overtimeMinutes",
             GREATEST(0, SUM(norm_minutes - effective_absence + overtime_minutes))::int
               AS "totalMinutes"
        FROM (
              SELECT employee_id,
                     norm_minutes,
                     overtime_minutes,
                     CASE WHEN absence_minutes > 0 AND norm_minutes > 0
                          THEN norm_minutes
                          ELSE absence_minutes
                     END AS effective_absence
                FROM time_facts
               WHERE employee_id = ANY(${employeeIds}::uuid[])
                 AND date BETWEEN ${period.from} AND ${period.to}
             ) AS days
       GROUP BY employee_id
    `;

    return {
      rows,
      totalNormMinutes: rows.reduce((sum, row) => sum + row.normMinutes, 0),
      totalOvertimeMinutes: rows.reduce((sum, row) => sum + row.overtimeMinutes, 0),
    };
  }

  /**
   * Поток задач: lead time, cycle time и где карточки стоят.
   *
   * Средние считаются по ЗАКРЫТЫМ за период карточкам. Незакрытые в
   * среднее не входят: у них нет времени завершения, а подставлять
   * «сейчас» значило бы получать растущее среднее просто оттого, что
   * отчёт открыли позже.
   */
  async taskFlow(boardId: string, period: Period) {
    const closed = await this.prisma.cardFlow.findMany({
      where: {
        boardId,
        closedAt: { gte: period.from, lte: period.to },
      },
      select: { cardId: true, leadHours: true, cycleHours: true },
    });

    const createdCount = await this.prisma.cardFlow.count({
      where: { boardId, createdAt: { gte: period.from, lte: period.to } },
    });

    const leads = closed.map((item) => item.leadHours).filter(isNumber);
    const cycles = closed.map((item) => item.cycleHours).filter(isNumber);

    // Время в колонках — по завершённым пребываниям за период. Открытые
    // не берём по той же причине, по которой не берём незакрытые
    // карточки: их длительность растёт сама собой.
    const visits = await this.prisma.cardColumnVisit.findMany({
      where: {
        card: { boardId },
        leftAt: { gte: period.from, lte: period.to },
      },
      select: { columnId: true, enteredAt: true, leftAt: true },
    });

    const byColumn = new Map<string, { total: number; count: number }>();
    for (const visit of visits) {
      if (!visit.leftAt) continue;
      const hours = (visit.leftAt.getTime() - visit.enteredAt.getTime()) / 3_600_000;
      const bucket = byColumn.get(visit.columnId) ?? { total: 0, count: 0 };
      bucket.total += hours;
      bucket.count += 1;
      byColumn.set(visit.columnId, bucket);
    }

    return {
      avgLeadTimeHours: average(leads),
      avgCycleTimeHours: average(cycles),
      createdCount,
      closedCount: closed.length,
      columnDurations: [...byColumn.entries()]
        .map(([columnId, bucket]) => ({
          columnId,
          avgHours: round(bucket.total / bucket.count),
        }))
        // Сверху — колонки, где задачи стоят дольше всего: именно там
        // узкое место, ради поиска которого отчёт и открывают.
        .sort((a, b) => b.avgHours - a.avgHours),
    };
  }

  /**
   * Статистика встреч.
   *
   * Агрегированная и только по команде целиком: длительность звонков
   * никогда не используется для оценки конкретного сотрудника (§5,
   * ADR-2). Отчёт отвечает на вопрос «сколько времени уходит на
   * созвоны», а не «кто сколько говорил».
   */
  async meetingStats(employeeIds: string[], period: Period) {
    if (employeeIds.length === 0) {
      return { callCount: 0, totalDurationSec: 0, avgParticipants: 0 };
    }

    const calls = await this.prisma.callFact.findMany({
      where: {
        endedAt: { gte: period.from, lte: period.to },
        participants: { hasSome: employeeIds },
      },
      select: { durationSec: true, participants: true },
    });

    const totalDurationSec = calls.reduce((sum, call) => sum + call.durationSec, 0);
    const totalParticipants = calls.reduce((sum, call) => sum + call.participants.length, 0);

    return {
      callCount: calls.length,
      totalDurationSec,
      avgParticipants: calls.length > 0 ? round(totalParticipants / calls.length) : 0,
    };
  }

  /** Заявки: сколько создано, чем кончились и за сколько решались. */
  async approvalStats(employeeIds: string[], period: Period) {
    if (employeeIds.length === 0) {
      return { created: 0, approved: 0, rejected: 0, expired: 0, avgDecisionHours: 0 };
    }

    const facts = await this.prisma.approvalFact.findMany({
      where: {
        authorEmployeeId: { in: employeeIds },
        createdAt: { gte: period.from, lte: period.to },
      },
      select: { outcome: true, createdAt: true, decidedAt: true, escalations: true },
    });

    const decisionHours = facts
      .filter((fact) => fact.decidedAt !== null)
      .map((fact) => (fact.decidedAt!.getTime() - fact.createdAt.getTime()) / 3_600_000);

    return {
      created: facts.length,
      approved: facts.filter((fact) => fact.outcome === 'APPROVED').length,
      rejected: facts.filter((fact) => fact.outcome === 'REJECTED').length,
      // Просроченными считаем эскалированные и не решённые: сработал
      // сторож SLA, а решение так и не приняли.
      expired: facts.filter((fact) => fact.escalations > 0 && fact.outcome === null).length,
      avgDecisionHours: average(decisionHours),
    };
  }
}

function isNumber(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
