import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { ChannelType, type Reaction } from '../../generated/prisma';
import { ChannelService, type ChannelWithMembers } from './channel.service';
import { MessageService, type MessageWithReactions } from './message.service';
import { ReadCursorService } from './read-cursor.service';

/**
 * gRPC-фасад chat-service.
 *
 * Здесь только перевод между формой контракта (snake_case, int64 числами,
 * пустая строка вместо null) и доменными сервисами. Никаких правил:
 * попав сюда, они разошлись бы с теми же правилами, применяемыми при
 * обработке событий.
 */
@Controller()
export class ChatGrpcController {
  constructor(
    private readonly channels: ChannelService,
    private readonly messages: MessageService,
    private readonly cursors: ReadCursorService,
  ) {}

  // ── Каналы ────────────────────────────────────────────────────────────

  @GrpcMethod('ChatService', 'CreateChannel')
  async createChannel(data: {
    name: string;
    type: string;
    department_id?: string;
    member_employee_ids?: string[];
    creator_employee_id: string;
  }) {
    const channel = await this.channels.createChannel({
      name: data.name,
      type: toChannelType(data.type),
      departmentId: data.department_id || undefined,
      creatorEmployeeId: data.creator_employee_id,
      memberEmployeeIds: data.member_employee_ids ?? [],
    });
    return mapChannel(channel);
  }

  @GrpcMethod('ChatService', 'ListChannels')
  async listChannels(data: { employee_id: string }) {
    const channels = await this.channels.listChannels(data.employee_id);
    return { channels: channels.map(mapChannel) };
  }

  @GrpcMethod('ChatService', 'GetChannel')
  async getChannel(data: { channel_id: string; actor_employee_id?: string }) {
    const channel = await this.channels.getChannel(
      data.channel_id,
      data.actor_employee_id || undefined,
    );
    return mapChannel(channel);
  }

  @GrpcMethod('ChatService', 'GetOrCreateDirect')
  async getOrCreateDirect(data: { employee_id_a: string; employee_id_b: string }) {
    const channel = await this.channels.getOrCreateDirect(
      data.employee_id_a,
      data.employee_id_b,
    );
    return mapChannel(channel);
  }

  @GrpcMethod('ChatService', 'AddMembers')
  async addMembers(data: { channel_id: string; employee_ids: string[] }) {
    const channel = await this.channels.addMembers(data.channel_id, data.employee_ids ?? []);
    return mapChannel(channel);
  }

  @GrpcMethod('ChatService', 'RemoveMember')
  async removeMember(data: { channel_id: string; employee_id: string }) {
    const channel = await this.channels.removeMember(data.channel_id, data.employee_id);
    return mapChannel(channel);
  }

  // ── Сообщения ─────────────────────────────────────────────────────────

  @GrpcMethod('ChatService', 'GetHistory')
  async getHistory(data: {
    channel_id: string;
    actor_employee_id: string;
    before_seq?: string | number;
    limit?: number;
    thread_root_id?: string;
  }) {
    const result = await this.messages.getHistory({
      channelId: data.channel_id,
      actorEmployeeId: data.actor_employee_id,
      beforeSeq: Number(data.before_seq ?? 0),
      limit: data.limit,
      threadRootId: data.thread_root_id || undefined,
    });
    return {
      messages: result.messages.map(mapMessage),
      page: { next_cursor: result.nextCursor, has_more: result.hasMore },
    };
  }

  @GrpcMethod('ChatService', 'SendMessage')
  async sendMessage(data: {
    channel_id: string;
    author_employee_id: string;
    body: string;
    thread_root_id?: string;
    mentions?: string[];
    attachment_file_ids?: string[];
    client_message_id?: string;
  }) {
    const message = await this.messages.sendMessage({
      channelId: data.channel_id,
      authorEmployeeId: data.author_employee_id,
      body: data.body,
      threadRootId: data.thread_root_id || undefined,
      mentions: data.mentions ?? [],
      attachmentFileIds: data.attachment_file_ids ?? [],
      clientMessageId: data.client_message_id || undefined,
    });
    return mapMessage(message);
  }

  @GrpcMethod('ChatService', 'EditMessage')
  async editMessage(data: { message_id: string; author_employee_id: string; body: string }) {
    const message = await this.messages.editMessage({
      messageId: data.message_id,
      authorEmployeeId: data.author_employee_id,
      body: data.body,
    });
    return mapMessage(message);
  }

