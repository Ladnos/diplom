import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import {
  ChatEvents,
  type MentionCreated,
  type MessageDeleted,
  type MessageEdited,
  type MessageSent,
  type ReactionAdded,
  type RequestContext,
} from '@crm/contracts';
import { getRequestContext } from '@crm/common';
import { EventPublisher } from '@crm/messaging';
import { ChannelType, MemberRole, Prisma, type Message } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { outboxRow } from '../prisma/outbox.store';
import { ChannelService, assertMemberOf, isUniqueViolation } from './channel.service';

/** Сколько текста уходит в событие: остальное потребитель дочитает сам. */
const PREVIEW_LIMIT = 200;
const BODY_LIMIT = 8_000;
const HISTORY_LIMIT = 50;

export type MessageWithReactions = Prisma.MessageGetPayload<{ include: { reactions: true } }>;

/**
 * Сообщения канала.
 *
 * Здесь живёт главное свойство чата — порядок. Каждое сообщение получает
 * монотонный номер seq внутри канала, и по нему строится всё остальное:
 * пагинация истории, курсор прочтения, обнаружение пропущенных пакетов на
 * клиенте (§8.2). Номер присваивается в транзакции инкрементом строки
 * канала, поэтому двое, отправившие одновременно, получают разные номера,
 * а не одинаковый.
 */
@Injectable()
export class MessageService {
  private readonly logger = new Logger(MessageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelService,
    private readonly publisher: EventPublisher,
  ) {}

