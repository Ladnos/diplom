import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { AnalyticsEvents, Commands, type ReportReady } from '@crm/contracts';
import { EventPublisher } from '@crm/messaging';
import { ExportStatus, type ExportTicket } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { outboxRow } from '../prisma/outbox.store';
import { ReportsService } from './reports.service';

/** Типы отчётов, которые умеет выгружать сервис. */
const REPORT_TYPES = new Set(['TIME_UTILIZATION', 'TASK_FLOW', 'APPROVALS', 'MEETINGS']);

/**
 * Выгрузки отчётов.
 *
 * Длинная операция вынесена из синхронного вызова намеренно: отчёт за
 * год по отделу считается секундами, а gRPC-дедлайн измеряется
 * миллисекундами. Клиент получает билет сразу, а сборка идёт по команде
 * `report.generate` через ту же очередь, что и всё остальное (§7.4).
 *
 * Это же делает выгрузку устойчивой: упавший на сборке процесс не теряет
 * запрос — команда вернётся в очередь.
 */
@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly publisher: EventPublisher,
  ) {}

  /**
   * Заказ выгрузки.
   *
   * Билет и команда пишутся одной транзакцией через outbox: иначе
   * падение между ними оставило бы билет, который никто никогда не
   * возьмёт в работу, — вечное «в очереди» без объяснений.
   */
  async request(input: {
    reportType: string;
    format: string;
    requestedByEmployeeId: string;
    from: string;
    to: string;
    paramsJson?: string;
  }): Promise<ExportTicket> {
    if (!REPORT_TYPES.has(input.reportType)) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: `неизвестный тип отчёта «${input.reportType}»`,
      });
    }
    // XLSX и PDF требуют библиотек вёрстки, а CSV — ничего. Отказ здесь
    // честнее, чем выдать CSV с расширением .xlsx: Excel такой файл
    // откроет, но при первом же сохранении пользователь получит вопрос,
    // на который не сможет ответить.
    if (input.format !== 'CSV' && input.format !== 'FORMAT_UNSPECIFIED') {
      throw new RpcException({
        code: GrpcStatus.UNIMPLEMENTED,
        message: `формат ${input.format} не поддержан: выгрузка доступна в CSV`,
      });
    }

    const period = parsePeriod(input.from, input.to);

    return this.prisma.$transaction(async (tx) => {
      const ticket = await tx.exportTicket.create({
        data: {
          reportType: input.reportType,
          format: 'CSV',
          requestedByEmployeeId: input.requestedByEmployeeId,
          periodFrom: period.from,
          periodTo: period.to,
          paramsJson: input.paramsJson ?? null,
        },
      });

      const envelope = this.publisher.wrap(
        Commands.REPORT_GENERATE as never,
        { ticketId: ticket.id },
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      return ticket;
    });
  }

  async get(ticketId: string): Promise<ExportTicket> {
    const ticket = await this.prisma.exportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'билет не найден' });
    }
    return ticket;
  }

  /**
   * Сборка отчёта по команде.
   *
   * Отметка RUNNING ставится условием на статус: повторная доставка
   * команды не должна запускать сборку второй раз параллельно первой.
   */
  async run(payload: { ticketId?: string }): Promise<void> {
    if (!payload?.ticketId) return;

    const claimed = await this.prisma.exportTicket.updateMany({
      where: { id: payload.ticketId, status: ExportStatus.QUEUED },
      data: { status: ExportStatus.RUNNING },
    });
    if (claimed.count === 0) return;

    const ticket = await this.prisma.exportTicket.findUnique({
      where: { id: payload.ticketId },
    });
    if (!ticket) return;

    try {
      const csv = await this.build(ticket);
      const filename = `${ticket.reportType.toLowerCase()}-${ticket.periodFrom
        .toISOString()
        .slice(0, 10)}.csv`;

      await this.prisma.$transaction(async (tx) => {
        await tx.exportTicket.update({
          where: { id: ticket.id },
          data: {
            status: ExportStatus.READY,
            content: csv,
            filename,
            readyAt: new Date(),
          },
        });

        const envelope = this.publisher.wrap<ReportReady>(AnalyticsEvents.REPORT_READY, {
          ticketId: ticket.id,
          reportType: ticket.reportType,
          requestedByEmployeeId: ticket.requestedByEmployeeId,
          // Файл лежит в билете, а не в file-service: см. комментарий к
          // модели ExportTicket. Поле оставлено пустым, а не заполнено
          // идентификатором, которого не существует.
          fileId: '',
        });
        await tx.outbox.create({ data: outboxRow(envelope) });
      });

      this.logger.log({ message: 'выгрузка готова', ticketId: ticket.id, bytes: csv.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.exportTicket.update({
        where: { id: ticket.id },
        data: { status: ExportStatus.FAILED, error: message.slice(0, 500) },
      });
      this.logger.error({ message: 'выгрузка не собралась', ticketId: ticket.id, error: message });
    }
  }

  /** Удаление устаревших выгрузок вместе с содержимым. */
  async prune(olderThanDays = 7): Promise<number> {
    const deadline = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const removed = await this.prisma.exportTicket.deleteMany({
      where: { createdAt: { lt: deadline } },
    });
    return removed.count;
  }

  private async build(ticket: ExportTicket): Promise<string> {
    const params = parseParams(ticket.paramsJson);
    const period = { from: ticket.periodFrom, to: ticket.periodTo };

    switch (ticket.reportType) {
      case 'TIME_UTILIZATION': {
        const team = await this.reports.teamMembers({
          managerEmployeeId: params.managerEmployeeId,
          departmentId: params.departmentId,
        });
        const report = await this.reports.timeUtilization(team, period);
        const names = await this.namesOf(report.rows.map((row) => row.employeeId));

        return toCsv(
          ['Сотрудник', 'Норма, мин', 'Отсутствия, мин', 'Переработки, мин', 'Итого, мин'],
          report.rows.map((row) => [
            names.get(row.employeeId) ?? row.employeeId,
            row.normMinutes,
            row.absenceMinutes,
            row.overtimeMinutes,
            row.totalMinutes,
          ]),
        );
      }

      case 'TASK_FLOW': {
        if (!params.boardId) throw new Error('в параметрах не указана доска');
        const report = await this.reports.taskFlow(params.boardId, period);

        return toCsv(
          ['Показатель', 'Значение'],
          [
            ['Среднее время от постановки до закрытия, ч', report.avgLeadTimeHours],
            ['Среднее время в работе, ч', report.avgCycleTimeHours],
            ['Создано карточек', report.createdCount],
            ['Закрыто карточек', report.closedCount],
            ...report.columnDurations.map((item) => [
              `Среднее время в колонке ${item.columnId}, ч`,
              item.avgHours,
            ]),
          ],
        );
      }

      case 'APPROVALS': {
        const team = await this.reports.teamMembers({
          managerEmployeeId: params.managerEmployeeId,
          departmentId: params.departmentId,
        });
        const report = await this.reports.approvalStats(team, period);

        return toCsv(
          ['Показатель', 'Значение'],
          [
            ['Создано заявок', report.created],
            ['Согласовано', report.approved],
            ['Отклонено', report.rejected],
            ['Просрочено', report.expired],
            ['Среднее время решения, ч', report.avgDecisionHours],
          ],
        );
      }

      case 'MEETINGS': {
        const team = await this.reports.teamMembers({
          managerEmployeeId: params.managerEmployeeId,
          departmentId: params.departmentId,
        });
        const report = await this.reports.meetingStats(team, period);

        return toCsv(
          ['Показатель', 'Значение'],
          [
            ['Звонков', report.callCount],
            ['Суммарная длительность, мин', Math.round(report.totalDurationSec / 60)],
            ['Среднее число участников', report.avgParticipants],
          ],
        );
      }

      default:
        throw new Error(`неизвестный тип отчёта «${ticket.reportType}»`);
    }
  }

  private async namesOf(employeeIds: string[]): Promise<Map<string, string>> {
    if (employeeIds.length === 0) return new Map();
    const refs = await this.prisma.employeeRef.findMany({
      where: { employeeId: { in: employeeIds } },
      select: { employeeId: true, fullName: true },
    });
    return new Map(refs.map((ref) => [ref.employeeId, ref.fullName]));
  }
}

function parsePeriod(from: string, to: string): { from: Date; to: Date } {
  const start = new Date(`${(from || '').slice(0, 10)}T00:00:00.000Z`);
  const end = new Date(`${(to || '').slice(0, 10)}T23:59:59.999Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    throw new RpcException({
      code: GrpcStatus.INVALID_ARGUMENT,
      message: 'некорректный период',
    });
  }
  return { from: start, to: end };
}

function parseParams(raw: string | null): {
  managerEmployeeId?: string;
  departmentId?: string;
  boardId?: string;
} {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * CSV с разделителем «точка с запятой» и BOM.
 *
 * И то и другое — уступка Excel в русской локали: с запятой он кладёт
 * всю строку в одну ячейку, без BOM показывает кириллицу кракозябрами.
 * Файл, который нельзя открыть двойным щелчком, выгрузкой не является.
 */
function toCsv(header: string[], rows: (string | number)[][]): string {
  const escape = (value: string | number): string => {
    const text = String(value);
    return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines = [header.map(escape).join(';')];
  for (const row of rows) lines.push(row.map(escape).join(';'));

  // Escape-последовательностью, а не самим символом: невидимый U+FEFF в
  // исходнике нельзя увидеть при чтении кода и легко потерять при
  // копировании строки — а без него Excel покажет кириллицу кракозябрами.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