  @GrpcMethod('ChatService', 'DeleteMessage')
  async deleteMessage(data: { message_id: string; actor_employee_id: string }) {
    await this.messages.deleteMessage({
      messageId: data.message_id,
      actorEmployeeId: data.actor_employee_id,
    });
    return {};
  }

  @GrpcMethod('ChatService', 'AddReaction')
  async addReaction(data: { message_id: string; employee_id: string; emoji: string }) {
    const message = await this.messages.toggleReaction({
      messageId: data.message_id,
      employeeId: data.employee_id,
      emoji: data.emoji,
    });
    return mapMessage(message);
  }

  @GrpcMethod('ChatService', 'SearchMessages')
  async searchMessages(data: {
    employee_id: string;
    query: string;
    channel_id?: string;
    page?: { limit?: number; cursor?: string };
  }) {
    const result = await this.messages.search({
      employeeId: data.employee_id,
      query: data.query,
      channelId: data.channel_id || undefined,
      limit: data.page?.limit,
      cursor: data.page?.cursor || undefined,
    });
    return {
      messages: result.messages.map(mapMessage),
      page: { next_cursor: result.nextCursor, has_more: result.hasMore },
    };
  }

  // ── Прочтение ─────────────────────────────────────────────────────────

  @GrpcMethod('ChatService', 'MarkRead')
  async markRead(data: { channel_id: string; employee_id: string; up_to_seq?: string | number }) {
    await this.channels.assertMember(data.channel_id, data.employee_id);
    await this.cursors.mark(data.channel_id, data.employee_id, Number(data.up_to_seq ?? 0));
    return mapCounters(await this.cursors.counters(data.employee_id));
  }

  @GrpcMethod('ChatService', 'GetUnreadCounters')
  async getUnreadCounters(data: { employee_id: string }) {
    return mapCounters(await this.cursors.counters(data.employee_id));
  }
}

function toChannelType(value: string): ChannelType {
  const known: Record<string, ChannelType> = {
    PUBLIC: ChannelType.PUBLIC,
    PRIVATE: ChannelType.PRIVATE,
    DIRECT: ChannelType.DIRECT,
    GROUP: ChannelType.GROUP,
    ANNOUNCEMENT: ChannelType.ANNOUNCEMENT,
  };
  // CHANNEL_TYPE_UNSPECIFIED и пустое значение — приватный канал:
  // безопасное умолчание, при котором забытое поле не делает переписку
  // видимой лишним людям.
  return known[value] ?? ChannelType.PRIVATE;
}

function mapChannel(channel: ChannelWithMembers) {
  return {
    channel_id: channel.id,
    name: channel.name,
    type: channel.type,
    department_id: channel.departmentId ?? '',
    member_employee_ids: channel.members.map((member) => member.employeeId),
    creator_employee_id: channel.creatorEmployeeId,
    last_message_seq: channel.lastMessageSeq,
    created_at: channel.createdAt.getTime(),
  };
}

/**
 * Реакции группируются на выдаче, а не хранятся сгруппированными.
 *
 * В базе строка на пару «человек + эмодзи»: так повторное нажатие
 * снимается точечным удалением, а не чтением, правкой и записью массива,
 * в котором двое одновременно затёрли бы друг друга.
 */
function groupReactions(reactions: Reaction[]) {
  const byEmoji = new Map<string, string[]>();
  for (const reaction of reactions) {
    const list = byEmoji.get(reaction.emoji) ?? [];
    list.push(reaction.employeeId);
    byEmoji.set(reaction.emoji, list);
  }
  return [...byEmoji.entries()].map(([emoji, employeeIds]) => ({
    emoji,
    employee_ids: employeeIds,
  }));
}

function mapMessage(message: MessageWithReactions | (MessageWithReactions & { reactions?: never })) {
  const reactions = 'reactions' in message && Array.isArray(message.reactions)
    ? message.reactions
    : [];
  return {
    message_id: message.id,
    channel_id: message.channelId,
    author_employee_id: message.authorEmployeeId ?? '',
    body: message.body,
    thread_root_id: message.threadRootId ?? '',
    mentions: message.mentions,
    attachment_file_ids: message.attachmentFileIds,
    reactions: groupReactions(reactions),
    created_at: message.createdAt.getTime(),
    edited_at: message.editedAt?.getTime() ?? 0,
    deleted: message.deleted,
    seq: message.seq,
  };
}

function mapCounters(result: {
  items: { channelId: string; unread: number; mentions: number }[];
  total: number;
}) {
  return {
    items: result.items.map((item) => ({
      channel_id: item.channelId,
      unread: item.unread,
      mentions: item.mentions,
    })),
    total: result.total,
  };
}
