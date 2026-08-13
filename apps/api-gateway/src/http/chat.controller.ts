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
import { ChatClient, type ChannelDto, type MessageDto } from '../clients/chat.client';
import { FileClient, toPublicAttachment, type FileMetaDto } from '../clients/file.client';
import { VideoClient } from '../clients/video.client';
import { HrClient } from '../clients/hr.client';
import type { AuthenticatedUser } from '../auth/auth.guard';
import { CurrentUser, RequirePermission } from '../auth/permission.guard';
import {
  AddChannelMembersDto,
  CreateChannelDto,
  CreateDirectDto,
  EditMessageDto,
  HistoryQuery,
  MarkChannelReadDto,
  MessageSearchQuery,
  ReactionDto,
  SendMessageDto,
} from './dto';

/**
 * Переписка.
 *
 * Доступ к конкретному каналу определяется УЧАСТИЕМ, а не только ролью:
 * право `channel/read` говорит, что человек вообще пользуется чатом, а
 * список участников — что именно этим каналом. Второе проверяет
 * chat-service, которому передаётся идентификатор сотрудника из токена.
 *
 * Индикатора «печатает» здесь нет и быть не может: он идёт по WebSocket
 * в Redis Pub/Sub, минуя и этот контроллер, и chat-service. Сообщение
 * обязано дойти, «печатает» обязано потеряться (§5).
 */
@Controller('api/channels')
export class ChannelsController {
  constructor(
    private readonly chat: ChatClient,
    private readonly hr: HrClient,
    private readonly files: FileClient,
    private readonly video: VideoClient,
  ) {}

  @Get()
  @RequirePermission({ resource: 'channel', action: 'read' })
  async list(@CurrentUser() user: AuthenticatedUser) {
    const employeeId = requireEmployee(user);
    const [channels, counters] = await Promise.all([
      this.chat.listChannels(employeeId),
      this.chat.unreadCounters(employeeId),
    ]);

    const unread = new Map(counters.items.map((item) => [item.channel_id, item]));
    const names = await this.resolveNames(
      channels.channels.flatMap((channel) => channel.member_employee_ids),
    );

    return {
      channels: channels.channels.map((channel) => ({
        ...toPublicChannel(channel, names, employeeId),
        unread: unread.get(channel.channel_id)?.unread ?? 0,
        mentions: unread.get(channel.channel_id)?.mentions ?? 0,
      })),
      totalUnread: counters.total,
    };
  }

  @Get('unread-count')
  @RequirePermission({ resource: 'channel', action: 'read' })
  async unreadCount(@CurrentUser() user: AuthenticatedUser) {
    const counters = await this.chat.unreadCounters(requireEmployee(user));
    return {
      total: counters.total,
      channels: counters.items.map((item) => ({
        channelId: item.channel_id,
        unread: item.unread,
        mentions: item.mentions,
      })),
    };
  }

  @Post()
  @RequirePermission({ resource: 'channel', action: 'write' })
  async create(@Body() dto: CreateChannelDto, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = requireEmployee(user);
    const channel = await this.chat.createChannel({
      name: dto.name,
      type: dto.type,
      departmentId: dto.departmentId,
      creatorEmployeeId: employeeId,
      memberEmployeeIds: dto.memberEmployeeIds,
    });
    return toPublicChannel(channel, await this.resolveNames(channel.member_employee_ids), employeeId);
  }

  /**
   * Личная переписка с сотрудником.
   *
   * POST, а не GET, хотя чаще всего ничего не создаёт: у метода есть
   * побочный эффект при первом обращении, и кэшировать его нельзя.
   * Возвращает существующий канал, если он уже был, — для клиента разницы
   * нет, ему нужен идентификатор переписки.
   */
  @Post('direct')
  @RequirePermission({ resource: 'channel', action: 'write' })
  async direct(@Body() dto: CreateDirectDto, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = requireEmployee(user);
    const channel = await this.chat.getOrCreateDirect(employeeId, dto.employeeId);
    return toPublicChannel(channel, await this.resolveNames(channel.member_employee_ids), employeeId);
  }

