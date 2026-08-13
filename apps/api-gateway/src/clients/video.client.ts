import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { SERVICES } from '@crm/contracts';
import { DEADLINES_MS, grpcClientToken } from '@crm/grpc-clients';

export interface ParticipantDto {
  employee_id: string;
  is_moderator: boolean;
  audio_enabled: boolean;
  video_enabled: boolean;
  joined_at: number;
  left_at: number;
}

export interface RoomDto {
  room_id: string;
  title: string;
  initiator_employee_id: string;
  channel_id: string;
  participants: ParticipantDto[];
  status: string;
  recording: boolean;
  started_at: number;
  ended_at: number;
}

export interface JoinTokenDto {
  token: string;
  signaling_url: string;
  sfu_url: string;
  ice_servers: { urls: string; username: string; credential: string }[];
  expires_at: number;
}

interface VideoGrpc {
  CreateRoom(data: Record<string, unknown>): Observable<RoomDto>;
  GetRoom(data: { room_id: string; actor_employee_id: string }): Observable<RoomDto>;
  IssueJoinToken(data: { room_id: string; employee_id: string }): Observable<JoinTokenDto>;
  SetParticipantRights(data: {
    room_id: string;
    target_employee_id: string;
    actor_employee_id: string;
    action: string;
  }): Observable<object>;
  EndRoom(data: { room_id: string; actor_employee_id: string }): Observable<object>;
  ListActiveRooms(data: { employee_ids: string[] }): Observable<{ rooms: RoomDto[] }>;
}

/**
 * Клиент к video-service.
 *
 * Через него идёт только управление звонком. Сигналинг клиент открывает
 * сам, прямым соединением на `/signaling`, а медиапоток вообще не
 * проходит через шлюз (§8.3) — здесь выдаётся лишь пропуск, по которому
 * то соединение будет принято.
 */
@Injectable()
export class VideoClient implements OnModuleInit {
  private service!: VideoGrpc;

  constructor(@Inject(grpcClientToken(SERVICES.VIDEO)) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.service = this.client.getService<VideoGrpc>('VideoService');
  }

  private call<T>(source: Observable<T>, deadline: number = DEADLINES_MS.DEFAULT): Promise<T> {
    return firstValueFrom(source.pipe(timeout(deadline)));
  }

  createRoom(input: {
    title: string;
    initiatorEmployeeId: string;
    invitedEmployeeIds?: string[];
    channelId?: string;
    cardId?: string;
  }) {
    return this.call(
      this.service.CreateRoom({
        title: input.title,
        initiator_employee_id: input.initiatorEmployeeId,
        invited_employee_ids: input.invitedEmployeeIds ?? [],
        channel_id: input.channelId ?? '',
        card_id: input.cardId ?? '',
      }),
    );
  }

  getRoom(roomId: string, actorEmployeeId: string) {
    return this.call(
      this.service.GetRoom({ room_id: roomId, actor_employee_id: actorEmployeeId }),
    );
  }

  issueJoinToken(roomId: string, employeeId: string) {
    return this.call(
      this.service.IssueJoinToken({ room_id: roomId, employee_id: employeeId }),
    );
  }

  setRights(input: {
    roomId: string;
    targetEmployeeId: string;
    actorEmployeeId: string;
    action: string;
  }) {
    return this.call(
      this.service.SetParticipantRights({
        room_id: input.roomId,
        target_employee_id: input.targetEmployeeId,
        actor_employee_id: input.actorEmployeeId,
        action: input.action,
      }),
    );
  }

  endRoom(roomId: string, actorEmployeeId: string) {
    return this.call(
      this.service.EndRoom({ room_id: roomId, actor_employee_id: actorEmployeeId }),
    );
  }

  listActive(employeeIds: string[]) {
    return this.call(this.service.ListActiveRooms({ employee_ids: employeeIds }));
  }
}
