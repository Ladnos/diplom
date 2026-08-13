import { Injectable, Logger } from '@nestjs/common';
import {
  ApprovalEvents,
  HrEvents,
  TaskEvents,
  VideoEvents,
  type AbsenceRegistered,
  type CallEnded,
  type CardClosed,
  type CardCreated,
  type CardMoved,
  type EmployeeCreated,
  type EmployeeDeactivated,
  type EmployeeUpdated,
  type EmploymentChanged,
  type Envelope,
  type HierarchyChanged,
  type OvertimeRegistered,
  type RequestCreated,
  type RequestEscalated,
  type RequestRejected,
  type ShiftAssigned,
  type ShiftCancelled,
  type TimesheetCorrected,
} from '@crm/contracts';
import { PrismaService } from '../prisma/prisma.service';

/** Рабочий день по умолчанию — когда длительность смены неизвестна. */
const DEFAULT_WORKDAY_MINUTES = 8 * 60;

/**
 * Материализация витрин из потока событий. docs/architecture.md §12
 *
 * Это и есть read-модель CQRS: тяжёлые агрегирующие запросы не ходят в
 * чужие базы, а читают собственные таблицы, наполненные заранее. Цена —
 * отставание на время доставки события; для отчётности, которую смотрят
 * раз в день, она не имеет значения, а конкуренция с OLTP-нагрузкой
 * имела бы.
 *
 * Отсутствие проекции для события — нормальный исход: сервис подписан на
 * всю шину, но в витрины попадает малая её часть. Остальное остаётся
 * только в журнале аудита.
 */