  @Get(':id')
  @RequirePermission({ resource: 'channel', action: 'read' })
  async getOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = requireEmployee(user);
    const channel = await this.chat.getChannel(id, employeeId);
    return toPublicChannel(channel, await this.resolveNames(channel.member_employee_ids), employeeId);
  }

  @Get(':id/messages')
  @RequirePermission({ resource: 'channel', action: 'read' })
  async history(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: HistoryQuery,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const employeeId = requireEmployee(user);
    const result = await this.chat.getHistory({
      channelId: id,
      actorEmployeeId: employeeId,
      beforeSeq: query.beforeSeq,
      limit: query.limit,
      threadRootId: query.threadRootId,
    });

    // Имена авторов и метаданные вложений добираются двумя пакетными
    // вызовами на всю страницу, а не по вызову на сообщение: страница
    // истории — это полсотни записей, и поштучные запросы превратили бы
    // одну прокрутку в сотню round-trip'ов.
    const [names, attachments] = await Promise.all([
      this.resolveNames(result.messages.map((message) => message.author_employee_id)),
      this.files.metaByIds(result.messages.flatMap((message) => message.attachment_file_ids ?? [])),
    ]);

    return {
      messages: result.messages.map((message) => toPublicMessage(message, names, attachments)),
      nextCursor: result.page.next_cursor || null,
      hasMore: result.page.has_more,
    };
  }

  @Post(':id/messages')
  @RequirePermission({ resource: 'channel', action: 'write' })
  async send(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const employeeId = requireEmployee(user);
    const message = await this.chat.sendMessage({
      channelId: id,
      authorEmployeeId: employeeId,
      body: dto.body,
      threadRootId: dto.threadRootId,
      mentions: dto.mentions,
      attachmentFileIds: dto.attachmentFileIds,
      clientMessageId: dto.clientMessageId,
    });

    // Привязка вложений — ПОСЛЕ создания сообщения и здесь, а не в
    // chat-service. Идентификатор сообщения появляется только сейчас, а
    // возлагать вызов на чат значило бы завести обратную зависимость:
    // file-service уже спрашивает у чата, кому отдавать вложение (§9.3),
    // и встречный вызов замкнул бы пару сервисов друг на друга.
    const [names, attachments] = await Promise.all([
      this.resolveNames([message.author_employee_id]),
      this.files
        .attachAll(message.attachment_file_ids ?? [], 'CHAT_MESSAGE', message.message_id)
        .then(() => this.files.metaByIds(message.attachment_file_ids ?? [])),
    ]);

    return toPublicMessage(message, names, attachments);
  }

  @Post(':id/read')
  @HttpCode(200)
  @RequirePermission({ resource: 'channel', action: 'read' })
  async markRead(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkChannelReadDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const counters = await this.chat.markRead(id, requireEmployee(user), dto.upToSeq);
    return {
      total: counters.total,
      channels: counters.items.map((item) => ({
        channelId: item.channel_id,
        unread: item.unread,
        mentions: item.mentions,
      })),
    };
  }

  /**
   * Звонок из канала. docs/architecture.md §8.3
   *
   * Приглашаются все участники канала: звонок в переписке — это звонок
   * тем, с кем переписываешься, а выбирать из них подмножество означало
   * бы завести отдельный разговор внутри общего.
   *
   * channelId уходит в комнату, и по нему chat-service положит в
   * переписку системную запись о завершении — так через неделю по каналу
   * видно, что решение принимали голосом.
   */
  @Post(':id/call')
  @HttpCode(201)
  @RequirePermission({ resource: 'channel', action: 'write' })
  async startCall(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = requireEmployee(user);
    // Канал запрашивается с проверкой участия: звонок в чужую переписку
    // не должен начинаться даже при угаданном идентификаторе.
    const channel = await this.chat.getChannel(id, employeeId);

    const room = await this.video.createRoom({
      title: channel.name || 'Звонок',
      initiatorEmployeeId: employeeId,
      invitedEmployeeIds: channel.member_employee_ids.filter((item) => item !== employeeId),
      channelId: channel.channel_id,
    });
    const join = await this.video.issueJoinToken(room.room_id, employeeId);

    return {
      roomId: room.room_id,
      channelId: channel.channel_id,
      participants: room.participants.length,
      join: {
        token: join.token,
        signalingUrl: join.signaling_url,
        iceServers: join.ice_servers.map((server) => ({
          urls: server.urls,
          ...(server.username ? { username: server.username, credential: server.credential } : {}),
        })),
        expiresAt: new Date(Number(join.expires_at)).toISOString(),
      },
    };
  }

  @Post(':id/members')
  @RequirePermission({ resource: 'channel', action: 'write' })
  async addMembers(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddChannelMembersDto) {
    const channel = await this.chat.addMembers(id, dto.employeeIds);
    return { members: channel.member_employee_ids.length };
  }

  @Delete(':id/members/:employeeId')
  @HttpCode(200)
  @RequirePermission({ resource: 'channel', action: 'write' })
  async removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
  ) {
    await this.chat.removeMember(id, employeeId);
    return { removed: true };
  }

  /** ФИО подмешиваются одним батчевым вызовом; отказ hr не ломает выдачу. */
  private async resolveNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();

    return this.hr
      .getEmployeesBatch(unique)
      .then((result) => new Map(result.employees.map((e) => [e.employee_id, e.full_name])))
      .catch(() => new Map<string, string>());
  }
}

