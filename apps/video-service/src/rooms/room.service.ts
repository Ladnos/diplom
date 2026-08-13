import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import {
  VideoEvents,
  type CallEnded,
  type CallStarted,
  type ParticipantChanged,
  type RequestContext,
} from '@crm/contracts';
import { getRequestContext } from '@crm/common';
import { EventPublisher } from '@crm/messaging';
import { Prisma, RoomStatus, type Participant } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { outboxRow } from '../prisma/outbox.store';

export type RoomWithParticipants = Prisma.RoomGetPayload<{ include: { participants: true } }>;

/**
 * Комнаты звонков: состав, состояние, события.
 *
 * Медиа здесь нет — им занимается SFU. Этот класс отвечает за то, что
 * переживает звонок: кого позвали, кто пришёл, сколько длилось и куда об
 * этом сообщить.
 */
@Injectable()
export class RoomService {
  private readonly logger = new Logger(RoomService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: EventPublisher,
  ) {}

  /**
   * Создание комнаты.
   *
   * Строки участников заводятся сразу на всех приглашённых, а не по мере
   * входа: приглашённый должен увидеть звонок в интерфейсе до того, как
   * присоединится, а уведомление о приглашении адресуется по этому же
   * списку.
   */
  async createRoom(
    input: {
      title: string;
      initiatorEmployeeId: string;
      invitedEmployeeIds?: string[];
      channelId?: string;
      cardId?: string;
    },
    context: RequestContext = getRequestContext(),
  ): Promise<RoomWithParticipants> {
    const invited = await this.activeOnly([
      input.initiatorEmployeeId,
      ...(input.invitedEmployeeIds ?? []),
    ]);

    return this.prisma.$transaction(async (tx) => {
      const room = await tx.room.create({
        data: {
          title: input.title || 'Звонок',
          initiatorEmployeeId: input.initiatorEmployeeId,
          channelId: input.channelId ?? null,
          cardId: input.cardId ?? null,
          participants: {
            create: invited.map((employeeId) => ({
              employeeId,
              // Инициатор — модератор: кто-то должен иметь право
              // выключить микрофон забывшему про него участнику.
              isModerator: employeeId === input.initiatorEmployeeId,
            })),
          },
        },
        include: { participants: true },
      });

      const envelope = this.publisher.wrap<CallStarted>(
        VideoEvents.CALL_STARTED,
        {
          roomId: room.id,
          initiatorEmployeeId: input.initiatorEmployeeId,
          invitedEmployeeIds: invited.filter((id) => id !== input.initiatorEmployeeId),
          channelId: input.channelId,
          cardId: input.cardId,
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      return room;
    });
  }

  async getRoom(roomId: string, actorEmployeeId?: string): Promise<RoomWithParticipants> {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      include: { participants: true },
    });
    if (!room) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'комната не найдена' });
    }
    if (actorEmployeeId) assertParticipant(room, actorEmployeeId);
    return room;
  }

  /** Приглашён ли сотрудник в комнату — без выдачи содержимого. */
  async isInvited(roomId: string, employeeId: string): Promise<boolean> {
    const participant = await this.prisma.participant.findUnique({
      where: { roomId_employeeId: { roomId, employeeId } },
      select: { employeeId: true },
    });
    return participant !== null;
  }

  /**
   * Вход участника.
   *
   * Первый вошедший переводит комнату в ACTIVE: до этого момента звонок
   * заведён, но не начат, и завершать по «последний вышел» ещё нечего.
   */
  async join(
    roomId: string,
    employeeId: string,
    context: RequestContext = getRequestContext(),
  ): Promise<Participant> {
    const room = await this.getRoom(roomId);
    if (room.status === RoomStatus.ENDED) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'звонок уже завершён',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const participant = await tx.participant.upsert({
        where: { roomId_employeeId: { roomId, employeeId } },
        // Вошедший без приглашения — это вход по ссылке из канала: право
        // войти проверено раньше, при выдаче пропуска.
        create: { roomId, employeeId, joinedAt: new Date() },
        update: { joinedAt: new Date(), leftAt: null },
      });

      if (room.status === RoomStatus.CREATED) {
        await tx.room.update({
          where: { id: roomId },
          data: { status: RoomStatus.ACTIVE },
        });
      }

      const envelope = this.publisher.wrap<ParticipantChanged>(
        VideoEvents.PARTICIPANT_JOINED,
        { roomId, employeeId, at: new Date().toISOString() },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      return participant;
    });
  }

  /**
   * Выход участника. Возвращает true, если он был последним.
   *
   * Считаем по строкам, а не по счётчику в памяти: соединение может
   * оборваться без выхода, и восстанавливаемое из БД состояние —
   * единственное, на которое можно опереться после перезапуска.
   */
  async leave(
    roomId: string,
    employeeId: string,
    context: RequestContext = getRequestContext(),
  ): Promise<boolean> {
    await this.prisma.$transaction(async (tx) => {
      await tx.participant.updateMany({
        where: { roomId, employeeId, leftAt: null },
        data: { leftAt: new Date() },
      });

      const envelope = this.publisher.wrap<ParticipantChanged>(
        VideoEvents.PARTICIPANT_LEFT,
        { roomId, employeeId, at: new Date().toISOString() },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });
    });

    const stillInside = await this.prisma.participant.count({
      where: { roomId, joinedAt: { not: null }, leftAt: null },
    });
    return stillInside === 0;
  }

  /**
   * Завершение звонка.
   *
   * Идемпотентно: завершить могут одновременно и модератор кнопкой, и
   * выход последнего участника. Повторный вызов не должен слать второе
   * событие — на него chat-service положит вторую системную запись в
   * канал.
   */
  async endRoom(
    roomId: string,
    context: RequestContext = getRequestContext(),
  ): Promise<RoomWithParticipants | null> {
    const room = await this.getRoom(roomId);
    if (room.status === RoomStatus.ENDED) return null;

    const endedAt = new Date();
    const durationSec = Math.max(
      0,
      Math.round((endedAt.getTime() - room.startedAt.getTime()) / 1000),
    );

    return this.prisma.$transaction(async (tx) => {
      // Условие на статус внутри запроса, а не проверка до него: два
      // одновременных завершения иначе оба увидели бы ACTIVE.
      const updated = await tx.room.updateMany({
        where: { id: roomId, status: { not: RoomStatus.ENDED } },
        data: { status: RoomStatus.ENDED, endedAt, recording: false },
      });
      if (updated.count === 0) return null;

      await tx.participant.updateMany({
        where: { roomId, joinedAt: { not: null }, leftAt: null },
        data: { leftAt: endedAt },
      });

      const participated = room.participants
        .filter((item) => item.joinedAt !== null)
        .map((item) => item.employeeId);

      const envelope = this.publisher.wrap<CallEnded>(
        VideoEvents.CALL_ENDED,
        {
          roomId,
          durationSec,
          participantEmployeeIds: participated,
          channelId: room.channelId ?? undefined,
          recorded: room.recording,
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      this.logger.log({
        message: 'звонок завершён',
        roomId,
        durationSec,
        participants: participated.length,
      });

      return tx.room.findUniqueOrThrow({
        where: { id: roomId },
        include: { participants: true },
      });
    });
  }

  /** Состояние устройств участника — чтобы вошедший позже видел актуальное. */
  async setMediaState(
    roomId: string,
    employeeId: string,
    state: { audioEnabled?: boolean; videoEnabled?: boolean },
  ): Promise<void> {
    await this.prisma.participant.updateMany({
      where: { roomId, employeeId },
      data: {
        ...(state.audioEnabled !== undefined ? { audioEnabled: state.audioEnabled } : {}),
        ...(state.videoEnabled !== undefined ? { videoEnabled: state.videoEnabled } : {}),
      },
    });
  }

  /**
   * Изменение прав участника модератором.
   *
   * Само действие (выключить микрофон, выгнать) исполняет сигналинг —
   * оно про живое соединение. Здесь только проверка права и запись того,
   * что переживает звонок.
   */
  async assertModerator(roomId: string, actorEmployeeId: string): Promise<void> {
    const actor = await this.prisma.participant.findUnique({
      where: { roomId_employeeId: { roomId, employeeId: actorEmployeeId } },
      select: { isModerator: true },
    });
    if (actor?.isModerator) return;

    throw new RpcException({
      code: GrpcStatus.PERMISSION_DENIED,
      message: 'действие доступно модератору звонка',
    });
  }

  async grantModerator(roomId: string, employeeId: string): Promise<void> {
    await this.prisma.participant.updateMany({
      where: { roomId, employeeId },
      data: { isModerator: true },
    });
  }

  /** Активные звонки сотрудников — чтобы интерфейс показал «идёт звонок». */
  async listActive(employeeIds: string[]): Promise<RoomWithParticipants[]> {
    const unique = [...new Set(employeeIds.filter(Boolean))];
    if (unique.length === 0) return [];

    return this.prisma.room.findMany({
      where: {
        status: { in: [RoomStatus.CREATED, RoomStatus.ACTIVE] },
        participants: { some: { employeeId: { in: unique } } },
      },
      include: { participants: true },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
  }

  /**
   * Отсев уволенных.
   *
   * Неизвестный идентификатор пропускаем: проекция могла отстать, и
   * отказ в звонке из-за не доехавшего события хуже, чем лишний
   * участник. Известный и уволенный отсекается — это уже не отставание.
   */
  private async activeOnly(employeeIds: string[]): Promise<string[]> {
    const unique = [...new Set(employeeIds.filter(Boolean))];
    if (unique.length === 0) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'не указан ни один участник',
      });
    }

    const known = await this.prisma.employeeRef.findMany({
      where: { employeeId: { in: unique }, active: false },
      select: { employeeId: true },
    });
    const inactive = new Set(known.map((item) => item.employeeId));
    return unique.filter((id) => !inactive.has(id));
  }
}

export function assertParticipant(room: RoomWithParticipants, employeeId: string): void {
  if (room.participants.some((item) => item.employeeId === employeeId)) return;

  throw new RpcException({
    code: GrpcStatus.PERMISSION_DENIED,
    message: 'вы не участник этого звонка',
  });
}
