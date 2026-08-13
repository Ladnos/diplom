import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type {
  BoardMember,
  BoardRole,
  Card,
  Column,
  Comment,
  EmployeeAvailability,
  Label,
  Prisma,
} from '../../generated/prisma';
import { BoardService } from './board.service';
import { CardService } from './card.service';

type CardWithLabels = Prisma.CardGetPayload<{ include: { labels: { include: { label: true } } } }>;

function toIsoDate(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : '';
}

function mapLabel(label: Label) {
  return { label_id: label.id, board_id: label.boardId, name: label.name, color: label.color };
}

function mapColumn(column: Column, cardCount = 0) {
  return {
    column_id: column.id,
    board_id: column.boardId,
    name: column.name,
    position: column.position,
    wip_limit: column.wipLimit,
    is_done_column: column.isDoneColumn,
    card_count: cardCount,
  };
}

function mapMember(member: BoardMember) {
  return {
    employee_id: member.employeeId,
    role: member.role,
    added_at: member.addedAt.getTime(),
  };
}

function mapCard(card: Card | CardWithLabels) {
  const labels = 'labels' in card && Array.isArray(card.labels) ? card.labels : [];
  return {
    card_id: card.id,
    board_id: card.boardId,
    column_id: card.columnId,
    title: card.title,
    description: card.description ?? '',
    author_employee_id: card.authorEmployeeId,
    assignee_employee_id: card.assigneeEmployeeId ?? '',
    position: card.position,
    labels: labels.map((item) => mapLabel(item.label)),
    attachment_file_ids: card.attachmentFileIds,
    due_date: toIsoDate(card.dueDate),
    estimate_minutes: card.estimateMinutes,
    version: card.version,
    created_at: card.createdAt.getTime(),
    closed_at: card.closedAt?.getTime() ?? 0,
  };
}

function mapComment(comment: Comment) {
  return {
    comment_id: comment.id,
    card_id: comment.cardId,
    author_employee_id: comment.authorEmployeeId,
    body: comment.body,
    mentions: comment.mentions,
    created_at: comment.createdAt.getTime(),
  };
}

function mapAvailability(item: EmployeeAvailability) {
  return {
    employee_id: item.employeeId,
    active: item.active,
    absent_until: toIsoDate(item.absentUntil),
    absence_type: item.absenceType ?? '',
  };
}

/** Изменяемые поля перечисляются явно: proto3 не отличает «не задано» от нуля. */
function inMask(mask: string[] | undefined, field: string): boolean {
  return Array.isArray(mask) && mask.includes(field);
}

/**
 * Роль из proto в роль домена.
 *
 * Незаданное значение приходит как BOARD_ROLE_UNSPECIFIED — нулевой
 * элемент перечисления proto3, которого в доменной модели нет и быть
 * не должно: «неопределённой» роли у участника доски не существует.
 */
const BOARD_ROLES: BoardRole[] = ['OWNER', 'MEMBER', 'VIEWER'];

function toBoardRole(value: string | undefined): BoardRole | undefined {
  return value && (BOARD_ROLES as string[]).includes(value) ? (value as BoardRole) : undefined;
}

/** gRPC-интерфейс task-service (libs/contracts/proto/task.proto). */
@Controller()
export class TaskGrpcController {
  constructor(
    private readonly boards: BoardService,
    private readonly cards: CardService,
  ) {}

  // ── Доски ────────────────────────────────────────────────────────────

  @GrpcMethod('TaskService', 'CreateBoard')
  async createBoard(data: {
    name: string;
    department_id?: string;
    created_by_employee_id: string;
    member_employee_ids?: string[];
  }) {
    const board = await this.boards.createBoard({
      name: data.name,
      departmentId: data.department_id || undefined,
      createdByEmployeeId: data.created_by_employee_id,
      memberEmployeeIds: data.member_employee_ids,
    });
    return {
      board_id: board.id,
      name: board.name,
      department_id: board.departmentId ?? '',
      created_by_employee_id: board.createdByEmployeeId,
      archived: board.archived,
      columns: board.columns.map((column) => mapColumn(column)),
      members: board.members.map(mapMember),
      labels: board.labels.map(mapLabel),
      created_at: board.createdAt.getTime(),
    };
  }

  @GrpcMethod('TaskService', 'ListBoards')
  async listBoards(data: { employee_id: string }) {
    const boards = await this.boards.listBoards(data.employee_id);
    return {
      boards: boards.map((board) => ({
        board_id: board.id,
        name: board.name,
        department_id: board.departmentId ?? '',
        created_by_employee_id: board.createdByEmployeeId,
        archived: board.archived,
        columns: board.columns.map((column) => mapColumn(column)),
        members: board.members.map(mapMember),
        labels: board.labels.map(mapLabel),
        created_at: board.createdAt.getTime(),
      })),
    };
  }

