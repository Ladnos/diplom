import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { types } from 'mediasoup';
import { RoomService } from '../rooms/room.service';
import { JoinTokenService } from '../rooms/join-token.service';
import { SfuService } from '../sfu/sfu.service';

/** Транспорты и потоки одного соединения. */
interface Peer {
  roomId: string;
  employeeId: string;
  send?: types.WebRtcTransport;
  recv?: types.WebRtcTransport;
  producers: Map<string, types.Producer>;
  consumers: Map<string, types.Consumer>;
}

/**
 * Сигналинг звонков. docs/architecture.md §8.3
 *
 * ПРЯМОЕ СОЕДИНЕНИЕ, МИНУЯ api-gateway. Сигналинг stateful — за ним стоят
 * транспорты конкретного воркера SFU — и чувствителен к задержке:
 * установление соединения это несколько кругов обмена, и лишнее звено
 * добавляет их все. Шлюз проксировал бы сообщения между клиентом и
 * воркером, ничего к ним не добавляя, но привязывая клиента к своему
 * инстансу поверх привязки к воркеру.
 *
 * Право войти проверено ДО открытия соединения: gateway убедился, что
 * человек участник звонка, и попросил пропуск. Здесь остаётся проверить
 * подпись пропуска — локально, без обращения к auth-service.
 *
 * Комнаты Socket.IO используются как список рассылки внутри звонка. Это
 * не те комнаты, что в api-gateway: там они про подписку на события
 * системы, здесь — про участников одного разговора.
 */
