import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Participant } from '../../generated/prisma';
import { VIDEO_CONFIG, type VideoConfig } from '../config';
import { SfuService } from '../sfu/sfu.service';
import { JoinTokenService } from './join-token.service';
import { RoomService, type RoomWithParticipants } from './room.service';

/**
 * gRPC-фасад video-service.
 *
 * Через контракт идёт только УПРАВЛЕНИЕ: завести комнату, выдать пропуск,
 * поменять права, завершить. Сигналинг — прямое WSS-соединение клиента,
 * медиапоток — DTLS-SRTP до SFU; ни то ни другое через gRPC не проходит
 * и проходить не должно (§8.3).
 */
@Controller()
export class VideoGrpcController {
  constructor(
    private readonly rooms: RoomService,
    private readonly tokens: JoinTokenService,
    private readonly sfu: SfuService,
    @Inject(VIDEO_CONFIG) private readonly config: VideoConfig,
  ) {}

  @GrpcMethod('VideoService', 'CreateRoom')
  async createRoom(data: {
    title: string;
    initiator_employee_id: string;
    invited_employee_ids?: string[];
    channel_id?: string;
    card_id?: string;
  }) {
    const room = await this.rooms.createRoom({
      title: data.title,
      initiatorEmployeeId: data.initiator_employee_id,
      invitedEmployeeIds: data.invited_employee_ids ?? [],
      channelId: data.channel_id || undefined,
      cardId: data.card_id || undefined,
    });
    return mapRoom(room);
  }

  @GrpcMethod('VideoService', 'GetRoom')
  async getRoom(data: { room_id: string; actor_employee_id?: string }) {
    const room = await this.rooms.getRoom(data.room_id, data.actor_employee_id || undefined);
    return mapRoom(room);
  }

  /**
   * Пропуск в комнату.
   *
   * Выдаётся только участнику: сигналинг проверит подпись, но не станет
   * решать, кого пускать, — это решение принимается здесь, один раз, и
   * зашивается в сам пропуск.
   */
  @GrpcMethod('VideoService', 'IssueJoinToken')
  async issueJoinToken(data: { room_id: string; employee_id: string }) {
    const room = await this.rooms.getRoom(data.room_id);
    if (room.status === 'ENDED') {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'звонок уже завершён',
      });
    }
    if (!(await this.rooms.isInvited(data.room_id, data.employee_id))) {
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: 'вы не участник этого звонка',
      });
    }

    const issued = this.tokens.issue(data.room_id, data.employee_id);
    return {
      token: issued.token,
      signaling_url: this.config.signalingUrl,
      // Отдельного адреса SFU нет и не будет: медиа идёт по ICE-кандидатам,
      // которые клиент получит при создании транспорта. Поле оставлено в
      // контракте для реализаций, где SFU вынесен на другой хост.
      sfu_url: '',
      ice_servers: this.tokens.iceServers().map((server) => ({
        urls: server.urls,
        username: server.username,
        credential: server.credential,
      })),
      expires_at: issued.expiresAt,
    };
  }

  @GrpcMethod('VideoService', 'SetParticipantRights')
  async setParticipantRights(data: {
    room_id: string;
    target_employee_id: string;
    actor_employee_id: string;
    action: string;
  }) {
    await this.rooms.assertModerator(data.room_id, data.actor_employee_id);

    if (data.action === 'GRANT_MODERATOR') {
      await this.rooms.grantModerator(data.room_id, data.target_employee_id);
      return {};
    }
    if (data.action === 'MUTE' || data.action === 'UNMUTE') {
      await this.rooms.setMediaState(data.room_id, data.target_employee_id, {
        audioEnabled: data.action === 'UNMUTE',
      });
      return {};
    }

    // KICK через gRPC не поддержан намеренно: выгнать можно только из
    // живого соединения, а им управляет сигналинг. Отметка в базе без
    // разрыва соединения означала бы, что выгнанный продолжает слышать
    // разговор.
    throw new RpcException({
      code: GrpcStatus.INVALID_ARGUMENT,
      message: 'исключение участника выполняется через сигналинг звонка',
    });
  }

  /**
   * Запись звонка.
   *
   * Не реализована и отвечает отказом, а не молчаливым согласием.
   * Механизм требует PlainTransport в SFU и ffmpeg, который принимал бы
   * RTP и складывал файл; ffmpeg в образе нет — ровно как и в
   * file-service для команды media.process. Отвечать «начато», ничего не
   * записывая, хуже отказа: участники были бы уверены, что разговор
   * сохраняется.
   */
  @GrpcMethod('VideoService', 'StartRecording')
  startRecording() {
    throw new RpcException({
      code: GrpcStatus.UNIMPLEMENTED,
      message: 'запись звонков требует ffmpeg в образе и пока не реализована',
    });
  }

  @GrpcMethod('VideoService', 'StopRecording')
  stopRecording() {
    throw new RpcException({
      code: GrpcStatus.UNIMPLEMENTED,
      message: 'запись звонков требует ffmpeg в образе и пока не реализована',
    });
  }

  @GrpcMethod('VideoService', 'EndRoom')
  async endRoom(data: { room_id: string; actor_employee_id?: string }) {
    if (data.actor_employee_id) {
      await this.rooms.assertModerator(data.room_id, data.actor_employee_id);
    }
    await this.rooms.endRoom(data.room_id);
    // Роутер закрывается вслед за комнатой: это обрывает транспорты всех
    // участников, то есть завершает звонок физически, а не только в базе.
    this.sfu.closeRoom(data.room_id);
    return {};
  }

  @GrpcMethod('VideoService', 'ListActiveRooms')
  async listActiveRooms(data: { employee_ids?: string[] }) {
    const rooms = await this.rooms.listActive(data.employee_ids ?? []);
    return { rooms: rooms.map(mapRoom) };
  }
}

function mapParticipant(participant: Participant) {
  return {
    employee_id: participant.employeeId,
    is_moderator: participant.isModerator,
    audio_enabled: participant.audioEnabled,
    video_enabled: participant.videoEnabled,
    joined_at: participant.joinedAt?.getTime() ?? 0,
    left_at: participant.leftAt?.getTime() ?? 0,
  };
}

function mapRoom(room: RoomWithParticipants) {
  return {
    room_id: room.id,
    title: room.title,
    initiator_employee_id: room.initiatorEmployeeId,
    channel_id: room.channelId ?? '',
    participants: room.participants.map(mapParticipant),
    status: room.status,
    recording: room.recording,
    started_at: room.startedAt.getTime(),
    ended_at: room.endedAt?.getTime() ?? 0,
  };
}
