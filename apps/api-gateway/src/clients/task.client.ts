import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { SERVICES } from '@crm/contracts';
import { DEADLINES_MS, grpcClientToken } from '@crm/grpc-clients';

export interface LabelDto {
  label_id: string;
  board_id: string;
  name: string;
  color: string;
}

export interface ColumnDto {
  column_id: string;
  board_id: string;
  name: string;
  position: number;
  wip_limit: number;
  is_done_column: boolean;
  card_count: number;
}

export interface BoardMemberDto {
  employee_id: string;
  role: string;
  added_at: number;
}

export interface BoardDto {
  board_id: string;
  name: string;
  department_id: string;
  created_by_employee_id: string;
  archived: boolean;
  columns: ColumnDto[];
  members: BoardMemberDto[];
  labels: LabelDto[];
  created_at: number;
}

export interface CardDto {
  card_id: string;
  board_id: string;
  column_id: string;
  title: string;
  description: string;
  author_employee_id: string;
  assignee_employee_id: string;
  position: number;
  labels: LabelDto[];
  attachment_file_ids: string[];
  due_date: string;
  estimate_minutes: number;
  version: number;
  created_at: number;
  closed_at: number;
}

export interface AvailabilityDto {
  employee_id: string;
  active: boolean;
  absent_until: string;
  absence_type: string;
}

export interface CommentDto {
  comment_id: string;
  card_id: string;
  author_employee_id: string;
  body: string;
  mentions: string[];
  created_at: number;
}

interface TaskGrpc {
  CreateBoard(data: Record<string, unknown>): Observable<BoardDto>;
  ListBoards(data: { employee_id: string }): Observable<{ boards: BoardDto[] }>;
  GetBoard(data: { board_id: string; actor_employee_id: string }): Observable<{
    board: BoardDto;
    cards: CardDto[];
    availability: AvailabilityDto[];
  }>;
  GetBoardMembers(data: {
    board_id: string;
    actor_employee_id: string;
  }): Observable<{ members: BoardMemberDto[] }>;
  AddMembers(data: {
    board_id: string;
    employee_ids: string[];
    role?: string;
  }): Observable<{ members: BoardMemberDto[] }>;
  RemoveMember(data: { board_id: string; employee_id: string }): Observable<object>;
  CreateColumn(data: Record<string, unknown>): Observable<ColumnDto>;
  UpdateColumn(data: Record<string, unknown>): Observable<ColumnDto>;
  DeleteColumn(data: { column_id: string }): Observable<{ value: number }>;
  ReorderColumns(data: {
    board_id: string;
    ordered_column_ids: string[];
  }): Observable<{ columns: ColumnDto[] }>;
  GetCard(data: { card_id: string; actor_employee_id: string }): Observable<CardDto>;
  CreateCard(data: Record<string, unknown>): Observable<CardDto>;
  UpdateCard(data: Record<string, unknown>): Observable<CardDto>;
  MoveCard(data: Record<string, unknown>): Observable<CardDto>;
  AssignCard(data: Record<string, unknown>): Observable<CardDto>;
  DeleteCard(data: { card_id: string; actor_employee_id: string }): Observable<object>;
  GetCardsByAssignee(data: {
    assignee_employee_id: string;
    only_open: boolean;
    limit: number;
  }): Observable<{ cards: CardDto[] }>;
  GetTeamWorkload(data: { employee_ids: string[] }): Observable<{
    items: {
      employee_id: string;
      open_cards: number;
      overdue_cards: number;
      estimate_minutes: number;
    }[];
  }>;
  AddComment(data: Record<string, unknown>): Observable<CommentDto>;
  ListComments(data: {
    card_id: string;
    actor_employee_id: string;
  }): Observable<{ comments: CommentDto[] }>;
  CreateLabel(data: { board_id: string; name: string; color?: string }): Observable<LabelDto>;
  DeleteLabel(data: { label_id: string }): Observable<object>;
}