@Injectable()
export class ProjectionsService {
  private readonly logger = new Logger(ProjectionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Разложить событие по витринам. Возвращает true, если что-то изменилось. */
  async apply(envelope: Envelope): Promise<boolean> {
    switch (envelope.eventType) {
      // ── Измерение: сотрудники ──────────────────────────────────────────
      case HrEvents.EMPLOYEE_CREATED:
        return this.employeeCreated(envelope.payload as EmployeeCreated);
      case HrEvents.EMPLOYEE_UPDATED:
        return this.employeeUpdated(envelope.payload as EmployeeUpdated);
      case HrEvents.EMPLOYEE_DEACTIVATED:
        return this.employeeDeactivated(envelope.payload as EmployeeDeactivated);
      case HrEvents.HIERARCHY_CHANGED:
        return this.hierarchyChanged(envelope.payload as HierarchyChanged);
      case HrEvents.EMPLOYMENT_CHANGED:
        return this.employmentChanged(envelope.payload as EmploymentChanged);

      // ── Витрина рабочего времени ───────────────────────────────────────
      case HrEvents.SHIFT_ASSIGNED:
        return this.shiftAssigned(envelope.payload as ShiftAssigned);
      case HrEvents.SHIFT_CANCELLED:
        return this.shiftCancelled(envelope.payload as ShiftCancelled);
      case HrEvents.ABSENCE_REGISTERED:
        return this.absenceRegistered(envelope.payload as AbsenceRegistered);
      case HrEvents.OVERTIME_REGISTERED:
        return this.overtimeRegistered(envelope.payload as OvertimeRegistered);
      case HrEvents.TIMESHEET_CORRECTED:
        return this.timesheetCorrected(envelope.payload as TimesheetCorrected);

      // ── Витрина потока задач ───────────────────────────────────────────
      case TaskEvents.CARD_CREATED:
        return this.cardCreated(envelope.payload as CardCreated, envelope.occurredAt);
      case TaskEvents.CARD_MOVED:
        return this.cardMoved(envelope.payload as CardMoved, envelope.occurredAt);
      case TaskEvents.CARD_CLOSED:
        return this.cardClosed(envelope.payload as CardClosed);

      // ── Витрина согласований ───────────────────────────────────────────
      case ApprovalEvents.REQUEST_CREATED:
        return this.requestCreated(envelope.payload as RequestCreated, envelope.occurredAt);
      case ApprovalEvents.REQUEST_APPROVED:
        return this.requestDecided(
          (envelope.payload as { requestId: string }).requestId,
          'APPROVED',
          envelope.occurredAt,
        );
      case ApprovalEvents.REQUEST_REJECTED:
        return this.requestDecided(
          (envelope.payload as RequestRejected).requestId,
          'REJECTED',
          envelope.occurredAt,
        );
      case ApprovalEvents.REQUEST_ESCALATED:
        return this.requestEscalated(envelope.payload as RequestEscalated);

      // ── Витрина встреч ─────────────────────────────────────────────────
      case VideoEvents.CALL_ENDED:
        return this.callEnded(envelope.payload as CallEnded, envelope.occurredAt);

      default:
        return false;
    }
  }

  // ── Сотрудники ────────────────────────────────────────────────────────

  private async employeeCreated(payload: EmployeeCreated): Promise<boolean> {
    await this.prisma.employeeRef.upsert({
      where: { employeeId: payload.employeeId },
      create: {
        employeeId: payload.employeeId,
        fullName: payload.fullName,
        departmentId: payload.departmentId ?? null,
        managerEmployeeId: payload.managerId ?? null,
        employmentType: payload.employment?.type ?? null,
        timePolicy: payload.employment?.policy ?? null,
        active: true,
      },
      update: {
        fullName: payload.fullName,
        departmentId: payload.departmentId ?? null,
        managerEmployeeId: payload.managerId ?? null,
        employmentType: payload.employment?.type ?? null,
        timePolicy: payload.employment?.policy ?? null,
        active: true,
      },
    });
    return true;
  }

  private async employeeUpdated(payload: EmployeeUpdated): Promise<boolean> {
    const changed = payload.changed ?? {};
    const data = {
      ...(changed.fullName !== undefined ? { fullName: changed.fullName } : {}),
      ...(changed.departmentId !== undefined ? { departmentId: changed.departmentId } : {}),
      ...(changed.managerId !== undefined ? { managerEmployeeId: changed.managerId } : {}),
    };
    if (Object.keys(data).length === 0) return false;

    await this.prisma.employeeRef.updateMany({ where: { employeeId: payload.employeeId }, data });
    return true;
  }

  /**
   * Увольнение помечает сотрудника, но не убирает ни его самого, ни его
   * факты. Отчёт за прошлый квартал обязан сойтись и после того, как
   * половина команды сменилась.
   */
  private async employeeDeactivated(payload: EmployeeDeactivated): Promise<boolean> {
    await this.prisma.employeeRef.upsert({
      where: { employeeId: payload.employeeId },
      create: { employeeId: payload.employeeId, fullName: '', active: false },
      update: { active: false },
    });
    return true;
  }

  private async hierarchyChanged(payload: HierarchyChanged): Promise<boolean> {
    await this.prisma.employeeRef.updateMany({
      where: { employeeId: payload.employeeId },
      data: { managerEmployeeId: payload.newManagerId ?? null },
    });
    return true;
  }

  /**
   * Смена типа найма меняет методику расчёта с даты (§10.5). Прошлые
   * факты не пересчитываются: они посчитаны по действовавшим тогда
   * правилам, и переписать их задним числом означало бы подменить
   * историю.
   */
  private async employmentChanged(payload: EmploymentChanged): Promise<boolean> {
    await this.prisma.employeeRef.updateMany({
      where: { employeeId: payload.employeeId },
      data: {
        employmentType: payload.after?.type ?? null,
        timePolicy: payload.after?.policy ?? null,
      },
    });
    return true;
  }

  // ── Рабочее время ─────────────────────────────────────────────────────

  private async shiftAssigned(payload: ShiftAssigned): Promise<boolean> {
    const minutes = shiftMinutes(payload.startsAt, payload.endsAt);
    await this.addTime(payload.employeeId, payload.date, { normMinutes: minutes });
    return true;
  }

  private async shiftCancelled(payload: ShiftCancelled): Promise<boolean> {
    // Событие не несёт ни даты, ни длительности — только идентификатор
    // смены. Восстановить, что вычитать, здесь нечем: витрина хранит
    // агрегат по дню, а не отдельные смены. Отмену увидит следующее
    // закрытие периода, которое приходит с итогами.
    this.logger.debug({ message: 'отмена смены не отражается в витрине', shiftId: payload.shiftId });
    return false;
  }

  /**
   * Отсутствие раскладывается по дням периода.
   *
   * Выходные внутри отпуска здесь не вычитаются: производственный
   * календарь живёт в hr-service, и тянуть его в каждую проекцию значило
   * бы держать вторую копию правды. Для отчёта «сколько дней человека не
   * было» это верно; расчёт оплаты делает табель.
   */
  private async absenceRegistered(payload: AbsenceRegistered): Promise<boolean> {
    const days = datesBetween(payload.period.from, payload.period.to);
    if (days.length === 0) return false;

    for (const date of days) {
      await this.addTime(payload.employeeId, date, {
        absenceMinutes: DEFAULT_WORKDAY_MINUTES,
        absenceType: payload.type,
      });
    }
    return true;
  }

  private async overtimeRegistered(payload: OvertimeRegistered): Promise<boolean> {
    await this.addTime(payload.employeeId, payload.date, { overtimeMinutes: payload.minutes });
    return true;
  }

  /**
   * Корректировка табеля — замена, а не добавка: событие несёт «было» и
   * «стало», и прибавлять разницу к накопленному значило бы получить
   * третье число, не равное ни одному из них.
   */
  private async timesheetCorrected(payload: TimesheetCorrected): Promise<boolean> {
    const date = toDate(payload.date);
    if (!date) return false;

    await this.prisma.timeFact.upsert({
      where: { employeeId_date: { employeeId: payload.employeeId, date } },
      create: {
        employeeId: payload.employeeId,
        date,
        normMinutes: payload.afterMinutes,
      },
      update: { normMinutes: payload.afterMinutes },
    });
    return true;
  }

  // ── Поток задач ───────────────────────────────────────────────────────

  private async cardCreated(payload: CardCreated, occurredAt: string): Promise<boolean> {
    const createdAt = new Date(occurredAt);
    await this.prisma.cardFlow.upsert({
      where: { cardId: payload.cardId },
      create: { cardId: payload.cardId, boardId: payload.boardId, createdAt },
      update: {},
    });

    await this.prisma.cardColumnVisit.create({
      data: { cardId: payload.cardId, columnId: payload.columnId, enteredAt: createdAt },
    });
    return true;
  }

  /**
   * Перемещение закрывает пребывание в прежней колонке и открывает новое.
   *
   * Первое перемещение считается началом работы: карточка ушла из
   * входящей колонки, значит за неё взялись. Отсюда и cycle time —
   * от начала работы, а не от постановки.
   */
  private async cardMoved(payload: CardMoved, occurredAt: string): Promise<boolean> {
    const at = new Date(occurredAt);

    const flow = await this.prisma.cardFlow.findUnique({ where: { cardId: payload.cardId } });
    if (!flow) {
      // Карточка создана до того, как сервис начал слушать шину. Заводим
      // с момента перемещения: неполная запись полезнее отсутствующей,
      // а lead time по ней просто не посчитается.
      await this.prisma.cardFlow.create({
        data: { cardId: payload.cardId, boardId: payload.boardId, createdAt: at, startedAt: at },
      });
    } else if (!flow.startedAt) {
      await this.prisma.cardFlow.update({
        where: { cardId: payload.cardId },
        data: { startedAt: at },
      });
    }

    await this.prisma.cardColumnVisit.updateMany({
      where: { cardId: payload.cardId, leftAt: null },
      data: { leftAt: at },
    });
    await this.prisma.cardColumnVisit.create({
      data: { cardId: payload.cardId, columnId: payload.toColumnId, enteredAt: at },
    });
    return true;
  }

  private async cardClosed(payload: CardClosed): Promise<boolean> {
    const flow = await this.prisma.cardFlow.findUnique({ where: { cardId: payload.cardId } });
    if (!flow) return false;

    const closedAt = toDateTime(payload.closedAt) ?? new Date();
    await this.prisma.cardFlow.update({
      where: { cardId: payload.cardId },
      data: {
        closedAt,
        leadHours: hoursBetween(flow.createdAt, closedAt),
        cycleHours: flow.startedAt ? hoursBetween(flow.startedAt, closedAt) : null,
      },
    });
    await this.prisma.cardColumnVisit.updateMany({
      where: { cardId: payload.cardId, leftAt: null },
      data: { leftAt: closedAt },
    });
    return true;
  }

  // ── Согласования ──────────────────────────────────────────────────────

  private async requestCreated(payload: RequestCreated, occurredAt: string): Promise<boolean> {
    await this.prisma.approvalFact.upsert({
      where: { requestId: payload.requestId },
      create: {
        requestId: payload.requestId,
        type: payload.type,
        authorEmployeeId: payload.authorEmployeeId,
        createdAt: new Date(occurredAt),
      },
      update: {},
    });
    return true;
  }

  private async requestDecided(
    requestId: string,
    outcome: string,
    occurredAt: string,
  ): Promise<boolean> {
    const updated = await this.prisma.approvalFact.updateMany({
      // Условие на пустой исход делает операцию идемпотентной: повторная
      // доставка не сдвинет момент решения на время повтора.
      where: { requestId, outcome: null },
      data: { outcome, decidedAt: new Date(occurredAt) },
    });
    return updated.count > 0;
  }

  private async requestEscalated(payload: RequestEscalated): Promise<boolean> {
    const updated = await this.prisma.approvalFact.updateMany({
      where: { requestId: payload.requestId },
      data: { escalations: { increment: 1 } },
    });
    return updated.count > 0;
  }

  // ── Встречи ───────────────────────────────────────────────────────────

  private async callEnded(payload: CallEnded, occurredAt: string): Promise<boolean> {
    await this.prisma.callFact.upsert({
      where: { roomId: payload.roomId },
      create: {
        roomId: payload.roomId,
        durationSec: payload.durationSec,
        participants: payload.participantEmployeeIds ?? [],
        channelId: payload.channelId ?? null,
        endedAt: new Date(occurredAt),
      },
      update: {},
    });
    return true;
  }

  // ── Общее ─────────────────────────────────────────────────────────────

  /** Накопление минут за день. Разные события дополняют одну строку. */
  private async addTime(
    employeeId: string,
    dateString: string,
    delta: { normMinutes?: number; absenceMinutes?: number; overtimeMinutes?: number; absenceType?: string },
  ): Promise<void> {
    const date = toDate(dateString);
    if (!date) return;

    await this.prisma.timeFact.upsert({
      where: { employeeId_date: { employeeId, date } },
      create: {
        employeeId,
        date,
        normMinutes: delta.normMinutes ?? 0,
        absenceMinutes: delta.absenceMinutes ?? 0,
        overtimeMinutes: delta.overtimeMinutes ?? 0,
        absenceType: delta.absenceType ?? null,
      },
      update: {
        ...(delta.normMinutes ? { normMinutes: { increment: delta.normMinutes } } : {}),
        ...(delta.absenceMinutes ? { absenceMinutes: { increment: delta.absenceMinutes } } : {}),
        ...(delta.overtimeMinutes ? { overtimeMinutes: { increment: delta.overtimeMinutes } } : {}),
        ...(delta.absenceType ? { absenceType: delta.absenceType } : {}),
      },
    });
  }
}

/** Длительность смены. Ночная смена переходит через полночь. */
function shiftMinutes(start?: string, end?: string): number {
  const from = parseHhMm(start);
  const to = parseHhMm(end);
  if (from === null || to === null) return DEFAULT_WORKDAY_MINUTES;

  const minutes = to > from ? to - from : 24 * 60 - from + to;
  return minutes > 0 ? minutes : DEFAULT_WORKDAY_MINUTES;
}

function parseHhMm(value?: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value ?? '');
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function toDate(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateTime(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Список дат периода включительно. Ограничен годом — защита от опечатки. */
function datesBetween(from: string, to: string): string[] {
  const start = toDate(from);
  const end = toDate(to);
  if (!start || !end || end < start) return [];

  const result: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end && result.length < 366) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function hoursBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round(((to.getTime() - from.getTime()) / 3_600_000) * 100) / 100);
}