/**
 * Операции с отдельным сообщением.
 *
 * Вынесены в свой префикс: сообщение правится и удаляется по своему
 * идентификатору, канал сервис определит сам — клиенту не нужно его
 * помнить, чтобы убрать опечатку.
 */
@Controller('api/messages')
export class MessagesController {
  constructor(
    private readonly chat: ChatClient,
    private readonly hr: HrClient,
    private readonly files: FileClient,
  ) {}

  @Get('search')
  @RequirePermission({ resource: 'channel', action: 'read' })
  async search(@Query() query: MessageSearchQuery, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = requireEmployee(user);
    const result = await this.chat.search({
      employeeId,
      query: query.q,
      channelId: query.channelId,
      limit: query.limit,
      cursor: query.cursor,
    });

    const [names, attachments] = await Promise.all([
      this.resolveNames(result.messages.map((message) => message.author_employee_id)),
      this.files.metaByIds(result.messages.flatMap((message) => message.attachment_file_ids ?? [])),
    ]);

    return {
      messages: result.messages.map((message) => toPublicMessage(message, names, attachments)),
      nextCursor: result.page.next_cursor || null,
      hasMore: result.page.has_more,
    };
  }

  @Patch(':id')
  @RequirePermission({ resource: 'channel', action: 'write' })
  async edit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditMessageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const message = await this.chat.editMessage(id, requireEmployee(user), dto.body);
    return toPublicMessage(
      message,
      await this.resolveNames([message.author_employee_id]),
      await this.files.metaByIds(message.attachment_file_ids ?? []),
    );
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermission({ resource: 'channel', action: 'write' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.chat.deleteMessage(id, requireEmployee(user));
    return { deleted: true };
  }

  /** Повторная отправка той же реакции снимает её — отдельного метода нет. */
  @Post(':id/reactions')
  @HttpCode(200)
  @RequirePermission({ resource: 'channel', action: 'write' })
  async react(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReactionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const message = await this.chat.toggleReaction(id, requireEmployee(user), dto.emoji);
    return toPublicMessage(
      message,
      await this.resolveNames([message.author_employee_id]),
      await this.files.metaByIds(message.attachment_file_ids ?? []),
    );
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
    throw new BadRequestException('у учётной записи нет карточки сотрудника');
  }
  return user.employeeId;
}

/**
 * Имя личной переписки собирается для КАЖДОГО получателя отдельно.
 *
 * В базе оно пустое, и это верно: название «Иванов» осмысленно для
 * Петрова и бессмысленно для самого Иванова. Собрать его может только
 * тот, кто знает, кому отдаёт ответ, — то есть gateway.
 */
function toPublicChannel(
  channel: ChannelDto,
  names: Map<string, string>,
  viewerEmployeeId: string,
) {
  const isDirect = channel.type === 'DIRECT';
  const companion = isDirect
    ? channel.member_employee_ids.find((id) => id !== viewerEmployeeId)
    : undefined;

  return {
    channelId: channel.channel_id,
    name: isDirect ? (companion ? names.get(companion) ?? '' : '') : channel.name,
    type: channel.type,
    departmentId: channel.department_id || null,
    members: channel.member_employee_ids.map((id) => ({
      employeeId: id,
      fullName: names.get(id) ?? null,
    })),
    creatorEmployeeId: channel.creator_employee_id,
    lastMessageSeq: Number(channel.last_message_seq),
    createdAt: new Date(Number(channel.created_at)).toISOString(),
  };
}

function toPublicMessage(
  message: MessageDto,
  names: Map<string, string>,
  attachments: Map<string, FileMetaDto> = new Map(),
) {
  return {
    messageId: message.message_id,
    channelId: message.channel_id,
    // Пустой автор — системная запись: «звонок завершён, 42 мин».
    author: message.author_employee_id
      ? {
          employeeId: message.author_employee_id,
          fullName: names.get(message.author_employee_id) ?? null,
        }
      : null,
    body: message.body,
    threadRootId: message.thread_root_id || null,
    mentions: message.mentions,
    attachments: (message.attachment_file_ids ?? []).map((fileId) =>
      toPublicAttachment(fileId, attachments.get(fileId)),
    ),
    reactions: message.reactions.map((reaction) => ({
      emoji: reaction.emoji,
      employeeIds: reaction.employee_ids,
    })),
    // Number() обязателен: int64 из proto приезжает строкой, и без
    // приведения seq утекает в клиент как "42", ломая и сравнение
    // номеров, и курсор истории, который клиент вернёт обратно.
    seq: Number(message.seq),
    createdAt: new Date(Number(message.created_at)).toISOString(),
    editedAt: Number(message.edited_at)
      ? new Date(Number(message.edited_at)).toISOString()
      : null,
    deleted: message.deleted,
  };
}
