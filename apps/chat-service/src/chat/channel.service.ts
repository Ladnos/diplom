import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import {
  ChatEvents,
  type ChannelCreated,
  type ChannelMemberChanged,
  type RequestContext,
} from '@crm/contracts';
import { getRequestContext } from '@crm/common';
import { EventPublisher } from '@crm/messaging';
import { ChannelType, MemberRole, Prisma } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { outboxRow } from '../prisma/outbox.store';

export type ChannelWithMembers = Prisma.ChannelGetPayload<{ include: { members: true } }>;

/**
 * Каналы: создание, состав участников, личная переписка.
 *
 * Доступ к каналу определяется УЧАСТИЕМ, а не ролью. Права в auth-service
 * отвечают на вопрос «может ли этот человек пользоваться чатом вообще»,
 * а на вопрос «этим каналом» — только таблица участников. Без проверки
 * здесь любой сотрудник прочитал бы чужую переписку, зная её
 * идентификатор, — та же граница, что у досок в task-service.
 */
@Injectable()
export class ChannelService {
  private readonly logger = new Logger(ChannelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: EventPublisher,
  ) {}

  async createChannel(
    input: {
      name: string;
      type: ChannelType;
      departmentId?: string;
      creatorEmployeeId: string;
      memberEmployeeIds?: string[];
    },
    context: RequestContext = getRequestContext(),
  ): Promise<ChannelWithMembers> {
    if (input.type === ChannelType.DIRECT) {
      // Личная переписка не создаётся с именем и составом: она заводится
      // самим фактом обращения к собеседнику, поэтому у неё отдельный
      // метод с защитой от гонки.
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'личная переписка создаётся методом GetOrCreateDirect',
      });
    }

    const memberIds = await this.validateMembers([
      input.creatorEmployeeId,
      ...(input.memberEmployeeIds ?? []),
    ]);

    return this.prisma.$transaction(async (tx) => {
      const channel = await tx.channel.create({
        data: {
          name: input.name,
          type: input.type,
          departmentId: input.departmentId ?? null,
          creatorEmployeeId: input.creatorEmployeeId,
          members: {
            create: memberIds.map((employeeId) => ({
              employeeId,
              // Создатель остаётся владельцем: в канале объявлений это
              // определяет право писать, в остальных — право менять состав.
              role:
                employeeId === input.creatorEmployeeId ? MemberRole.OWNER : MemberRole.MEMBER,
            })),
          },
        },
        include: { members: true },
      });

      const envelope = this.publisher.wrap<ChannelCreated>(
        ChatEvents.CHANNEL_CREATED,
        {
          channelId: channel.id,
          name: channel.name,
          type: channel.type,
          creatorEmployeeId: channel.creatorEmployeeId,
          memberEmployeeIds: memberIds,
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      return channel;
    });
  }

  /**
   * Личная переписка двоих.
   *
   * Ключ пары — два отсортированных идентификатора: он одинаков независимо
   * от того, кто написал первым. Уникальный индекс на нём превращает
   * одновременное «написать друг другу» в конфликт вставки, который здесь
   * же разрешается чтением уже созданного канала. Без ключа получились бы
   * два диалога, и половина сообщений ушла бы в тот, который собеседник
   * не открывает.
   */
  async getOrCreateDirect(
    employeeIdA: string,
    employeeIdB: string,
    context: RequestContext = getRequestContext(),
  ): Promise<ChannelWithMembers> {
    if (employeeIdA === employeeIdB) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'нельзя завести переписку с самим собой',
      });
    }

    const members = await this.validateMembers([employeeIdA, employeeIdB]);
    const directKey = [employeeIdA, employeeIdB].sort().join(':');

    const existing = await this.prisma.channel.findUnique({
      where: { directKey },
      include: { members: true },
    });
    if (existing) return existing;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const channel = await tx.channel.create({
          data: {
            name: '',
            type: ChannelType.DIRECT,
            directKey,
            creatorEmployeeId: employeeIdA,
            members: { create: members.map((employeeId) => ({ employeeId })) },
          },
          include: { members: true },
        });

        const envelope = this.publisher.wrap<ChannelCreated>(
          ChatEvents.CHANNEL_CREATED,
          {
            channelId: channel.id,
            // Имя личной переписки собирает клиент из имени собеседника:
            // одно и то же название «Иванов» для одного участника
            // бессмысленно для другого.
            name: '',
            type: channel.type,
            creatorEmployeeId: employeeIdA,
            memberEmployeeIds: members,
          },
          context,
        );
        await tx.outbox.create({ data: outboxRow(envelope) });

        return channel;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Собеседник успел первым — забираем его канал, а не сообщаем об
        // ошибке: с точки зрения обоих результат один и тот же.
        const created = await this.prisma.channel.findUnique({
          where: { directKey },
          include: { members: true },
        });
        if (created) return created;
      }
      throw error;
    }
  }

  async listChannels(employeeId: string): Promise<ChannelWithMembers[]> {
    return this.prisma.channel.findMany({
      where: { archived: false, members: { some: { employeeId } } },
      include: { members: true },
      // Каналы с недавней активностью выше: список открывают ради них.
      orderBy: [{ lastMessageSeq: 'desc' }, { createdAt: 'desc' }],
    });
  }

  /** Канал с проверкой участия. Пустой actor — вызов от другого сервиса. */
  async getChannel(channelId: string, actorEmployeeId?: string): Promise<ChannelWithMembers> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      include: { members: true },
    });
    if (!channel) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'канал не найден' });
    }
    if (actorEmployeeId) assertMemberOf(channel, actorEmployeeId);
    return channel;
  }

  /**
   * Проверка участия без выдачи содержимого.
   *
   * Нужна api-gateway, чтобы пустить соединение в комнату `channel:<id>`
   * (§8.1): там нужен ответ «да или нет», а не сам канал со списком
   * участников.
   */
  async assertMember(channelId: string, employeeId: string): Promise<void> {
    const member = await this.prisma.channelMember.findUnique({
      where: { channelId_employeeId: { channelId, employeeId } },
      select: { role: true },
    });
    if (member) return;

    // Не разделяем «канала нет» и «вы не участник»: иначе по коду ответа
    // можно было бы перебором выяснить, какие каналы существуют.
    throw new RpcException({
      code: GrpcStatus.PERMISSION_DENIED,
      message: 'вы не участник этого канала',
    });
  }

  async addMembers(
    channelId: string,
    employeeIds: string[],
    context: RequestContext = getRequestContext(),
  ): Promise<ChannelWithMembers> {
    const channel = await this.getChannel(channelId);
    if (channel.type === ChannelType.DIRECT) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'в личную переписку нельзя добавить третьего',
      });
    }

    const present = new Set(channel.members.map((member) => member.employeeId));
    const toAdd = (await this.validateMembers(employeeIds)).filter((id) => !present.has(id));
    if (toAdd.length === 0) return channel;

    return this.prisma.$transaction(async (tx) => {
      await tx.channelMember.createMany({
        data: toAdd.map((employeeId) => ({ channelId, employeeId })),
        skipDuplicates: true,
      });

      // По событию на человека, а не одно на всех: подписчику нужно знать
      // ИМЕННО кого добавили — уведомление адресное, и разбирать массив
      // ради одного получателя пришлось бы каждому потребителю.
      for (const employeeId of toAdd) {
        const envelope = this.publisher.wrap<ChannelMemberChanged>(
          ChatEvents.MEMBER_ADDED,
          { channelId, employeeId },
          context,
        );
        await tx.outbox.create({ data: outboxRow(envelope) });
      }

      return tx.channel.findUniqueOrThrow({
        where: { id: channelId },
        include: { members: true },
      });
    });
  }

  async removeMember(
    channelId: string,
    employeeId: string,
    context: RequestContext = getRequestContext(),
  ): Promise<ChannelWithMembers> {
    const channel = await this.getChannel(channelId);
    if (channel.type === ChannelType.DIRECT) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'из личной переписки нельзя выйти',
      });
    }

    const target = channel.members.find((member) => member.employeeId === employeeId);
    if (!target) return channel;

    const owners = channel.members.filter((member) => member.role === MemberRole.OWNER);
    if (target.role === MemberRole.OWNER && owners.length === 1) {
      // Канал без владельца некому передать: состав менять станет нельзя,
      // а в канал объявлений — ещё и писать.
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'нельзя исключить единственного владельца канала',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.channelMember.delete({
        where: { channelId_employeeId: { channelId, employeeId } },
      });

      // Курсор прочтения снимается вместе с участием: вернувшись, человек
      // увидит канал непрочитанным целиком, что честнее, чем застывший
      // курсор недельной давности.
      await tx.readCursor.deleteMany({ where: { channelId, employeeId } });

      const envelope = this.publisher.wrap<ChannelMemberChanged>(
        ChatEvents.MEMBER_REMOVED,
        { channelId, employeeId },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      return tx.channel.findUniqueOrThrow({
        where: { id: channelId },
        include: { members: true },
      });
    });
  }

  /**
   * Отсев несуществующих и уволенных.
   *
   * Проекция может отставать от кадрового сервиса, поэтому неизвестный
   * идентификатор — не повод отказать: он просто ещё не доехал. А вот
   * известный и уволенный отсекается: добавление уволенного в канал —
   * это не отставание проекции, а ошибка вызывающего.
   */
  private async validateMembers(employeeIds: string[]): Promise<string[]> {
    const unique = [...new Set(employeeIds.filter(Boolean))];
    if (unique.length === 0) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'не указан ни один участник',
      });
    }

    const known = await this.prisma.employeeRef.findMany({
      where: { employeeId: { in: unique } },
      select: { employeeId: true, active: true },
    });
    const inactive = new Set(
      known.filter((ref) => !ref.active).map((ref) => ref.employeeId),
    );

    const result = unique.filter((id) => !inactive.has(id));
    if (result.length === 0) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'все указанные сотрудники уволены',
      });
    }

    if (inactive.size > 0) {
      this.logger.debug({ message: 'уволенные исключены из состава', count: inactive.size });
    }
    return result;
  }
}

/** Общая проверка участия для уже загруженного канала. */
export function assertMemberOf(channel: ChannelWithMembers, employeeId: string): void {
  if (channel.members.some((member) => member.employeeId === employeeId)) return;

  throw new RpcException({
    code: GrpcStatus.PERMISSION_DENIED,
    message: 'вы не участник этого канала',
  });
}

/** P2002 — нарушение уникального ключа. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