@Injectable()
export class TaskClient implements OnModuleInit {
  private service!: TaskGrpc;

  constructor(@Inject(grpcClientToken(SERVICES.TASK)) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.service = this.client.getService<TaskGrpc>('TaskService');
  }

  // Тип параметра указан явно: без него TypeScript сужает его до литерала
  // значения по умолчанию, и передать REPORTING становится нельзя.
  private call<T>(source: Observable<T>, deadline: number = DEADLINES_MS.DEFAULT): Promise<T> {
    return firstValueFrom(source.pipe(timeout(deadline)));
  }

  createBoard(input: {
    name: string;
    departmentId?: string;
    createdByEmployeeId: string;
    memberEmployeeIds?: string[];
  }) {
    return this.call(
      this.service.CreateBoard({
        name: input.name,
        department_id: input.departmentId ?? '',
        created_by_employee_id: input.createdByEmployeeId,
        member_employee_ids: input.memberEmployeeIds ?? [],
      }),
    );
  }

  listBoards(employeeId: string) {
    return this.call(this.service.ListBoards({ employee_id: employeeId }));
  }

  /** Доска со всеми карточками — один вызов на отрисовку. */
  getBoard(boardId: string, actorEmployeeId: string) {
    return this.call(
      this.service.GetBoard({ board_id: boardId, actor_employee_id: actorEmployeeId }),
      DEADLINES_MS.REPORTING,
    );
  }

  getMembers(boardId: string, actorEmployeeId: string) {
    return this.call(
      this.service.GetBoardMembers({ board_id: boardId, actor_employee_id: actorEmployeeId }),
    );
  }

  addMembers(boardId: string, employeeIds: string[], role?: string) {
    return this.call(
      this.service.AddMembers({ board_id: boardId, employee_ids: employeeIds, role }),
    );
  }

  removeMember(boardId: string, employeeId: string) {
    return this.call(this.service.RemoveMember({ board_id: boardId, employee_id: employeeId }));
  }

  createColumn(input: {
    boardId: string;
    name: string;
    wipLimit?: number;
    isDoneColumn?: boolean;
    afterColumnId?: string;
  }) {
    return this.call(
      this.service.CreateColumn({
        board_id: input.boardId,
        name: input.name,
        wip_limit: input.wipLimit ?? 0,
        is_done_column: input.isDoneColumn ?? false,
        after_column_id: input.afterColumnId ?? '',
      }),
    );
  }

  updateColumn(input: {
    columnId: string;
    name?: string;
    wipLimit?: number;
    isDoneColumn?: boolean;
  }) {
    // Маска изменяемых полей: без неё proto3 не отличит «не задано»
    // от нуля, и любой вызов сбрасывал бы лимит и признак завершения.
    const mask: string[] = [];
    if (input.name !== undefined) mask.push('name');
    if (input.wipLimit !== undefined) mask.push('wip_limit');
    if (input.isDoneColumn !== undefined) mask.push('is_done_column');

    return this.call(
      this.service.UpdateColumn({
        column_id: input.columnId,
        name: input.name ?? '',
        wip_limit: input.wipLimit ?? 0,
        is_done_column: input.isDoneColumn ?? false,
        update_mask: mask,
      }),
    );
  }

  deleteColumn(columnId: string) {
    return this.call(this.service.DeleteColumn({ column_id: columnId }));
  }

  reorderColumns(boardId: string, orderedColumnIds: string[]) {
    return this.call(
      this.service.ReorderColumns({ board_id: boardId, ordered_column_ids: orderedColumnIds }),
    );
  }

  getCard(cardId: string, actorEmployeeId: string) {
    return this.call(
      this.service.GetCard({ card_id: cardId, actor_employee_id: actorEmployeeId }),
    );
  }

