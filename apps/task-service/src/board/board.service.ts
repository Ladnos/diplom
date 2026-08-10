import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import {
  TaskEvents,
  type BoardCreated,
  type BoardMemberAdded,
  type RequestContext,
} from '@crm/contracts';
import { getRequestContext } from '@crm/common';
import { EventPublisher } from '@crm/messaging';
import type { BoardRole, Prisma } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { outboxRow } from '../prisma/outbox.store';
import { POSITION_STEP, positionBetween, rebalance } from './position.util';

/**
 * Колонки новой доски.
 *
 * Пустая доска бесполезна: пользователь вынужден придумывать структуру
 * до того, как понял, зачем она. Набор соответствует базовому потоку
 * Kanban, и его всегда можно перестроить.
 */
const DEFAULT_COLUMNS = [
  { name: 'К выполнению', wipLimit: 0, isDoneColumn: false },
  { name: 'В работе', wipLimit: 5, isDoneColumn: false },
  { name: 'На проверке', wipLimit: 3, isDoneColumn: false },
  { name: 'Готово', wipLimit: 0, isDoneColumn: true },
];

type BoardWithContent = Prisma.BoardGetPayload<{
  include: {
    columns: true;
    members: true;
    labels: true;
  };
}>;

@Injectable()
export class BoardService {
  private readonly logger = new Logger(BoardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: EventPublisher,
  ) {}

  async createBoard(
    input: {
      name: string;
      departmentId?: string;
      createdByEmployeeId: string;
      memberEmployeeIds?: string[];
    },
    context: RequestContext = getRequestContext(),
  ) {
    const members = new Set([input.createdByEmployeeId, ...(input.memberEmployeeIds ?? [])]);

    return this.prisma.$transaction(async (tx) => {
      const board = await tx.board.create({
        data: {
          name: input.name,
          departmentId: input.departmentId ?? null,
          createdByEmployeeId: input.createdByEmployeeId,
          columns: {
            create: DEFAULT_COLUMNS.map((column, index) => ({
              name: column.name,
              position: (index + 1) * POSITION_STEP,
              wipLimit: column.wipLimit,
              isDoneColumn: column.isDoneColumn,
            })),
          },
          members: {
            create: [...members].map((employeeId) => ({
              employeeId,
              role: employeeId === input.createdByEmployeeId ? 'OWNER' : ('MEMBER' as BoardRole),
            })),
          },
        },
        include: { columns: true, members: true, labels: true },
      });

      const envelope = this.publisher.wrap<BoardCreated>(
        TaskEvents.BOARD_CREATED,
        {
          boardId: board.id,
          name: board.name,
          departmentId: board.departmentId ?? undefined,
          createdByEmployeeId: input.createdByEmployeeId,
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      this.logger.log({ message: 'доска создана', boardId: board.id, members: members.size });
      return board;
    });
  }

  /** Доски, доступные сотруднику: где он участник. */
  async listBoards(employeeId: string) {
    return this.prisma.board.findMany({
      where: { archived: false, members: { some: { employeeId } } },
      include: { columns: { orderBy: { position: 'asc' } }, members: true, labels: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getBoard(boardId: string): Promise<BoardWithContent> {
    const board = await this.prisma.board.findUnique({
      where: { id: boardId },
      include: {
        columns: { orderBy: { position: 'asc' } },
        members: true,
        labels: true,
      },
    });
    if (!board) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'доска не найдена' });
    }
    return board;
  }

  /** Доска со всеми карточками — то, что отрисовывает интерфейс. */
  async getBoardWithCards(boardId: string) {
    const board = await this.getBoard(boardId);

    const cards = await this.prisma.card.findMany({
      where: { boardId },
      include: { labels: { include: { label: true } } },
      orderBy: [{ columnId: 'asc' }, { position: 'asc' }],
    });

    // Доступность исполнителей — из локальной проекции, без обращения
    // к кадровому сервису на каждую отрисовку доски.
    const assigneeIds = [
      ...new Set(cards.map((card) => card.assigneeEmployeeId).filter((id): id is string => !!id)),
    ];
    const availability = assigneeIds.length
      ? await this.prisma.employeeAvailability.findMany({
          where: { employeeId: { in: assigneeIds } },
        })
      : [];

    return { board, cards, availability };
  }

  async getMembers(boardId: string) {
    return this.prisma.boardMember.findMany({ where: { boardId } });
  }

  async addMembers(
    input: { boardId: string; employeeIds: string[]; role?: BoardRole },
    context: RequestContext = getRequestContext(),
  ) {
    await this.getBoard(input.boardId);

    return this.prisma.$transaction(async (tx) => {
      for (const employeeId of input.employeeIds) {
        await tx.boardMember.upsert({
          where: { boardId_employeeId: { boardId: input.boardId, employeeId } },
          create: { boardId: input.boardId, employeeId, role: input.role ?? 'MEMBER' },
          update: { role: input.role ?? 'MEMBER' },
        });

        const envelope = this.publisher.wrap<BoardMemberAdded>(
          TaskEvents.BOARD_MEMBER_ADDED,
          { boardId: input.boardId, employeeId, role: input.role ?? 'MEMBER' },
          context,
        );
        await tx.outbox.create({ data: outboxRow(envelope) });
      }

      return tx.boardMember.findMany({ where: { boardId: input.boardId } });
    });
  }

  async removeMember(boardId: string, employeeId: string) {
    await this.prisma.boardMember.deleteMany({ where: { boardId, employeeId } });
  }

  async isMember(boardId: string, employeeId: string): Promise<boolean> {
    const member = await this.prisma.boardMember.findUnique({
      where: { boardId_employeeId: { boardId, employeeId } },
      select: { role: true },
    });
    return member !== null;
  }

  /**
   * Доступ к доске определяется УЧАСТИЕМ, а не только ролью.
   *
   * Права в auth-service отвечают на вопрос «может ли этот человек
   * работать с досками вообще», а на вопрос «с этой конкретной доской»
   * — только список участников. Без проверки здесь любой сотрудник
   * прочитал бы чужую проектную доску, зная её идентификатор.
   *
   * actorEmployeeId пустой — вызов от другого сервиса (аналитика,
   * выгрузка акта), там доступ уже проверен на своём уровне.
   */
  async assertMember(boardId: string, actorEmployeeId?: string): Promise<void> {
    if (!actorEmployeeId) return;
    if (await this.isMember(boardId, actorEmployeeId)) return;

    throw new RpcException({
      code: GrpcStatus.PERMISSION_DENIED,
      message: 'вы не участник этой доски',
    });
  }

  // ── Колонки ──────────────────────────────────────────────────────────

  async createColumn(input: {
    boardId: string;
    name: string;
    wipLimit?: number;
    isDoneColumn?: boolean;
    afterColumnId?: string;
  }) {
    const columns = await this.prisma.column.findMany({
      where: { boardId: input.boardId },
      orderBy: { position: 'asc' },
      select: { id: true, position: true },
    });

    const index = input.afterColumnId
      ? columns.findIndex((column) => column.id === input.afterColumnId) + 1
      : columns.length;
    const before = index > 0 ? columns[index - 1]?.position ?? null : null;
    const after = index < columns.length ? columns[index]?.position ?? null : null;

    return this.prisma.column.create({
      data: {
        boardId: input.boardId,
        name: input.name,
        position: positionBetween(before, after),
        wipLimit: input.wipLimit ?? 0,
        isDoneColumn: input.isDoneColumn ?? false,
      },
    });
  }

  async updateColumn(input: {
    columnId: string;
    name?: string;
    wipLimit?: number;
    isDoneColumn?: boolean;
  }) {
    const data: Prisma.ColumnUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.wipLimit !== undefined) data.wipLimit = Math.max(0, input.wipLimit);
    if (input.isDoneColumn !== undefined) data.isDoneColumn = input.isDoneColumn;

    return this.prisma.column.update({ where: { id: input.columnId }, data });
  }

  /**
   * Удаление колонки.
   *
   * Карточки не пропадают вместе с ней: они переносятся в первую колонку
   * доски. Каскадное удаление здесь было бы потерей работы пользователя
   * из-за перестановки структуры.
   */
  async deleteColumn(columnId: string): Promise<{ movedCards: number }> {
    const column = await this.prisma.column.findUnique({
      where: { id: columnId },
      select: { id: true, boardId: true },
    });
    if (!column) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'колонка не найдена' });
    }

