import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  TaskClient,
  type AvailabilityDto,
  type BoardDto,
  type CardDto,
  type ColumnDto,
} from '../clients/task.client';
import { HrClient } from '../clients/hr.client';
import { FileClient, toPublicAttachment, type FileMetaDto } from '../clients/file.client';
import type { AuthenticatedUser } from '../auth/auth.guard';
import { CurrentUser, RequirePermission } from '../auth/permission.guard';
import {
  AddCommentDto,
  AddMembersDto,
  AssignCardDto,
  AssigneeCardsQuery,
  CreateBoardDto,
  CreateCardDto,
  CreateColumnDto,
  CreateLabelDto,
  MoveCardDto,
  ReorderColumnsDto,
  UpdateCardDto,
  UpdateColumnDto,
} from './dto';

/**
 * Kanban-доски.
 *
 * Доступ к конкретной доске определяется УЧАСТИЕМ, а не только ролью:
 * право `board/read` говорит, что человек вообще работает с досками,
 * а список участников — что именно с этой. Второе проверяет task-service,
 * которому передаётся идентификатор сотрудника из токена.
 */
@Controller('api/boards')
export class BoardsController {
  constructor(
    private readonly tasks: TaskClient,
    private readonly hr: HrClient,
    private readonly files: FileClient,
  ) {}

  @Get()
  @RequirePermission({ resource: 'board', action: 'read' })
  async list(@CurrentUser() user: AuthenticatedUser) {
    const employeeId = requireEmployee(user);
    const result = await this.tasks.listBoards(employeeId);

    // Форма ответа совпадает с GET /api/boards/:id, только без карточек.
    // Возвращать здесь счётчики вместо списков означало бы, что поля
    // columns и members у двух соседних методов значат разное, и клиенту
    // пришлось бы держать два описания одной сущности.
    const names = await this.resolveNames(
      result.boards.flatMap((board) => (board.members ?? []).map((member) => member.employee_id)),
    );

    return { boards: result.boards.map((board) => toPublicBoard(board, names)) };
  }

  @Post()
  @RequirePermission({ resource: 'board', action: 'read' })
  async create(@Body() dto: CreateBoardDto, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = requireEmployee(user);
    const board = await this.tasks.createBoard({
      name: dto.name,
      departmentId: dto.departmentId,
      createdByEmployeeId: employeeId,
      memberEmployeeIds: dto.memberEmployeeIds,
    });
    return toPublicBoard(board, new Map());
  }

  /** Доска со всеми карточками — один запрос на отрисовку. */
  @Get(':id')
  @RequirePermission({ resource: 'board', action: 'read' })
  async getOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = requireEmployee(user);
    const view = await this.tasks.getBoard(id, employeeId);

    // Имена и метаданные вложений — по одному пакетному вызову на всю
    // доску: она отрисовывается целиком, и вызов на карточку превратил бы
    // открытие доски в десятки round-trip'ов.
    const [names, attachments] = await Promise.all([
      this.resolveNames([
        ...view.board.members.map((member) => member.employee_id),
        ...view.cards.map((card) => card.assignee_employee_id).filter(Boolean),
      ]),
      this.files.metaByIds(view.cards.flatMap((card) => card.attachment_file_ids ?? [])),
    ]);

    const availability = new Map(view.availability.map((item) => [item.employee_id, item]));