  /** Доска со всеми карточками — один запрос на отрисовку. */
  @GrpcMethod('TaskService', 'GetBoard')
  async getBoard(data: { board_id: string; actor_employee_id?: string }) {
    await this.boards.assertMember(data.board_id, data.actor_employee_id || undefined);
    const { board, cards, availability } = await this.boards.getBoardWithCards(data.board_id);

    const countByColumn = new Map<string, number>();
    for (const card of cards) {
      countByColumn.set(card.columnId, (countByColumn.get(card.columnId) ?? 0) + 1);
    }

    return {
      board: {
        board_id: board.id,
        name: board.name,
        department_id: board.departmentId ?? '',
        created_by_employee_id: board.createdByEmployeeId,
        archived: board.archived,
        columns: board.columns.map((column) =>
          mapColumn(column, countByColumn.get(column.id) ?? 0),
        ),
        members: board.members.map(mapMember),
        labels: board.labels.map(mapLabel),
        created_at: board.createdAt.getTime(),
      },
      cards: cards.map(mapCard),
      availability: availability.map(mapAvailability),
    };
  }

  @GrpcMethod('TaskService', 'GetBoardMembers')
  async getBoardMembers(data: { board_id: string; actor_employee_id?: string }) {
    await this.boards.assertMember(data.board_id, data.actor_employee_id || undefined);
    const members = await this.boards.getMembers(data.board_id);
    return { members: members.map(mapMember) };
  }

  @GrpcMethod('TaskService', 'AddMembers')
  async addMembers(data: { board_id: string; employee_ids: string[]; role?: string }) {
    const members = await this.boards.addMembers({
      boardId: data.board_id,
      employeeIds: data.employee_ids ?? [],
      role: toBoardRole(data.role),
    });
    return { members: members.map(mapMember) };
  }

  @GrpcMethod('TaskService', 'RemoveMember')
  async removeMember(data: { board_id: string; employee_id: string }) {
    await this.boards.removeMember(data.board_id, data.employee_id);
    return {};
  }

  // ── Колонки ──────────────────────────────────────────────────────────

  @GrpcMethod('TaskService', 'CreateColumn')
  async createColumn(data: {
    board_id: string;
    name: string;
    wip_limit?: number;
    is_done_column?: boolean;
    after_column_id?: string;
  }) {
    const column = await this.boards.createColumn({
      boardId: data.board_id,
      name: data.name,
      wipLimit: data.wip_limit,
      isDoneColumn: data.is_done_column,
      afterColumnId: data.after_column_id || undefined,
    });
    return mapColumn(column);
  }

  @GrpcMethod('TaskService', 'UpdateColumn')
  async updateColumn(data: {
    column_id: string;
    name?: string;
    wip_limit?: number;
    is_done_column?: boolean;
    update_mask?: string[];
  }) {
    const column = await this.boards.updateColumn({
      columnId: data.column_id,
      name: inMask(data.update_mask, 'name') ? data.name : undefined,
      wipLimit: inMask(data.update_mask, 'wip_limit') ? data.wip_limit : undefined,
      isDoneColumn: inMask(data.update_mask, 'is_done_column') ? data.is_done_column : undefined,
    });
    return mapColumn(column);
  }

  @GrpcMethod('TaskService', 'DeleteColumn')
  async deleteColumn(data: { column_id: string }) {
    const result = await this.boards.deleteColumn(data.column_id);
    return { value: result.movedCards };
  }

  @GrpcMethod('TaskService', 'ReorderColumns')
  async reorderColumns(data: { board_id: string; ordered_column_ids: string[] }) {
    const columns = await this.boards.reorderColumns(data.board_id, data.ordered_column_ids ?? []);
    return { columns: columns.map((column) => mapColumn(column)) };
  }

  // ── Карточки ─────────────────────────────────────────────────────────

  @GrpcMethod('TaskService', 'GetCard')
  async getCard(data: { card_id: string; actor_employee_id?: string }) {
    return mapCard(
      await this.cards.getCardForActor(data.card_id, data.actor_employee_id || undefined),
    );
  }

  @GrpcMethod('TaskService', 'CreateCard')
  async createCard(data: {
    board_id: string;
    column_id: string;
    title: string;
    description?: string;
    author_employee_id: string;
    assignee_employee_id?: string;
    due_date?: string;
    estimate_minutes?: number;
  }) {
    await this.boards.assertMember(data.board_id, data.author_employee_id);
    const card = await this.cards.createCard({
      boardId: data.board_id,
      columnId: data.column_id,
      title: data.title,
      description: data.description || undefined,
      authorEmployeeId: data.author_employee_id,
      assigneeEmployeeId: data.assignee_employee_id || undefined,
      dueDate: data.due_date || undefined,
      estimateMinutes: data.estimate_minutes,
    });
    return mapCard(card);
  }

