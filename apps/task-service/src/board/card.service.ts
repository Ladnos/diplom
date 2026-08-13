import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import {
  TaskEvents,
  type CardAssigned,
  type CardClosed,
  type CardCommented,
  type CardCreated,
  type CardDeleted,
  type CardMoved,
  type RequestContext,
} from '@crm/contracts';
import { getRequestContext } from '@crm/common';
import { EventPublisher } from '@crm/messaging';
import type { Prisma } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { outboxRow } from '../prisma/outbox.store';
import { needsRebalance, positionForIndex, rebalance } from './position.util';

type CardWithLabels = Prisma.CardGetPayload<{ include: { labels: { include: { label: true } } } }>;

@Injectable()
export class CardService {
  private readonly logger = new Logger(CardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: EventPublisher,
  ) {}

  // ── Чтение ───────────────────────────────────────────────────────────

  /** Карточка с проверкой, что запрашивающий — участник её доски. */
  async getCardForActor(cardId: string, actorEmployeeId?: string): Promise<CardWithLabels> {
    const card = await this.getCard(cardId);
    if (actorEmployeeId) {
      const member = await this.prisma.boardMember.findUnique({
        where: { boardId_employeeId: { boardId: card.boardId, employeeId: actorEmployeeId } },
        select: { role: true },
      });
      if (!member) {
        throw new RpcException({
          code: GrpcStatus.PERMISSION_DENIED,
          message: 'вы не участник доски, которой принадлежит карточка',
        });
      }
    }
    return card;
  }