  /**
   * Отправка сообщения.
   *
   * Сообщение и событие о нём пишутся ОДНОЙ транзакцией через outbox
   * (§7.7): иначе падение процесса между COMMIT и публикацией оставило бы
   * сообщение в базе, но не доставило бы его ни в одно открытое окно и не
   * породило бы push — то есть потерянным для всех, кроме отправителя.
   */
  async sendMessage(
    input: {
      channelId: string;
      authorEmployeeId: string;
      body: string;
      threadRootId?: string;
      mentions?: string[];
      attachmentFileIds?: string[];
      clientMessageId?: string;
    },
    context: RequestContext = getRequestContext(),
  ): Promise<MessageWithReactions> {
    const body = input.body.trim();
    if (body.length === 0 && (input.attachmentFileIds ?? []).length === 0) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'сообщение без текста и без вложений',
      });
    }
    if (body.length > BODY_LIMIT) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: `текст длиннее ${BODY_LIMIT} символов`,
      });
    }

    // Повтор проверяется ДО транзакции. Уникальный индекс поймал бы его и
    // сам, но ценой отката транзакции, внутри которой уже взята блокировка
    // строки канала и увеличен номер, — а повтор при плохой связи случается
    // не как исключение, а как норма. Заодно из журнала уходит поток
    // сообщений об ошибке уникального ключа, за которыми перестают
    // замечать настоящие. Индекс остаётся защитой от гонки двух запросов.
    if (input.clientMessageId) {
      const known = await this.prisma.message.findUnique({
        where: {
          channelId_clientMessageId: {
            channelId: input.channelId,
            clientMessageId: input.clientMessageId,
          },
        },
        include: { reactions: true },
      });
      if (known) return known;
    }

    const channel = await this.channels.getChannel(input.channelId);
    assertMemberOf(channel, input.authorEmployeeId);
    await this.assertMayWrite(channel, input.authorEmployeeId);

    // Ответ в ветку проверяется до транзакции: корень должен быть в этом
    // же канале, иначе ветка связала бы две переписки, и участник одной
    // увидел бы заголовок сообщения из другой.
    if (input.threadRootId) await this.assertThreadRoot(input.threadRootId, input.channelId);

    const memberIds = channel.members.map((member) => member.employeeId);
    // Упоминание того, кого нет в канале, уведомило бы человека о
    // переписке, которую он не может открыть. Отсекаем здесь, а не в
    // правиле уведомлений: канал знает свой состав, notification-service —
    // нет.
    const mentions = [...new Set(input.mentions ?? [])].filter(
      (id) => id !== input.authorEmployeeId && memberIds.includes(id),
    );

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Инкремент строки канала — он же и блокировка: следующий
        // отправитель дождётся коммита и получит номер на единицу больше.
        const updated = await tx.channel.update({
          where: { id: input.channelId },
          data: { lastMessageSeq: { increment: 1 } },
          select: { lastMessageSeq: true },
        });
        const seq = updated.lastMessageSeq;

        const message = await tx.message.create({
          data: {
            channelId: input.channelId,
            authorEmployeeId: input.authorEmployeeId,
            body,
            threadRootId: input.threadRootId ?? null,
            mentions,
            attachmentFileIds: input.attachmentFileIds ?? [],
            clientMessageId: input.clientMessageId || null,
            seq,
          },
          include: { reactions: true },
        });

        const sent = this.publisher.wrap<MessageSent>(
          ChatEvents.MESSAGE_SENT,
          {
            messageId: message.id,
            channelId: message.channelId,
            authorEmployeeId: input.authorEmployeeId,
            seq,
            preview: preview(body),
            threadRootId: message.threadRootId ?? undefined,
            recipientEmployeeIds: memberIds.filter((id) => id !== input.authorEmployeeId),
            hasAttachments: message.attachmentFileIds.length > 0,
          },
          context,
        );
        await tx.outbox.create({ data: outboxRow(sent) });

        // Упоминание — отдельное событие, а не флаг внутри message.sent:
        // у него другой получатель и другая срочность. Обычное сообщение
        // не догоняет push'ом того, кто сидит в системе, а упоминание
        // доставляется независимо от присутствия (§7.3).
        if (mentions.length > 0) {
          const mentioned = this.publisher.wrap<MentionCreated>(
            ChatEvents.MENTION_CREATED,
            {
              messageId: message.id,
              channelId: message.channelId,
              authorEmployeeId: input.authorEmployeeId,
              mentionedEmployeeIds: mentions,
            },
            context,
          );
          await tx.outbox.create({ data: outboxRow(mentioned) });
        }

        return message;
      });
    } catch (error) {
      // Повторная отправка после обрыва связи: клиент прислал тот же
      // clientMessageId. Возвращаем сохранённое, а не заводим второе —
      // с точки зрения пользователя сообщение отправлено один раз.
      if (isUniqueViolation(error) && input.clientMessageId) {
        const existing = await this.prisma.message.findUnique({
          where: {
            channelId_clientMessageId: {
              channelId: input.channelId,
              clientMessageId: input.clientMessageId,
            },
          },
          include: { reactions: true },
        });
        if (existing) {
          this.logger.debug({
            message: 'повторная отправка отброшена',
            messageId: existing.id,
            clientMessageId: input.clientMessageId,
          });
          return existing;
        }
      }
      throw error;
    }
  }

  /**
   * Системное сообщение — от сервиса, без автора.
   *
   * Отдельный путь, а не sendMessage с фиктивным отправителем: у системной
   * записи нет права писать, которое нужно проверять, нет упоминаний и
   * некому адресовать push. Номер seq она получает наравне с остальными —
   * иначе в нумерации возник бы разрыв, и клиент решил бы, что потерял
   * сообщение.
   */
  async postSystemMessage(
    input: { channelId: string; body: string; clientMessageId?: string },
    context: RequestContext = getRequestContext(),
  ): Promise<Message | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.channel.update({
          where: { id: input.channelId },
          data: { lastMessageSeq: { increment: 1 } },
          select: { lastMessageSeq: true },
        });

        const message = await tx.message.create({
          data: {
            channelId: input.channelId,
            body: input.body,
            system: true,
            seq: updated.lastMessageSeq,
            clientMessageId: input.clientMessageId || null,
          },
        });

        const members = await tx.channelMember.findMany({
          where: { channelId: input.channelId },
          select: { employeeId: true },
        });

        const sent = this.publisher.wrap<MessageSent>(
          ChatEvents.MESSAGE_SENT,
          {
            messageId: message.id,
            channelId: message.channelId,
            // Пустой автор — признак системного сообщения для потребителя.
            authorEmployeeId: '',
            seq: message.seq,
            preview: preview(input.body),
            recipientEmployeeIds: members.map((member) => member.employeeId),
            hasAttachments: false,
          },
          context,
        );
        await tx.outbox.create({ data: outboxRow(sent) });

        return message;
      });
    } catch (error) {
      if (isUniqueViolation(error) && input.clientMessageId) {
        // Повторная доставка события из брокера: сообщение уже записано.
        return null;
      }
      // Канал мог быть удалён вместе с исходным объектом — системная
      // запись не повод отвергать событие целиком.
      if (isMissingRecord(error)) {
        this.logger.warn({ message: 'канал системного сообщения не найден', channelId: input.channelId });
        return null;
      }
      throw error;
    }
  }

  async editMessage(
    input: { messageId: string; authorEmployeeId: string; body: string },
    context: RequestContext = getRequestContext(),
  ): Promise<MessageWithReactions> {
    const message = await this.getMessage(input.messageId);
    if (message.system || message.authorEmployeeId !== input.authorEmployeeId) {
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: 'править можно только собственное сообщение',
      });
    }
    if (message.deleted) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'сообщение удалено',
      });
    }

    const body = input.body.trim();
    if (body.length === 0 || body.length > BODY_LIMIT) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'недопустимая длина текста',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.message.update({
        where: { id: input.messageId },
        data: { body, editedAt: new Date() },
        include: { reactions: true },
      });

      // seq не меняется: правка не создаёт нового места в ленте, она
      // обновляет то же самое. Потребитель по seq находит, что обновить.
      const envelope = this.publisher.wrap<MessageEdited>(
        ChatEvents.MESSAGE_EDITED,
        { messageId: updated.id, channelId: updated.channelId, seq: updated.seq },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      return updated;
    });
  }

  /**
   * Удаление — пометка, а не удаление строки.
   *
   * Строка держит номер seq, на неё ссылаются ответы в ветке, и физическое
   * удаление порвало бы и нумерацию, и ветки. Текст при этом стирается:
   * «удалить» должно означать, что содержимого больше нет, а не что его
   * просто не показывают.
   */
  async deleteMessage(
    input: { messageId: string; actorEmployeeId: string },
    context: RequestContext = getRequestContext(),
  ): Promise<void> {
    const message = await this.getMessage(input.messageId);
    if (message.deleted) return;

    const channel = await this.channels.getChannel(message.channelId);
    const actor = channel.members.find(
      (member) => member.employeeId === input.actorEmployeeId,
    );
    const isAuthor = !message.system && message.authorEmployeeId === input.actorEmployeeId;
    // Владелец канала убирает чужое сообщение — это модерация, а не
    // подмена авторства: текст исчезает, но факт удаления виден всем.
    if (!isAuthor && actor?.role !== MemberRole.OWNER) {
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: 'удалить может автор или владелец канала',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.message.update({
        where: { id: input.messageId },
        data: { deleted: true, body: '', mentions: [], attachmentFileIds: [] },
      });
      await tx.reaction.deleteMany({ where: { messageId: input.messageId } });

      // Вложения перечисляются в событии: file-service уменьшит счётчик
      // ссылок, а сами файлы уберёт сборщик мусора, если на них больше
      // никто не ссылается (§9.5).
      const envelope = this.publisher.wrap<MessageDeleted>(
        ChatEvents.MESSAGE_DELETED,
        {
          messageId: message.id,
          channelId: message.channelId,
          seq: message.seq,
          attachmentFileIds: message.attachmentFileIds,
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });
    });
  }

  /** Повторное нажатие снимает реакцию: отдельного метода для этого нет. */
  async toggleReaction(
    input: { messageId: string; employeeId: string; emoji: string },
    context: RequestContext = getRequestContext(),
  ): Promise<MessageWithReactions> {
    const message = await this.getMessage(input.messageId);
    if (message.deleted) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'сообщение удалено',
      });
    }

    const channel = await this.channels.getChannel(message.channelId);
    assertMemberOf(channel, input.employeeId);

    const key = {
      messageId_employeeId_emoji: {
        messageId: input.messageId,
        employeeId: input.employeeId,
        emoji: input.emoji,
      },
    };
    const existing = await this.prisma.reaction.findUnique({ where: key });

    if (existing) {
      await this.prisma.reaction.delete({ where: key });
      // События о снятии нет: подписчиков интересует появление реакции,
      // а актуальный набор приходит вместе с сообщением в ответе.
      return this.getMessage(input.messageId);
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.reaction.create({
        data: {
          messageId: input.messageId,
          employeeId: input.employeeId,
          emoji: input.emoji,
        },
      });

      const envelope = this.publisher.wrap<ReactionAdded>(
        ChatEvents.REACTION_ADDED,
        {
          messageId: message.id,
          channelId: message.channelId,
          employeeId: input.employeeId,
          emoji: input.emoji,
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      return tx.message.findUniqueOrThrow({
        where: { id: input.messageId },
        include: { reactions: true },
      });
    });
  }

  /**
   * История канала — курсором по seq, а не по смещению.
   *
   * Лента постоянно пополняется сверху, и OFFSET 50 после трёх новых
   * сообщений показал бы часть предыдущей страницы второй раз. Курсором
   * служит номер, по нему же построен уникальный индекс.
   */
  async getHistory(input: {
    channelId: string;
    actorEmployeeId: string;
    beforeSeq?: number;
    limit?: number;
    threadRootId?: string;
  }): Promise<{ messages: MessageWithReactions[]; nextCursor: string; hasMore: boolean }> {
    await this.channels.assertMember(input.channelId, input.actorEmployeeId);

    const limit = Math.min(Math.max(input.limit ?? HISTORY_LIMIT, 1), 100);
    const messages = await this.prisma.message.findMany({
      where: {
        channelId: input.channelId,
        ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
        ...(input.beforeSeq && input.beforeSeq > 0 ? { seq: { lt: input.beforeSeq } } : {}),
      },
      include: { reactions: true },
      orderBy: { seq: 'desc' },
      // На одну больше запрошенного: «есть ли ещё» узнаётся из той же
      // выборки, без отдельного count по всему каналу.
      take: limit + 1,
    });

    const hasMore = messages.length > limit;
    const page = hasMore ? messages.slice(0, limit) : messages;
    return {
      messages: page,
      nextCursor: hasMore ? String(page[page.length - 1].seq) : '',
      hasMore,
    };
  }

  /**
   * Поиск по своим каналам.
   *
   * Область поиска ограничена участием: искать по всей таблице сообщений
   * означало бы отдавать совпадения из переписок, которые человеку
   * недоступны, — по одному только факту совпадения о чужом разговоре уже
   * можно узнать больше, чем следует.
   *
   * Поиск подстрокой, а не полнотекстовый. При нынешних объёмах разница
   * незаметна, а полнотекстовый потребовал бы колонки tsvector, GIN-индекса
   * и решения о языке разбора — на пустой базе это выбор вслепую. Условие
   * для перехода понятное: как только выборка перестанет укладываться в
   * индекс по каналу и времени.
   */
  async search(input: {
    employeeId: string;
    query: string;
    channelId?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ messages: MessageWithReactions[]; nextCursor: string; hasMore: boolean }> {
    const query = input.query.trim();
    if (query.length < 2) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'запрос короче двух символов',
      });
    }

    const memberships = await this.prisma.channelMember.findMany({
      where: {
        employeeId: input.employeeId,
        ...(input.channelId ? { channelId: input.channelId } : {}),
      },
      select: { channelId: true },
    });
    if (memberships.length === 0) {
      return { messages: [], nextCursor: '', hasMore: false };
    }

    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const before = input.cursor ? new Date(Number(input.cursor)) : undefined;

    const messages = await this.prisma.message.findMany({
      where: {
        channelId: { in: memberships.map((item) => item.channelId) },
        deleted: false,
        body: { contains: query, mode: 'insensitive' },
        ...(before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}),
      },
      include: { reactions: true },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = messages.length > limit;
    const page = hasMore ? messages.slice(0, limit) : messages;
    return {
      messages: page,
      nextCursor: hasMore ? String(page[page.length - 1].createdAt.getTime()) : '',
      hasMore,
    };
  }

  private async getMessage(messageId: string): Promise<MessageWithReactions> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { reactions: true },
    });
    if (!message) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'сообщение не найдено' });
    }
    return message;
  }

  private async assertThreadRoot(threadRootId: string, channelId: string): Promise<void> {
    const root = await this.prisma.message.findUnique({
      where: { id: threadRootId },
      select: { channelId: true, threadRootId: true },
    });
    if (!root || root.channelId !== channelId) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'корень ветки не принадлежит этому каналу',
      });
    }
    if (root.threadRootId) {
      // Ветки одноуровневые: ответ на ответ приклеивается к тому же корню.
      // Дерево произвольной глубины пришлось бы разворачивать рекурсивно
      // при каждой отрисовке ради случая, который в переписке почти не
      // встречается.
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'ветка не может начинаться от ответа',
      });
    }
  }

  /**
   * Право писать в канал.
   *
   * Отличается только у канала объявлений: читают все, пишет руководитель
   * (ADR-3). Руководитель определяется по проекции — тот, у кого есть
   * подчинённые. Владелец канала допускается наравне с ним: объявления
   * заводят под конкретную аудиторию, и создатель отвечает за канал, даже
   * если подчинённых у него нет.
   */
  private async assertMayWrite(
    channel: { id: string; type: ChannelType; members: { employeeId: string; role: MemberRole }[] },
    employeeId: string,
  ): Promise<void> {
    if (channel.type !== ChannelType.ANNOUNCEMENT) return;

    const member = channel.members.find((item) => item.employeeId === employeeId);
    if (member?.role === MemberRole.OWNER) return;

    const subordinates = await this.prisma.employeeRef.count({
      where: { managerEmployeeId: employeeId, active: true },
    });
    if (subordinates > 0) return;

    throw new RpcException({
      code: GrpcStatus.PERMISSION_DENIED,
      message: 'в канал объявлений пишет руководитель',
    });
  }
}

function preview(body: string): string {
  return body.length > PREVIEW_LIMIT ? `${body.slice(0, PREVIEW_LIMIT - 1)}…` : body;
}

/** P2025 — операция не нашла строку. */
function isMissingRecord(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}