  @GrpcMethod('TaskService', 'UpdateCard')
  async updateCard(data: {
    card_id: string;
    title?: string;
    description?: string;
    due_date?: string;
    estimate_minutes?: number;
    label_ids?: string[];
    attachment_file_ids?: string[];
    update_mask?: string[];
  }) {
    const card = await this.cards.updateCard({
      cardId: data.card_id,
      title: inMask(data.update_mask, 'title') ? data.title : undefined,
      description: inMask(data.update_mask, 'description') ? (data.description ?? '') : undefined,
      dueDate: inMask(data.update_mask, 'due_date') ? (data.due_date || null) : undefined,
      estimateMinutes: inMask(data.update_mask, 'estimate_minutes')
        ? data.estimate_minutes
        : undefined,
      labelIds: inMask(data.update_mask, 'label_ids') ? (data.label_ids ?? []) : undefined,
      attachmentFileIds: inMask(data.update_mask, 'attachment_file_ids')
        ? (data.attachment_file_ids ?? [])
        : undefined,
    });
    return mapCard(card);
  }

  @GrpcMethod('TaskService', 'MoveCard')
  async moveCard(data: {
    card_id: string;
    to_column_id: string;
    target_index?: number;
    actor_employee_id: string;
    expected_version?: number;
  }) {
    await this.cards.getCardForActor(data.card_id, data.actor_employee_id);
    const card = await this.cards.moveCard({
      cardId: data.card_id,
      toColumnId: data.to_column_id,
      targetIndex: data.target_index ?? 0,
      actorEmployeeId: data.actor_employee_id,
      // 0 означает «версию не проверять»: клиент, который её не прислал,
      // получает last-write-wins, а приславший — защиту от гонки.
      expectedVersion:
        data.expected_version && Number(data.expected_version) > 0
          ? Number(data.expected_version)
          : undefined,
    });
    return mapCard(card);
  }

  @GrpcMethod('TaskService', 'AssignCard')
  async assignCard(data: {
    card_id: string;
    assignee_employee_id?: string;
    actor_employee_id: string;
  }) {
    await this.cards.getCardForActor(data.card_id, data.actor_employee_id);
    const card = await this.cards.assignCard({
      cardId: data.card_id,
      assigneeEmployeeId: data.assignee_employee_id || null,
      actorEmployeeId: data.actor_employee_id,
    });
    return mapCard(card);
  }

  @GrpcMethod('TaskService', 'DeleteCard')
  async deleteCard(data: { card_id: string; actor_employee_id?: string }) {
    await this.cards.getCardForActor(data.card_id, data.actor_employee_id || undefined);
    await this.cards.deleteCard(data.card_id);
    return {};
  }

  @GrpcMethod('TaskService', 'GetCardsByAssignee')
  async getCardsByAssignee(data: {
    assignee_employee_id: string;
    only_open?: boolean;
    limit?: number;
  }) {
    const cards = await this.cards.getCardsByAssignee(
      data.assignee_employee_id,
      data.only_open ?? true,
      data.limit && data.limit > 0 ? Math.min(data.limit, 500) : 100,
    );
    return { cards: cards.map(mapCard) };
  }

  @GrpcMethod('TaskService', 'GetTeamWorkload')
  async getTeamWorkload(data: { employee_ids: string[] }) {
    const items = await this.cards.getTeamWorkload(data.employee_ids ?? []);
    return {
      items: items.map((item) => ({
        employee_id: item.employeeId,
        open_cards: item.openCards,
        overdue_cards: item.overdueCards,
        estimate_minutes: item.estimateMinutes,
      })),
    };
  }

  @GrpcMethod('TaskService', 'GetClosedInPeriod')
  async getClosedInPeriod(data: {
    employee_ids: string[];
    period: { from: string; to: string };
  }) {
    const cards = await this.cards.getClosedInPeriod(
      data.employee_ids ?? [],
      new Date(data.period.from),
      new Date(`${data.period.to}T23:59:59.999Z`),
    );
    return { cards: cards.map(mapCard) };
  }

  // ── Комментарии и метки ──────────────────────────────────────────────

  @GrpcMethod('TaskService', 'AddComment')
  async addComment(data: {
    card_id: string;
    author_employee_id: string;
    body: string;
    mentions?: string[];
  }) {
    await this.cards.getCardForActor(data.card_id, data.author_employee_id);
    const comment = await this.cards.addComment({
      cardId: data.card_id,
      authorEmployeeId: data.author_employee_id,
      body: data.body,
      mentions: data.mentions,
    });
    return mapComment(comment);
  }

  @GrpcMethod('TaskService', 'ListComments')
  async listComments(data: { card_id: string; actor_employee_id?: string }) {
    await this.cards.getCardForActor(data.card_id, data.actor_employee_id || undefined);
    const comments = await this.cards.listComments(data.card_id);
    return { comments: comments.map(mapComment) };
  }

  @GrpcMethod('TaskService', 'CreateLabel')
  async createLabel(data: { board_id: string; name: string; color?: string }) {
    const label = await this.boards.createLabel({
      boardId: data.board_id,
      name: data.name,
      color: data.color || undefined,
    });
    return mapLabel(label);
  }

  @GrpcMethod('TaskService', 'DeleteLabel')
  async deleteLabel(data: { label_id: string }) {
    await this.boards.deleteLabel(data.label_id);
    return {};
  }
}