@WebSocketGateway({
  path: '/signaling',
  serveClient: false,
  cors: { origin: process.env.WS_CORS_ORIGIN ?? false, credentials: true },
})
export class SignalingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(SignalingGateway.name);
  private readonly peers = new Map<string, Peer>();

  @WebSocketServer()
  private readonly server!: Server;

  constructor(
    private readonly rooms: RoomService,
    private readonly tokens: JoinTokenService,
    private readonly sfu: SfuService,
  ) {}

  // ── Жизненный цикл ──────────────────────────────────────────────────────

  async handleConnection(socket: Socket): Promise<void> {
    const token = extractToken(socket);
    const claims = token ? this.tokens.verify(token) : null;
    if (!claims) {
      socket.emit('rejected', { reason: 'пропуск недействителен или истёк' });
      socket.disconnect(true);
      return;
    }

    try {
      await this.rooms.join(claims.roomId, claims.employeeId);
    } catch (error) {
      socket.emit('rejected', {
        reason: error instanceof Error ? error.message : 'войти в звонок не удалось',
      });
      socket.disconnect(true);
      return;
    }

    const peer: Peer = {
      roomId: claims.roomId,
      employeeId: claims.employeeId,
      producers: new Map(),
      consumers: new Map(),
    };
    this.peers.set(socket.id, peer);
    await socket.join(claims.roomId);

    const room = await this.rooms.getRoom(claims.roomId);
    const router = await this.sfu.routerFor(claims.roomId);

    // Вошедший получает и возможности роутера, и список уже идущих
    // потоков: без второго он увидел бы только тех, кто включит камеру
    // ПОСЛЕ него, а остальные остались бы для него чёрными квадратами.
    socket.emit('joined', {
      roomId: claims.roomId,
      employeeId: claims.employeeId,
      rtpCapabilities: router.rtpCapabilities,
      participants: room.participants.map((item) => ({
        employeeId: item.employeeId,
        isModerator: item.isModerator,
        audioEnabled: item.audioEnabled,
        videoEnabled: item.videoEnabled,
        inCall: item.joinedAt !== null && item.leftAt === null,
      })),
      producers: this.existingProducers(claims.roomId, socket.id),
    });

    socket.to(claims.roomId).emit('peerJoined', { employeeId: claims.employeeId });
    this.logger.debug({
      message: 'участник вошёл в звонок',
      roomId: claims.roomId,
      employeeId: claims.employeeId,
    });
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    const peer = this.peers.get(socket.id);
    if (!peer) return;

    this.peers.delete(socket.id);
    // Закрытие транспорта закрывает и все его producer'ы с consumer'ами:
    // перебирать их вручную незачем, а забыть — легко.
    peer.send?.close();
    peer.recv?.close();

    socket.to(peer.roomId).emit('peerLeft', { employeeId: peer.employeeId });

    const wasLast = await this.rooms.leave(peer.roomId, peer.employeeId);
    if (wasLast) {
      // Последний вышел — звонка больше нет. Роутер закрывается сразу:
      // держать воркер занятым ради пустой комнаты нечем оправдать.
      await this.rooms.endRoom(peer.roomId);
      this.sfu.closeRoom(peer.roomId);
    }
  }

  // ── Установление медиасоединения ────────────────────────────────────────

  /**
   * Транспорт для отправки или приёма.
   *
   * Их два, а не один, потому что направления независимы: клиент может
   * только смотреть, ничего не отправляя, и создавать ему исходящий
   * транспорт в этом случае — держать ICE-соединение, по которому ничего
   * не пойдёт.
   */
  @SubscribeMessage('createTransport')
  async createTransport(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { direction?: string },
  ) {
    const peer = this.peers.get(socket.id);
    if (!peer) return { error: 'соединение без пропуска' };

    const direction = body?.direction === 'send' ? 'send' : 'recv';
    const router = await this.sfu.routerFor(peer.roomId);
    const transport = await this.sfu.createTransport(router);

    if (direction === 'send') peer.send = transport;
    else peer.recv = transport;

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  /**
   * Подтверждение DTLS.
   *
   * Отпечаток сертификата приходит от клиента: именно он делает
   * медиапоток шифрованным между конкретными сторонами, а не просто
   * шифрованным.
   */
  @SubscribeMessage('connectTransport')
  async connectTransport(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { transportId?: string; dtlsParameters?: types.DtlsParameters },
  ) {
    const peer = this.peers.get(socket.id);
    if (!peer || !body?.dtlsParameters) return { error: 'нет данных для подключения' };

    const transport = this.transportById(peer, body.transportId);
    if (!transport) return { error: 'транспорт не найден' };

    await transport.connect({ dtlsParameters: body.dtlsParameters });
    return { ok: true };
  }

  /** Клиент начал отдавать поток — остальные должны его получить. */
  @SubscribeMessage('produce')
  async produce(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    body: { transportId?: string; kind?: types.MediaKind; rtpParameters?: types.RtpParameters },
  ) {
    const peer = this.peers.get(socket.id);
    if (!peer || !peer.send || !body?.kind || !body.rtpParameters) {
      return { error: 'нет исходящего транспорта или параметров потока' };
    }

    const producer = await peer.send.produce({
      kind: body.kind,
      rtpParameters: body.rtpParameters,
      appData: { employeeId: peer.employeeId },
    });
    peer.producers.set(producer.id, producer);

    producer.on('transportclose', () => {
      peer.producers.delete(producer.id);
    });

    socket.to(peer.roomId).emit('newProducer', {
      producerId: producer.id,
      employeeId: peer.employeeId,
      kind: producer.kind,
    });

    return { id: producer.id };
  }

  /**
   * Подписка на чужой поток.
   *
   * Consumer создаётся ПРИОСТАНОВЛЕННЫМ и включается отдельной командой.
   * Иначе пакеты пойдут раньше, чем клиент успеет разобрать ответ и
   * подготовить декодер, — и начало чужой речи потеряется. Это штатная
   * рекомендация mediasoup, а не перестраховка.
   */
  @SubscribeMessage('consume')
  async consume(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    body: { producerId?: string; rtpCapabilities?: types.RtpCapabilities },
  ) {
    const peer = this.peers.get(socket.id);
    if (!peer || !peer.recv || !body?.producerId || !body.rtpCapabilities) {
      return { error: 'нет входящего транспорта или возможностей клиента' };
    }

    const router = await this.sfu.routerFor(peer.roomId);
    if (!router.canConsume({ producerId: body.producerId, rtpCapabilities: body.rtpCapabilities })) {
      // Пересечение кодеков пусто: клиент не умеет того, что отдаёт
      // отправитель. Это не ошибка сервера, а несовместимость устройств.
      return { error: 'клиент не поддерживает кодек этого потока' };
    }

    // Автора потока приходится искать по владельцу producer'а: appData
    // consumer'а — это appData, переданный ЕМУ, а не унаследованный от
    // producer'а. Без явной передачи клиент получил бы подписку, не зная,
    // чей это голос, и не смог бы подписать окно участника.
    const ownerEmployeeId = this.ownerOfProducer(peer.roomId, body.producerId);

    const consumer = await peer.recv.consume({
      producerId: body.producerId,
      rtpCapabilities: body.rtpCapabilities,
      paused: true,
      appData: { employeeId: ownerEmployeeId },
    });
    peer.consumers.set(consumer.id, consumer);

    consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
    consumer.on('producerclose', () => {
      peer.consumers.delete(consumer.id);
      socket.emit('producerClosed', { consumerId: consumer.id });
    });

    return {
      id: consumer.id,
      producerId: consumer.producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      employeeId: ownerEmployeeId,
    };
  }

  @SubscribeMessage('resumeConsumer')
  async resumeConsumer(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { consumerId?: string },
  ) {
    const peer = this.peers.get(socket.id);
    const consumer = body?.consumerId ? peer?.consumers.get(body.consumerId) : undefined;
    if (!consumer) return { error: 'подписка не найдена' };

    await consumer.resume();
    return { ok: true };
  }

  // ── Управление внутри звонка ────────────────────────────────────────────

  /**
   * Включение и выключение микрофона или камеры.
   *
   * Поток не пересоздаётся — он приостанавливается на стороне SFU.
   * Пересоздание означало бы новый ICE и новый DTLS на каждое нажатие
   * кнопки «выключить микрофон», то есть секунды тишины вместо
   * мгновенного отклика.
   */
  @SubscribeMessage('toggleMedia')
  async toggleMedia(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { kind?: string; enabled?: boolean },
  ) {
    const peer = this.peers.get(socket.id);
    if (!peer || (body?.kind !== 'audio' && body?.kind !== 'video')) {
      return { error: 'не указан вид потока' };
    }
    const enabled = body.enabled !== false;

    for (const producer of peer.producers.values()) {
      if (producer.kind !== body.kind) continue;
      if (enabled) await producer.resume();
      else await producer.pause();
    }

    await this.rooms.setMediaState(peer.roomId, peer.employeeId, {
      ...(body.kind === 'audio' ? { audioEnabled: enabled } : { videoEnabled: enabled }),
    });

    this.server.to(peer.roomId).emit('mediaToggled', {
      employeeId: peer.employeeId,
      kind: body.kind,
      enabled,
    });
    return { ok: true };
  }

  /**
   * Модератор выключает микрофон другому или выгоняет из звонка.
   *
   * Право проверяется здесь, а не на клиенте: кнопку можно нарисовать
   * кому угодно, а выключить чужой микрофон должен только тот, кому это
   * позволено.
   */
  @SubscribeMessage('moderate')
  async moderate(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { targetEmployeeId?: string; action?: string },
  ) {
    const peer = this.peers.get(socket.id);
    if (!peer || !body?.targetEmployeeId) return { error: 'не указан участник' };

    try {
      await this.rooms.assertModerator(peer.roomId, peer.employeeId);
    } catch {
      return { error: 'действие доступно модератору звонка' };
    }

    const targetSocketId = this.socketOf(peer.roomId, body.targetEmployeeId);
    if (!targetSocketId) return { error: 'участник не в звонке' };
    const target = this.peers.get(targetSocketId)!;

    switch (body.action) {
      case 'MUTE': {
        for (const producer of target.producers.values()) {
          if (producer.kind === 'audio') await producer.pause();
        }
        await this.rooms.setMediaState(peer.roomId, target.employeeId, { audioEnabled: false });
        this.server.to(peer.roomId).emit('mediaToggled', {
          employeeId: target.employeeId,
          kind: 'audio',
          enabled: false,
          byModerator: true,
        });
        return { ok: true };
      }

      case 'KICK': {
        this.server.sockets.sockets.get(targetSocketId)?.emit('kicked', {
          by: peer.employeeId,
        });
        this.server.sockets.sockets.get(targetSocketId)?.disconnect(true);
        return { ok: true };
      }

      case 'GRANT_MODERATOR': {
        await this.rooms.grantModerator(peer.roomId, target.employeeId);
        this.server.to(peer.roomId).emit('moderatorGranted', {
          employeeId: target.employeeId,
        });
        return { ok: true };
      }

      default:
        return { error: 'неизвестное действие' };
    }
  }

  /**
   * Индикатор говорящего.
   *
   * Живёт доли секунды и обязан теряться при сбое — тот же класс
   * сигналов, что «печатает» в чате (§5). Здесь он даже не выходит за
   * пределы инстанса: все участники одной комнаты подключены к одному
   * воркеру, а значит и к одному процессу.
   */
  @SubscribeMessage('speaking')
  speaking(@ConnectedSocket() socket: Socket, @MessageBody() body: { level?: number }) {
    const peer = this.peers.get(socket.id);
    if (!peer) return { ok: false };

    socket.to(peer.roomId).emit('speaking', {
      employeeId: peer.employeeId,
      level: typeof body?.level === 'number' ? body.level : 0,
    });
    return { ok: true };
  }

  /** Сколько соединений держит инстанс — для диагностики. */
  connections(): number {
    return this.peers.size;
  }

  // ── Внутреннее ──────────────────────────────────────────────────────────

  private transportById(peer: Peer, transportId?: string): types.WebRtcTransport | undefined {
    if (peer.send?.id === transportId) return peer.send;
    if (peer.recv?.id === transportId) return peer.recv;
    return undefined;
  }

  private socketOf(roomId: string, employeeId: string): string | undefined {
    for (const [socketId, peer] of this.peers) {
      if (peer.roomId === roomId && peer.employeeId === employeeId) return socketId;
    }
    return undefined;
  }

  /** Кому принадлежит поток. Пусто — поток уже закрыт. */
  private ownerOfProducer(roomId: string, producerId: string): string {
    for (const peer of this.peers.values()) {
      if (peer.roomId !== roomId) continue;
      if (peer.producers.has(producerId)) return peer.employeeId;
    }
    return '';
  }

  /** Потоки, уже идущие в комнате, — кроме собственных. */
  private existingProducers(roomId: string, exceptSocketId: string) {
    const result: { producerId: string; employeeId: string; kind: string }[] = [];

    for (const [socketId, peer] of this.peers) {
      if (peer.roomId !== roomId || socketId === exceptSocketId) continue;
      for (const producer of peer.producers.values()) {
        result.push({
          producerId: producer.id,
          employeeId: peer.employeeId,
          kind: producer.kind,
        });
      }
    }
    return result;
  }
}

/**
 * Пропуск при рукопожатии.
 *
 * Строка запроса поддержана наравне с auth: медиаклиенты нередко
 * открывают соединение библиотекой, не позволяющей задать произвольные
 * поля рукопожатия. Пропуск живёт минуту, поэтому попадание его в логи
 * прокси менее опасно, чем у долгоживущего access-токена.
 */
function extractToken(socket: Socket): string | null {
  const fromAuth = (socket.handshake.auth as Record<string, unknown> | undefined)?.token;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;

  const fromQuery = socket.handshake.query?.token;
  return typeof fromQuery === 'string' && fromQuery.length > 0 ? fromQuery : null;
}