  async getCard(cardId: string): Promise<CardWithLabels> {
    const card = await this.prisma.card.findUnique({
      where: { id: cardId },
      include: { labels: { include: { label: true } } },
    });
    if (!card) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'карточка не найдена' });
    }
    return card;
  }

  async getCardsByAssignee(assigneeEmployeeId: string, onlyOpen: boolean, limit: number) {
    return this.prisma.card.findMany({
      where: { assigneeEmployeeId, ...(onlyOpen ? { closedAt: null } : {}) },
      include: { labels: { include: { label: true } } },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
      take: limit,
    });
  }

  /** Карточки, закрытые за период — основа акта для DELIVERABLE_BASED (§3.2). */
  async getClosedInPeriod(employeeIds: string[], from: Date, to: Date) {
    return this.prisma.card.findMany({
      where: {
        assigneeEmployeeId: { in: employeeIds },
        closedAt: { gte: from, lte: to },
      },
      orderBy: { closedAt: 'asc' },
      include: { labels: { include: { label: true } } },
    });
  }

  /** Загрузка команды: сколько открытых и просроченных задач у каждого. */
  async getTeamWorkload(employeeIds: string[]) {
    if (employeeIds.length === 0) return [];

    const today = new Date();
    const cards = await this.prisma.card.findMany({
      where: { assigneeEmployeeId: { in: employeeIds }, closedAt: null },
      select: { assigneeEmployeeId: true, dueDate: true, estimateMinutes: true },
    });

    const byEmployee = new Map<
      string,
      { openCards: number; overdueCards: number; estimateMinutes: number }
    >();
    for (const employeeId of employeeIds) {
      byEmployee.set(employeeId, { openCards: 0, overdueCards: 0, estimateMinutes: 0 });
    }

    for (const card of cards) {
      const bucket = byEmployee.get(card.assigneeEmployeeId ?? '');
      if (!bucket) continue;
      bucket.openCards += 1;
      bucket.estimateMinutes += card.estimateMinutes;
      if (card.dueDate && card.dueDate < today) bucket.overdueCards += 1;
    }

    return [...byEmployee.entries()].map(([employeeId, stats]) => ({ employeeId, ...stats }));
  }

  // ── Создание и правка ────────────────────────────────────────────────

  async createCard(
    input: {
      boardId: string;
      columnId: string;
      title: string;
      description?: string;
      authorEmployeeId: string;
      assigneeEmployeeId?: string;
      dueDate?: string;
      estimateMinutes?: number;
    },
    context: RequestContext = getRequestContext(),
  ) {
    const column = await this.prisma.column.findUnique({
      where: { id: input.columnId },
      select: { id: true, boardId: true, wipLimit: true, name: true },
    });
    if (!column || column.boardId !== input.boardId) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'колонка не принадлежит указанной доске',
      });
    }

    await this.assertWipLimit(column.id, column.wipLimit, column.name);

    const last = await this.prisma.card.findFirst({
      where: { columnId: input.columnId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });

    return this.prisma.$transaction(async (tx) => {
      const card = await tx.card.create({
        data: {
          boardId: input.boardId,
          columnId: input.columnId,
          title: input.title,
          description: input.description ?? null,
          authorEmployeeId: input.authorEmployeeId,
          assigneeEmployeeId: input.assigneeEmployeeId ?? null,
          position: positionForIndex(last ? [last.position] : [], last ? 1 : 0),
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
          estimateMinutes: input.estimateMinutes ?? 0,
        },
        include: { labels: { include: { label: true } } },
      });

      const envelope = this.publisher.wrap<CardCreated>(
        TaskEvents.CARD_CREATED,
        {
          cardId: card.id,
          boardId: card.boardId,
          columnId: card.columnId,
          title: card.title,
          authorEmployeeId: card.authorEmployeeId,
          assigneeEmployeeId: card.assigneeEmployeeId ?? undefined,
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      return card;
    });
  }

  async updateCard(input: {
    cardId: string;
    title?: string;
    description?: string;
    dueDate?: string | null;
    estimateMinutes?: number;
    labelIds?: string[];
    attachmentFileIds?: string[];
  }) {
    const data: Prisma.CardUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.dueDate !== undefined) {
      data.dueDate = input.dueDate ? new Date(input.dueDate) : null;
    }
    if (input.estimateMinutes !== undefined) data.estimateMinutes = input.estimateMinutes;
    // Карточка хранит только идентификаторы: сами файлы и счётчик ссылок
    // на них принадлежат file-service, и дублировать здесь размер или имя
    // значило бы завести вторую копию правды (§9.1).
    if (input.attachmentFileIds !== undefined) {
      data.attachmentFileIds = input.attachmentFileIds;
    }

    return this.prisma.$transaction(async (tx) => {
      if (input.labelIds) {
        await tx.cardLabel.deleteMany({ where: { cardId: input.cardId } });
        if (input.labelIds.length > 0) {
          await tx.cardLabel.createMany({
            data: input.labelIds.map((labelId) => ({ cardId: input.cardId, labelId })),
          });
        }
      }
      return tx.card.update({
        where: { id: input.cardId },
        data,
        include: { labels: { include: { label: true } } },
      });
    });
  }

  /**
   * Перемещение карточки — центральная операция Kanban.
   *
   * Три вещи, которые здесь легко сделать неправильно:
   *
   *  1. КОНКУРЕНТНОСТЬ. Двое перетащили одну карточку одновременно.
   *     Без проверки версии второй молча затрёт первого, и карточка
   *     окажется не там, куда её положил ни один из них. Обновление идёт
   *     через updateMany с условием на версию: ноль изменённых строк —
   *     значит, кто-то опередил.
   *
   *  2. WIP-ЛИМИТ. Смысл Kanban в ограничении незавершённой работы.
   *     Лимит проверяется только при смене колонки: перестановка внутри
   *     переполненной колонки не должна блокироваться.
   *
   *  3. ТОЧНОСТЬ ПОЗИЦИЙ. Дробные позиции рано или поздно сходятся.
   *     Перед вставкой проверяется зазор, и при необходимости колонка
   *     перенумеровывается.
   */
  async moveCard(
    input: {
      cardId: string;
      toColumnId: string;
      targetIndex: number;
      actorEmployeeId: string;
      expectedVersion?: number;
    },
    context: RequestContext = getRequestContext(),
  ) {
    const card = await this.getCard(input.cardId);

    if (input.expectedVersion !== undefined && input.expectedVersion !== card.version) {
      throw new RpcException({
        code: GrpcStatus.ABORTED,
        message:
          `карточку уже переместил другой участник (ожидалась версия ${input.expectedVersion}, ` +
          `текущая ${card.version}). Обновите доску`,
      });
    }

    const targetColumn = await this.prisma.column.findUnique({
      where: { id: input.toColumnId },
      select: { id: true, boardId: true, wipLimit: true, name: true, isDoneColumn: true },
    });
    if (!targetColumn || targetColumn.boardId !== card.boardId) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'целевая колонка не принадлежит той же доске',
      });
    }

    const changingColumn = targetColumn.id !== card.columnId;
    if (changingColumn) {
      await this.assertWipLimit(targetColumn.id, targetColumn.wipLimit, targetColumn.name);
    }

    const position = await this.resolvePosition(targetColumn.id, input.targetIndex, card.id);
    const fromColumnId = card.columnId;

    // Попадание в колонку завершения закрывает карточку и даёт точку
    // отсчёта для расчёта времени выполнения в аналитике.
    const closing = targetColumn.isDoneColumn && !card.closedAt;
    const reopening = !targetColumn.isDoneColumn && card.closedAt !== null;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.card.updateMany({
        where: { id: card.id, version: card.version },
        data: {
          columnId: targetColumn.id,
          position,
          version: { increment: 1 },
          ...(closing ? { closedAt: new Date() } : {}),
          ...(reopening ? { closedAt: null } : {}),
        },
      });

      if (updated.count === 0) {
        throw new RpcException({
          code: GrpcStatus.ABORTED,
          message: 'карточку изменили параллельно, повторите операцию',
        });
      }

      const moved = this.publisher.wrap<CardMoved>(
        TaskEvents.CARD_MOVED,
        {
          cardId: card.id,
          boardId: card.boardId,
          fromColumnId,
          toColumnId: targetColumn.id,
          actorEmployeeId: input.actorEmployeeId,
          version: card.version + 1,
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(moved) });

      if (closing) {
        const closed = this.publisher.wrap<CardClosed>(
          TaskEvents.CARD_CLOSED,
          {
            cardId: card.id,
            boardId: card.boardId,
            assigneeEmployeeId: card.assigneeEmployeeId ?? undefined,
            closedAt: new Date().toISOString(),
            estimateMinutes: card.estimateMinutes,
          },
          context,
        );
        await tx.outbox.create({ data: outboxRow(closed) });
      }

      return tx.card.findUniqueOrThrow({
        where: { id: card.id },
        include: { labels: { include: { label: true } } },
      });
    });
  }

  async assignCard(
    input: { cardId: string; assigneeEmployeeId: string | null; actorEmployeeId: string },
    context: RequestContext = getRequestContext(),
  ) {
    const card = await this.getCard(input.cardId);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.card.update({
        where: { id: card.id },
        data: { assigneeEmployeeId: input.assigneeEmployeeId, version: { increment: 1 } },
        include: { labels: { include: { label: true } } },
      });

      if (input.assigneeEmployeeId) {
        const envelope = this.publisher.wrap<CardAssigned>(
          TaskEvents.CARD_ASSIGNED,
          {
            cardId: card.id,
            boardId: card.boardId,
            assigneeEmployeeId: input.assigneeEmployeeId,
            actorEmployeeId: input.actorEmployeeId,
          },
          context,
        );
        await tx.outbox.create({ data: outboxRow(envelope) });
      }

      return updated;
    });
  }

  async deleteCard(cardId: string, context: RequestContext = getRequestContext()): Promise<void> {
    const card = await this.getCard(cardId);

    await this.prisma.$transaction(async (tx) => {
      await tx.card.delete({ where: { id: cardId } });

      // file-service уменьшит refcount вложений: сами файлы удалит
      // сборщик мусора, если на них больше никто не ссылается (§9.5).
      const envelope = this.publisher.wrap<CardDeleted>(
        TaskEvents.CARD_DELETED,
        {
          cardId: card.id,
          boardId: card.boardId,
          attachmentFileIds: card.attachmentFileIds,
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });
    });
  }

  // ── Комментарии ──────────────────────────────────────────────────────

  async addComment(
    input: { cardId: string; authorEmployeeId: string; body: string; mentions?: string[] },
    context: RequestContext = getRequestContext(),
  ) {
    const card = await this.getCard(input.cardId);
    const mentions = [...new Set(input.mentions ?? [])].filter(
      (id) => id !== input.authorEmployeeId,
    );

    return this.prisma.$transaction(async (tx) => {
      const comment = await tx.comment.create({
        data: {
          cardId: card.id,
          authorEmployeeId: input.authorEmployeeId,
          body: input.body,
          mentions,
        },
      });

      const envelope = this.publisher.wrap<CardCommented>(
        TaskEvents.CARD_COMMENTED,
        {
          cardId: card.id,
          boardId: card.boardId,
          commentId: comment.id,
          authorEmployeeId: input.authorEmployeeId,
          mentions,
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      return comment;
    });
  }

  async listComments(cardId: string) {
    return this.prisma.comment.findMany({
      where: { cardId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── Внутреннее ───────────────────────────────────────────────────────

  private async assertWipLimit(columnId: string, wipLimit: number, columnName: string) {
    if (wipLimit <= 0) return;

    const count = await this.prisma.card.count({ where: { columnId } });
    if (count >= wipLimit) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message:
          `в колонке «${columnName}» достигнут лимит незавершённой работы (${wipLimit}). ` +
          'Завершите начатое, прежде чем брать новое',
      });
    }
  }

  /**
   * Позиция для вставки на указанный индекс.
   * При исчерпании точности колонка перенумеровывается.
   */
  private async resolvePosition(
    columnId: string,
    targetIndex: number,
    excludeCardId: string,
  ): Promise<number> {
    const siblings = await this.prisma.card.findMany({
      where: { columnId, id: { not: excludeCardId } },
      orderBy: { position: 'asc' },
      select: { id: true, position: true },
    });

    const index = Math.max(0, Math.min(targetIndex, siblings.length));
    const before = index === 0 ? null : siblings[index - 1].position;
    const after = index >= siblings.length ? null : siblings[index].position;

    if (!needsRebalance(before, after)) {
      return positionForIndex(
        siblings.map((sibling) => sibling.position),
        index,
      );
    }

    // Соседи сошлись слишком близко: перенумеровываем колонку и считаем
    // позицию заново уже по новым значениям.
    this.logger.log({ message: 'перебалансировка позиций в колонке', columnId });
    const updates = rebalance(siblings);
    await this.prisma.$transaction(
      updates.map((update) =>
        this.prisma.card.update({
          where: { id: update.id },
          data: { position: update.position },
        }),
      ),
    );

    return positionForIndex(
      updates.map((update) => update.position),
      index,
    );
  }
}