    return {
      ...toPublicBoard(view.board, names),
      cards: view.cards.map((card) => toPublicCard(card, names, availability, attachments)),
    };
  }

  @Get(':id/members')
  @RequirePermission({ resource: 'board', action: 'read' })
  async members(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = requireEmployee(user);
    const result = await this.tasks.getMembers(id, employeeId);
    const names = await this.resolveNames(result.members.map((member) => member.employee_id));
    return {
      members: result.members.map((member) => ({
        employeeId: member.employee_id,
        fullName: names.get(member.employee_id) ?? null,
        role: member.role,
      })),
    };
  }

  @Post(':id/members')
  @RequirePermission({ resource: 'card', action: 'write' })
  async addMembers(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddMembersDto) {
    const result = await this.tasks.addMembers(id, dto.employeeIds, dto.role);
    return { members: result.members.length };
  }

  @Delete(':id/members/:employeeId')
  @HttpCode(200)
  @RequirePermission({ resource: 'card', action: 'write' })
  async removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ) {
    await this.tasks.removeMember(id, employeeId);
    return { removed: true };
  }

  // ── Колонки ──────────────────────────────────────────────────────────

  @Post(':id/columns')
  @RequirePermission({ resource: 'card', action: 'write' })
  async createColumn(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateColumnDto) {
    const column = await this.tasks.createColumn({ boardId: id, ...dto });
    return toPublicColumn(column);
  }

  @Patch('columns/:columnId')
  @RequirePermission({ resource: 'card', action: 'write' })
  async updateColumn(
    @Param('columnId', ParseUUIDPipe) columnId: string,
    @Body() dto: UpdateColumnDto,
  ) {
    return toPublicColumn(await this.tasks.updateColumn({ columnId, ...dto }));
  }

  /** Карточки удалённой колонки переезжают в первую, а не пропадают. */
  @Delete('columns/:columnId')
  @HttpCode(200)
  @RequirePermission({ resource: 'card', action: 'write' })
  async deleteColumn(@Param('columnId', ParseUUIDPipe) columnId: string) {
    const result = await this.tasks.deleteColumn(columnId);
    return {
      deleted: true,
      movedCards: Number(result.value),
      message: 'карточки перенесены в первую колонку доски',
    };
  }

  @Post(':id/columns/reorder')
  @HttpCode(200)
  @RequirePermission({ resource: 'card', action: 'write' })
  async reorderColumns(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReorderColumnsDto) {
    const result = await this.tasks.reorderColumns(id, dto.orderedColumnIds);
    return { columns: result.columns.map(toPublicColumn) };
  }

  // ── Метки ────────────────────────────────────────────────────────────

  @Post(':id/labels')
  @RequirePermission({ resource: 'card', action: 'write' })
  async createLabel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateLabelDto) {
    const label = await this.tasks.createLabel(id, dto.name, dto.color);
    return { labelId: label.label_id, name: label.name, color: label.color };
  }

  @Delete('labels/:labelId')
  @HttpCode(200)
  @RequirePermission({ resource: 'card', action: 'write' })
  async deleteLabel(@Param('labelId', ParseUUIDPipe) labelId: string) {
    await this.tasks.deleteLabel(labelId);
    return { deleted: true };
  }

  // ── Карточки доски ───────────────────────────────────────────────────

  @Post(':id/cards')
  @RequirePermission({ resource: 'card', action: 'write' })
  async createCard(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCardDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const employeeId = requireEmployee(user);
    const card = await this.tasks.createCard({
      boardId: id,
      columnId: dto.columnId,
      title: dto.title,
      description: dto.description,
      authorEmployeeId: employeeId,
      assigneeEmployeeId: dto.assigneeEmployeeId,
      dueDate: dto.dueDate,
      estimateMinutes: dto.estimateMinutes,
    });
    return toPublicCard(card, new Map(), new Map());
  }

  private async resolveNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();
    // Отказ hr-service не должен ломать доску: она отрисуется без имён
    return this.hr
      .getEmployeesBatch(unique)
      .then((result) => new Map(result.employees.map((e) => [e.employee_id, e.full_name])))
      .catch(() => new Map<string, string>());
  }
}

/**
 * Операции с отдельной карточкой.
 *
 * Вынесены в свой префикс, чтобы клиенту не приходилось помнить доску:
 * карточка перетаскивается по своему идентификатору, а доску сервис
 * определит сам.
 */
@Controller('api/cards')
export class CardsController {
  constructor(
    private readonly tasks: TaskClient,
    private readonly hr: HrClient,
    private readonly files: FileClient,
  ) {}

  /** Мои задачи или задачи подчинённого. */
  @Get()
  @RequirePermission({ resource: 'card', action: 'write', ownerFrom: { query: 'employeeId' } })
  async listByAssignee(
    @Query() query: AssigneeCardsQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const employeeId = query.employeeId ?? requireEmployee(user);
    const result = await this.tasks.getCardsByAssignee(
      employeeId,
      query.onlyOpen ?? true,
      query.limit ?? 100,
    );
    return { cards: result.cards.map((card) => toPublicCard(card, new Map(), new Map())) };
  }