  createCard(input: {
    boardId: string;
    columnId: string;
    title: string;
    description?: string;
    authorEmployeeId: string;
    assigneeEmployeeId?: string;
    dueDate?: string;
    estimateMinutes?: number;
  }) {
    return this.call(
      this.service.CreateCard({
        board_id: input.boardId,
        column_id: input.columnId,
        title: input.title,
        description: input.description ?? '',
        author_employee_id: input.authorEmployeeId,
        assignee_employee_id: input.assigneeEmployeeId ?? '',
        due_date: input.dueDate ?? '',
        estimate_minutes: input.estimateMinutes ?? 0,
      }),
    );
  }

  updateCard(input: {
    cardId: string;
    title?: string;
    description?: string;
    dueDate?: string | null;
    estimateMinutes?: number;
    labelIds?: string[];
    attachmentFileIds?: string[];
  }) {
    const mask: string[] = [];
    if (input.title !== undefined) mask.push('title');
    if (input.description !== undefined) mask.push('description');
    if (input.dueDate !== undefined) mask.push('due_date');
    if (input.estimateMinutes !== undefined) mask.push('estimate_minutes');
    if (input.labelIds !== undefined) mask.push('label_ids');
    if (input.attachmentFileIds !== undefined) mask.push('attachment_file_ids');

    return this.call(
      this.service.UpdateCard({
        card_id: input.cardId,
        title: input.title ?? '',
        description: input.description ?? '',
        due_date: input.dueDate ?? '',
        estimate_minutes: input.estimateMinutes ?? 0,
        label_ids: input.labelIds ?? [],
        attachment_file_ids: input.attachmentFileIds ?? [],
        update_mask: mask,
      }),
    );
  }

  moveCard(input: {
    cardId: string;
    toColumnId: string;
    targetIndex: number;
    actorEmployeeId: string;
    expectedVersion?: number;
  }) {
    return this.call(
      this.service.MoveCard({
        card_id: input.cardId,
        to_column_id: input.toColumnId,
        target_index: input.targetIndex,
        actor_employee_id: input.actorEmployeeId,
        expected_version: input.expectedVersion ?? 0,
      }),
    );
  }

  assignCard(cardId: string, assigneeEmployeeId: string | null, actorEmployeeId: string) {
    return this.call(
      this.service.AssignCard({
        card_id: cardId,
        assignee_employee_id: assigneeEmployeeId ?? '',
        actor_employee_id: actorEmployeeId,
      }),
    );
  }

  deleteCard(cardId: string, actorEmployeeId: string) {
    return this.call(
      this.service.DeleteCard({ card_id: cardId, actor_employee_id: actorEmployeeId }),
    );
  }

  getCardsByAssignee(assigneeEmployeeId: string, onlyOpen: boolean, limit: number) {
    return this.call(
      this.service.GetCardsByAssignee({
        assignee_employee_id: assigneeEmployeeId,
        only_open: onlyOpen,
        limit,
      }),
      DEADLINES_MS.REPORTING,
    );
  }

  getTeamWorkload(employeeIds: string[]) {
    return this.call(
      this.service.GetTeamWorkload({ employee_ids: employeeIds }),
      DEADLINES_MS.REPORTING,
    );
  }

  addComment(input: {
    cardId: string;
    authorEmployeeId: string;
    body: string;
    mentions?: string[];
  }) {
    return this.call(
      this.service.AddComment({
        card_id: input.cardId,
        author_employee_id: input.authorEmployeeId,
        body: input.body,
        mentions: input.mentions ?? [],
      }),
    );
  }

  listComments(cardId: string, actorEmployeeId: string) {
    return this.call(
      this.service.ListComments({ card_id: cardId, actor_employee_id: actorEmployeeId }),
    );
  }

  createLabel(boardId: string, name: string, color?: string) {
    return this.call(this.service.CreateLabel({ board_id: boardId, name, color }));
  }

  deleteLabel(labelId: string) {
    return this.call(this.service.DeleteLabel({ label_id: labelId }));
  }
}