    const fallback = await this.prisma.column.findFirst({
      where: { boardId: column.boardId, id: { not: columnId } },
      orderBy: { position: 'asc' },
    });
    if (!fallback) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'нельзя удалить последнюю колонку доски',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const moved = await tx.card.updateMany({
        where: { columnId },
        data: { columnId: fallback.id },
      });
      await tx.column.delete({ where: { id: columnId } });
      return { movedCards: moved.count };
    });
  }

  /** Перестановка колонок. При исчерпании точности — перенумерация. */
  async reorderColumns(boardId: string, orderedColumnIds: string[]) {
    const updates = rebalance(orderedColumnIds.map((id) => ({ id })));
    await this.prisma.$transaction(
      updates.map((update) =>
        this.prisma.column.update({
          where: { id: update.id },
          data: { position: update.position },
        }),
      ),
    );
    return this.prisma.column.findMany({ where: { boardId }, orderBy: { position: 'asc' } });
  }

  // ── Метки ────────────────────────────────────────────────────────────

  async createLabel(input: { boardId: string; name: string; color?: string }) {
    return this.prisma.label.create({
      data: {
        boardId: input.boardId,
        name: input.name,
        color: input.color ?? '#6b7280',
      },
    });
  }

  async deleteLabel(labelId: string): Promise<void> {
    await this.prisma.label.delete({ where: { id: labelId } });
  }
}
