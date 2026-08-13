import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { SERVICES } from '@crm/contracts';
import { DEADLINES_MS, grpcClientToken } from '@crm/grpc-clients';

export interface ChannelDto {
  channel_id: string;
  name: string;
  type: string;
  department_id: string;
  member_employee_ids: string[];
  creator_employee_id: string;
  last_message_seq: number;
  created_at: number;
}

export interface ReactionDto {
  emoji: string;
  employee_ids: string[];
}

export interface MessageDto {
  message_id: string;
  channel_id: string;
  author_employee_id: string;
  body: string;
  thread_root_id: string;
  mentions: string[];
  attachment_file_ids: string[];
  reactions: ReactionDto[];
  created_at: number;
  edited_at: number;
  deleted: boolean;
  seq: number;
}

export interface PageDto {
  next_cursor: string;
  has_more: boolean;
}

export interface UnreadCountersDto {
  items: { channel_id: string; unread: number; mentions: number }[];
  total: number;
}

interface ChatGrpc {
  CreateChannel(data: Record<string, unknown>): Observable<ChannelDto>;
  ListChannels(data: { employee_id: string }): Observable<{ channels: ChannelDto[] }>;
  GetChannel(data: {
    channel_id: string;
    actor_employee_id: string;
  }): Observable<ChannelDto>;
  GetOrCreateDirect(data: {
    employee_id_a: string;
    employee_id_b: string;
  }): Observable<ChannelDto>;
  AddMembers(data: { channel_id: string; employee_ids: string[] }): Observable<ChannelDto>;
  RemoveMember(data: { channel_id: string; employee_id: string }): Observable<ChannelDto>;
  GetHistory(data: Record<string, unknown>): Observable<{ messages: MessageDto[]; page: PageDto }>;
  SendMessage(data: Record<string, unknown>): Observable<MessageDto>;
  EditMessage(data: {
    message_id: string;
    author_employee_id: string;
    body: string;
  }): Observable<MessageDto>;
  DeleteMessage(data: { message_id: string; actor_employee_id: string }): Observable<object>;
  AddReaction(data: {
    message_id: string;
    employee_id: string;
    emoji: string;
  }): Observable<MessageDto>;
  MarkRead(data: {
    channel_id: string;
    employee_id: string;
    up_to_seq: number;
  }): Observable<UnreadCountersDto>;
  GetUnreadCounters(data: { employee_id: string }): Observable<UnreadCountersDto>;
  SearchMessages(data: Record<string, unknown>): Observable<{
    messages: MessageDto[];
    page: PageDto;
  }>;
}

/**
 * Клиент к chat-service.
 *
 * Отдельно от остальных стоит getChannel: его вызывает не только REST, но
 * и WebSocket-слой, когда решает, пускать ли соединение в комнату
 * `channel:<id>`. Проверка участия там обязана быть той же самой — иначе
 * права на чтение переписки разошлись бы между двумя транспортами (§8.1).
 */
@Injectable()
export class ChatClient implements OnModuleInit {
  private service!: ChatGrpc;

  constructor(@Inject(grpcClientToken(SERVICES.CHAT)) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.service = this.client.getService<ChatGrpc>('ChatService');
  }

  private call<T>(source: Observable<T>, deadline: number = DEADLINES_MS.DEFAULT): Promise<T> {
    return firstValueFrom(source.pipe(timeout(deadline)));
  }

  createChannel(input: {
    name: string;
    type: string;
    departmentId?: string;
    creatorEmployeeId: string;
    memberEmployeeIds?: string[];
  }) {
    return this.call(
      this.service.CreateChannel({
        name: input.name,
        type: input.type,
        department_id: input.departmentId ?? '',
        creator_employee_id: input.creatorEmployeeId,
        member_employee_ids: input.memberEmployeeIds ?? [],
      }),
    );
  }

  listChannels(employeeId: string) {
    return this.call(this.service.ListChannels({ employee_id: employeeId }));
  }

  /** Канал с проверкой участия. Пустой actor — вызов в обход проверки. */
  getChannel(channelId: string, actorEmployeeId: string) {
    return this.call(
      this.service.GetChannel({ channel_id: channelId, actor_employee_id: actorEmployeeId }),
    );
  }

  getOrCreateDirect(employeeIdA: string, employeeIdB: string) {
    return this.call(
      this.service.GetOrCreateDirect({
        employee_id_a: employeeIdA,
        employee_id_b: employeeIdB,
      }),
    );
  }

  addMembers(channelId: string, employeeIds: string[]) {
    return this.call(
      this.service.AddMembers({ channel_id: channelId, employee_ids: employeeIds }),
    );
  }

  removeMember(channelId: string, employeeId: string) {
    return this.call(
      this.service.RemoveMember({ channel_id: channelId, employee_id: employeeId }),
    );
  }

  getHistory(input: {
    channelId: string;
    actorEmployeeId: string;
    beforeSeq?: number;
    limit?: number;
    threadRootId?: string;
  }) {
    return this.call(
      this.service.GetHistory({
        channel_id: input.channelId,
        actor_employee_id: input.actorEmployeeId,
        before_seq: input.beforeSeq ?? 0,
        limit: input.limit ?? 50,
        thread_root_id: input.threadRootId ?? '',
      }),
    );
  }

  sendMessage(input: {
    channelId: string;
    authorEmployeeId: string;
    body: string;
    threadRootId?: string;
    mentions?: string[];
    attachmentFileIds?: string[];
    clientMessageId?: string;
  }) {
    return this.call(
      this.service.SendMessage({
        channel_id: input.channelId,
        author_employee_id: input.authorEmployeeId,
        body: input.body,
        thread_root_id: input.threadRootId ?? '',
        mentions: input.mentions ?? [],
        attachment_file_ids: input.attachmentFileIds ?? [],
        client_message_id: input.clientMessageId ?? '',
      }),
    );
  }

  editMessage(messageId: string, authorEmployeeId: string, body: string) {
    return this.call(
      this.service.EditMessage({
        message_id: messageId,
        author_employee_id: authorEmployeeId,
        body,
      }),
    );
  }

  deleteMessage(messageId: string, actorEmployeeId: string) {
    return this.call(
      this.service.DeleteMessage({ message_id: messageId, actor_employee_id: actorEmployeeId }),
    );
  }

  toggleReaction(messageId: string, employeeId: string, emoji: string) {
    return this.call(
      this.service.AddReaction({ message_id: messageId, employee_id: employeeId, emoji }),
    );
  }

  markRead(channelId: string, employeeId: string, upToSeq: number) {
    return this.call(
      this.service.MarkRead({
        channel_id: channelId,
        employee_id: employeeId,
        up_to_seq: upToSeq,
      }),
    );
  }

  unreadCounters(employeeId: string) {
    return this.call(this.service.GetUnreadCounters({ employee_id: employeeId }));
  }

  search(input: {
    employeeId: string;
    query: string;
    channelId?: string;
    limit?: number;
    cursor?: string;
  }) {
    return this.call(
      this.service.SearchMessages({
        employee_id: input.employeeId,
        query: input.query,
        channel_id: input.channelId ?? '',
        page: { limit: input.limit ?? 20, cursor: input.cursor ?? '' },
      }),
      DEADLINES_MS.REPORTING,
    );
  }
}
