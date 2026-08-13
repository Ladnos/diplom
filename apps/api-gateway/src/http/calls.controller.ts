import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { VideoClient, type JoinTokenDto, type RoomDto } from '../clients/video.client';
import { HrClient } from '../clients/hr.client';
import type { AuthenticatedUser } from '../auth/auth.guard';
import { CurrentUser, RequirePermission } from '../auth/permission.guard';
import { CreateCallDto, ModerateCallDto } from './dto';

/**
 * Видеозвонки.
 *
 * Шлюз участвует только в управлении: завести комнату, выдать пропуск,
 * завершить. Дальше клиент открывает сигналинг прямым соединением на
 * `/signaling`, а медиапоток идёт до SFU по UDP, минуя и nginx, и Node
 * (§8.3). Проксировать здесь нечего — и не нужно: лишнее звено добавляло
 * бы задержку в разговор.
 */
@Controller('api/calls')
export class CallsController {
  constructor(
    private readonly video: VideoClient,
    private readonly hr: HrClient,
  ) {}

  /**
   * Начать звонок.
   *
   * Ответ сразу содержит пропуск инициатора: он и есть тот, кто звонит, и
   * заставлять его вторым запросом просить право войти в собственный
   * звонок — лишний круг ожидания там, где человек уже нажал «позвонить».
   */
  @Post()
  @RequirePermission({ resource: 'call', action: 'write' })
  async create(@Body() dto: CreateCallDto, @CurrentUser() user: AuthenticatedUser) {
    const employeeId = requireEmployee(user);
    const room = await this.video.createRoom({
      title: dto.title ?? 'Звонок',
      initiatorEmployeeId: employeeId,
      invitedEmployeeIds: dto.invitedEmployeeIds,
      channelId: dto.channelId,
      cardId: dto.cardId,
    });

    const join = await this.video.issueJoinToken(room.room_id, employeeId);
    return {
      ...(await this.toPublicRoom(room)),
      join: toPublicJoin(join),
    };
  }

  /** Активные звонки — чтобы интерфейс показал «вас зовут». */
  @Get('active')
  @RequirePermission({ resource: 'call', action: 'read' })
  async active(@CurrentUser() user: AuthenticatedUser) {
    const employeeId = requireEmployee(user);
    const result = await this.video.listActive([employeeId]);
    return { calls: await Promise.all(result.rooms.map((room) => this.toPublicRoom(room))) };
  }

  @Get(':id')
  @RequirePermission({ resource: 'call', action: 'read' })
  async getOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    const room = await this.video.getRoom(id, requireEmployee(user));
    return this.toPublicRoom(room);
  }

  /**
   * Пропуск в звонок.
   *
   * Отдельным запросом, а не вместе с комнатой: пропуск живёт минуту, и
   * выданный при открытии списка звонков к моменту нажатия «войти» уже
   * протухнет.
   */
  @Post(':id/join')
  @HttpCode(200)
  @RequirePermission({ resource: 'call', action: 'read' })
  async join(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    const join = await this.video.issueJoinToken(id, requireEmployee(user));
    return toPublicJoin(join);
  }

  @Post(':id/end')
  @HttpCode(200)
  @RequirePermission({ resource: 'call', action: 'write' })
  async end(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.video.endRoom(id, requireEmployee(user));
    return { ended: true };
  }

  /** Выключить микрофон участнику или передать права модератора. */
  @Post(':id/moderate')
  @HttpCode(200)
  @RequirePermission({ resource: 'call', action: 'write' })
  async moderate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModerateCallDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.video.setRights({
      roomId: id,
      targetEmployeeId: dto.employeeId,
      actorEmployeeId: requireEmployee(user),
      action: dto.action,
    });
    return { ok: true };
  }

  private async toPublicRoom(room: RoomDto) {
    const names = await this.resolveNames(room.participants.map((item) => item.employee_id));
    return {
      roomId: room.room_id,
      title: room.title,
      status: room.status,
      channelId: room.channel_id || null,
      initiatorEmployeeId: room.initiator_employee_id,
      recording: room.recording,
      participants: room.participants.map((item) => ({
        employeeId: item.employee_id,
        fullName: names.get(item.employee_id) ?? null,
        isModerator: item.is_moderator,
        audioEnabled: item.audio_enabled,
        videoEnabled: item.video_enabled,
        // Вошёл и не выходил — значит сейчас в разговоре.
        inCall: Number(item.joined_at) > 0 && Number(item.left_at) === 0,
      })),
      startedAt: new Date(Number(room.started_at)).toISOString(),
      endedAt: Number(room.ended_at) ? new Date(Number(room.ended_at)).toISOString() : null,
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

function toPublicJoin(join: JoinTokenDto) {
  return {
    token: join.token,
    signalingUrl: join.signaling_url,
    // ICE-серверы отдаются клиенту как есть: их формат задан WebRTC, и
    // переименование полей заставило бы клиента собирать объект обратно.
    iceServers: join.ice_servers.map((server) => ({
      urls: server.urls,
      ...(server.username ? { username: server.username, credential: server.credential } : {}),
    })),
    expiresAt: new Date(Number(join.expires_at)).toISOString(),
  };
}

function requireEmployee(user: AuthenticatedUser): string {
  if (!user.employeeId) {
    throw new BadRequestException('у учётной записи нет карточки сотрудника');
  }
  return user.employeeId;
}
