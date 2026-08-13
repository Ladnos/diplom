import { Device } from 'mediasoup-client';
import type { types } from 'mediasoup-client';
import { io, type Socket } from 'socket.io-client';
import { ref, shallowRef } from 'vue';
import type { JoinTicket } from '~/types/api';

export interface RemoteStream {
  employeeId: string;
  stream: MediaStream;
  hasVideo: boolean;
}

/**
 * Клиентская сторона звонка. docs/architecture.md §8.3
 *
 * Соединение сигналинга открывается НАПРЯМУЮ к video-service, минуя
 * api-gateway: установление медиасоединения — это несколько кругов
 * обмена, и лишнее звено добавляет их все. Пропуск получен заранее
 * обычным запросом через шлюз, здесь он только предъявляется.
 *
 * Порядок обязателен и задан протоколом mediasoup:
 *   1. дождаться `joined` с возможностями роутера;
 *   2. загрузить их в Device — он вычислит пересечение с тем, что умеет
 *      этот браузер;
 *   3. создать транспорты (исходящий и входящий — раздельно);
 *   4. отдать свой поток и подписаться на чужие.
 *
 * Шаг 2 нельзя пропустить: без возможностей роутера Device не знает, во
 * что кодировать, и produce() бросит исключение.
 */
export function useCall() {
  const socket = shallowRef<Socket | null>(null);
  const device = shallowRef<Device | null>(null);
  const sendTransport = shallowRef<types.Transport | null>(null);
  const recvTransport = shallowRef<types.Transport | null>(null);

  const localStream = shallowRef<MediaStream | null>(null);
  const remotes = ref<RemoteStream[]>([]);
  const participants = ref<Record<string, unknown>[]>([]);
  const speaking = ref<Set<string>>(new Set());
  const connected = ref(false);
  const audioEnabled = ref(true);
  const videoEnabled = ref(true);
  const failure = ref('');

  /** Ответ сервера приходит подтверждением команды — оборачиваем в промис. */
  function ask<T>(event: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!socket.value) return reject(new Error('нет соединения сигналинга'));
      socket.value.emit(event, payload, (response: T & { error?: string }) => {
        if (response?.error) reject(new Error(response.error));
        else resolve(response);
      });
    });
  }

  async function join(ticket: JoinTicket, options: { video: boolean }) {
    failure.value = '';

    const origin = window.location.origin;
    const instance = io(origin, {
      path: '/signaling',
      transports: ['websocket'],
      auth: { token: ticket.token },
      reconnection: false,
    });
    socket.value = instance;

    instance.on('rejected', (payload: { reason?: string }) => {
      failure.value = payload?.reason ?? 'вход в звонок отклонён';
      leave();
    });

    instance.on('peerLeft', (payload: { employeeId: string }) => {
      remotes.value = remotes.value.filter((item) => item.employeeId !== payload.employeeId);
    });

    instance.on('speaking', (payload: { employeeId: string }) => {
      speaking.value.add(payload.employeeId);
      speaking.value = new Set(speaking.value);
      // Индикатор гаснет сам: события об окончании речи не бывает
      setTimeout(() => {
        speaking.value.delete(payload.employeeId);
        speaking.value = new Set(speaking.value);
      }, 1200);
    });

    instance.on('kicked', () => {
      failure.value = 'вас исключили из звонка';
      leave();
    });

    const joined = await new Promise<{
      rtpCapabilities: types.RtpCapabilities;
      participants: Record<string, unknown>[];
      producers: { producerId: string; employeeId: string; kind: string }[];
    }>((resolve, reject) => {
      instance.once('joined', resolve);
      instance.once('connect_error', (caught: Error) => reject(caught));
      setTimeout(() => reject(new Error('сигналинг не ответил')), 10_000);
    });

    participants.value = joined.participants;

    const mediasoupDevice = new Device();
    await mediasoupDevice.load({ routerRtpCapabilities: joined.rtpCapabilities });
    device.value = mediasoupDevice;

    await createSendTransport(ticket);
    await createRecvTransport();
    await publish(options.video);

    // Уже идущие потоки: без них вошедший позже видел бы чёрные квадраты
    // вместо тех, кто включил камеру до него
    for (const producer of joined.producers) await consume(producer.producerId, producer.employeeId);

    instance.on('newProducer', (payload: { producerId: string; employeeId: string }) => {
      void consume(payload.producerId, payload.employeeId);
    });

    connected.value = true;
  }

  async function createSendTransport(ticket: JoinTicket) {
    const params = await ask<types.TransportOptions>('createTransport', { direction: 'send' });
    const transport = device.value!.createSendTransport({
      ...params,
      iceServers: ticket.iceServers,
    });

    // connect срабатывает один раз, когда браузер готов подтвердить DTLS
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      ask('connectTransport', { transportId: transport.id, dtlsParameters })
        .then(() => callback())
        .catch(errback);
    });

    // produce — когда мы отдаём первый поток: сервер возвращает его id
    transport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
      ask<{ id: string }>('produce', { transportId: transport.id, kind, rtpParameters })
        .then((response) => callback({ id: response.id }))
        .catch(errback);
    });

    sendTransport.value = transport;
  }

  async function createRecvTransport() {
    const params = await ask<types.TransportOptions>('createTransport', { direction: 'recv' });
    const transport = device.value!.createRecvTransport(params);

    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      ask('connectTransport', { transportId: transport.id, dtlsParameters })
        .then(() => callback())
        .catch(errback);
    });

    recvTransport.value = transport;
  }

  async function publish(withVideo: boolean) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: withVideo ? { width: 1280, height: 720 } : false,
    });
    localStream.value = stream;

    for (const track of stream.getTracks()) {
      await sendTransport.value!.produce({ track });
    }
    videoEnabled.value = withVideo;
  }

  async function consume(producerId: string, employeeId: string) {
    if (!device.value || !recvTransport.value) return;

    const params = await ask<types.ConsumerOptions & { employeeId?: string }>('consume', {
      producerId,
      rtpCapabilities: device.value.rtpCapabilities,
    }).catch(() => null);
    if (!params) return;

    const consumer = await recvTransport.value.consume(params);
    // Consumer создан приостановленным, чтобы пакеты не пошли раньше,
    // чем готов декодер: включаем явно
    await ask('resumeConsumer', { consumerId: consumer.id });

    const owner = params.employeeId ?? employeeId;
    const existing = remotes.value.find((item) => item.employeeId === owner);

    if (existing) {
      existing.stream.addTrack(consumer.track);
      existing.hasVideo ||= consumer.kind === 'video';
      remotes.value = [...remotes.value];
      return;
    }

    remotes.value = [
      ...remotes.value,
      {
        employeeId: owner,
        stream: new MediaStream([consumer.track]),
        hasVideo: consumer.kind === 'video',
      },
    ];
  }

  /**
   * Микрофон и камера выключаются приостановкой дорожки, а поток при
   * этом не пересоздаётся: новый ICE и DTLS на каждое нажатие кнопки
   * означали бы секунды тишины вместо мгновенного отклика.
   */
  function toggle(kind: 'audio' | 'video') {
    const tracks =
      kind === 'audio' ? localStream.value?.getAudioTracks() : localStream.value?.getVideoTracks();
    if (!tracks?.length) return;

    const enabled = !tracks[0].enabled;
    for (const track of tracks) track.enabled = enabled;

    if (kind === 'audio') audioEnabled.value = enabled;
    else videoEnabled.value = enabled;

    socket.value?.emit('toggleMedia', { kind, enabled });
  }

  function moderate(targetEmployeeId: string, action: 'MUTE' | 'KICK' | 'GRANT_MODERATOR') {
    socket.value?.emit('moderate', { targetEmployeeId, action });
  }

  function leave() {
    for (const track of localStream.value?.getTracks() ?? []) track.stop();
    sendTransport.value?.close();
    recvTransport.value?.close();
    socket.value?.close();

    socket.value = null;
    device.value = null;
    sendTransport.value = null;
    recvTransport.value = null;
    localStream.value = null;
    remotes.value = [];
    connected.value = false;
  }

  return {
    join,
    leave,
    toggle,
    moderate,
    localStream,
    remotes,
    participants,
    speaking,
    connected,
    audioEnabled,
    videoEnabled,
    failure,
  };
}