  @Get(':id')
  @RequirePermission({ resource: 'card', action: 'write' })
  async getOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = requireEmployee(user);
    const card = await this.tasks.getCard(id, employeeId);
    const [names, attachments] = await Promise.all([
      this.resolveNames([card.assignee_employee_id, card.author_employee_id]),
      this.files.metaByIds(card.attachment_file_ids ?? []),
    ]);
    return toPublicCard(card, names, new Map(), attachments);
  }

  @Patch(':id')
  @RequirePermission({ resource: 'card', action: 'write' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCardDto) {
    const before = dto.attachmentFileIds !== undefined ? await this.tasks.getCard(id, '') : null;
    const card = await this.tasks.updateCard({ cardId: id, ...dto });

    // Счётчик ссылок правится по РАЗНИЦЕ наборов: клиент присылает
    // список целиком, и слепая привязка всего перечисленного завысила бы
    // счётчик у файлов, которые и так были в карточке, а убранные
    // остались бы удерживать её вечно.
    if (before && dto.attachmentFileIds) {
      const was = new Set(before.attachment_file_ids ?? []);
      const now = new Set(dto.attachmentFileIds);
      await this.files.attachAll(
        [...now].filter((fileId) => !was.has(fileId)),
        'TASK_CARD',
        id,
      );
      for (const fileId of [...was].filter((item) => !now.has(item))) {
        await this.files.detach(fileId, 'TASK_CARD', id).catch(() => undefined);
      }
    }

    return toPublicCard(card, new Map(), new Map());
  }

  /**
   * Перетаскивание карточки.
   *
   * expectedVersion — то, что защищает от одновременного перетаскивания
   * одной карточки двумя людьми: несовпадение даёт 409, а не молчаливую
   * перезапись чужого действия.
   */
  @Post(':id/move')
  @HttpCode(200)
  @RequirePermission({ resource: 'card', action: 'write' })
  async move(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveCardDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const employeeId = requireEmployee(user);
    const card = await this.tasks.moveCard({
      cardId: id,
      toColumnId: dto.toColumnId,
      targetIndex: dto.targetIndex,
      actorEmployeeId: employeeId,
      expectedVersion: dto.expectedVersion,
    });
    return toPublicCard(card, new Map(), new Map());
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermission({ resource: 'card', action: 'write' })
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignCardDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const employeeId = requireEmployee(user);
    const card = await this.tasks.assignCard(id, dto.assigneeEmployeeId ?? null, employeeId);
    return toPublicCard(card, new Map(), new Map());
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermission({ resource: 'card', action: 'write' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = requireEmployee(user);
    await this.tasks.deleteCard(id, employeeId);
    return { deleted: true };
  }

  @Get(':id/comments')
  @RequirePermission({ resource: 'card', action: 'write' })
  async listComments(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const employeeId = requireEmployee(user);
    const result = await this.tasks.listComments(id, employeeId);
    const names = await this.resolveNames(
      result.comments.map((comment) => comment.author_employee_id),
    );
    return {
      comments: result.comments.map((comment) => ({
        commentId: comment.comment_id,
        author: {
          employeeId: comment.author_employee_id,
          fullName: names.get(comment.author_employee_id) ?? null,
        },
        body: comment.body,
        mentions: comment.mentions ?? [],
        createdAt: Number(comment.created_at),
      })),
    };
  }

  @Post(':id/comments')
  @RequirePermission({ resource: 'card', action: 'write' })
  async addComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddCommentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const employeeId = requireEmployee(user);
    const comment = await this.tasks.addComment({
      cardId: id,
      authorEmployeeId: employeeId,
      body: dto.body,
      mentions: dto.mentions,
    });
    return {
      commentId: comment.comment_id,
      createdAt: Number(comment.created_at),
      mentions: comment.mentions ?? [],
    };
  }

  private async resolveNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();
    return this.hr
      .getEmployeesBatch(unique)
      .then((result) => new Map(result.employees.map((e) => [e.employee_id, e.full_name])))
      .catch(() => new Map<string, string>());
  }
}

function requireEmployee(user: AuthenticatedUser): string {
  if (!user.employeeId) {
    throw new BadRequestException('профиль сотрудника ещё не создан; доски недоступны');
  }
  return user.employeeId;
}

function toPublicColumn(column: ColumnDto) {
  return {
    columnId: column.column_id,
    name: column.name,
    position: column.position,
    wipLimit: column.wip_limit || null,
    isDoneColumn: column.is_done_column,
    cardCount: column.card_count ?? 0,
    // Заполнение колонки: интерфейс подсвечивает приближение к лимиту
    wipReached: column.wip_limit > 0 && (column.card_count ?? 0) >= column.wip_limit,
  };
}

function toPublicBoard(board: BoardDto, names: Map<string, string>) {
  return {
    boardId: board.board_id,
    name: board.name,
    departmentId: board.department_id || null,
    columns: (board.columns ?? []).map(toPublicColumn),
    members: (board.members ?? []).map((member) => ({
      employeeId: member.employee_id,
      fullName: names.get(member.employee_id) ?? null,
      role: member.role,
    })),
    labels: (board.labels ?? []).map((label) => ({
      labelId: label.label_id,
      name: label.name,
      color: label.color,
    })),
  };
}

function toPublicCard(
  card: CardDto,
  names: Map<string, string>,
  availability: Map<string, AvailabilityDto>,
  attachments: Map<string, FileMetaDto> = new Map(),
) {
  const assigneeId = card.assignee_employee_id || null;
  const absence = assigneeId ? availability.get(assigneeId) : undefined;

  return {
    cardId: card.card_id,
    boardId: card.board_id,
    columnId: card.column_id,
    title: card.title,
    description: card.description || null,
    assignee: assigneeId
      ? {
          employeeId: assigneeId,
          fullName: names.get(assigneeId) ?? null,
          // Доска сразу показывает, что исполнителя не будет: назначать
          // задачу со сроком внутри отпуска бессмысленно
          absentUntil: absence?.absent_until || null,
          absenceType: absence?.absence_type || null,
        }
      : null,
    position: card.position,
    labels: (card.labels ?? []).map((label) => ({
      labelId: label.label_id,
      name: label.name,
      color: label.color,
    })),
    attachments: (card.attachment_file_ids ?? []).map((fileId) =>
      toPublicAttachment(fileId, attachments.get(fileId)),
    ),
    dueDate: card.due_date || null,
    estimateMinutes: card.estimate_minutes || 0,
    // Версию клиент обязан вернуть при перетаскивании — см. MoveCardDto
    version: Number(card.version),
    closedAt: Number(card.closed_at) || null,
    createdAt: Number(card.created_at),
  };
}
