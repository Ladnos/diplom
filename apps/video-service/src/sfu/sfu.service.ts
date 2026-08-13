import { cpus } from 'node:os';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import * as mediasoup from 'mediasoup';
import type { types } from 'mediasoup';
import { VIDEO_CONFIG, type VideoConfig } from '../config';
import { MEDIA_CODECS } from './media-codecs';

/** Максимум комнат на одном воркере — грубая защита от перекоса нагрузки. */
const MAX_ROUTERS_PER_WORKER = 50;

export interface PeerTransport {
  transport: types.WebRtcTransport;
  producers: Map<string, types.Producer>;
  consumers: Map<string, types.Consumer>;
}

/**
 * Медиаплоскость: mediasoup SFU. docs/architecture.md §8.3
 *
 * ПОЧЕМУ SFU, А НЕ MESH. При mesh каждый участник отправляет N−1 копий
 * своего потока; уже на пятерых исходящий канал обычного рабочего места
 * перегружается. SFU принимает один поток и раздаёт его остальным —
 * нагрузка на клиента остаётся постоянной независимо от числа участников.
 *
 * ПОЧЕМУ ВООБЩЕ ОТДЕЛЬНЫЙ ПРОЦЕСС. mediasoup-worker — нативный процесс, и
 * медиа через него идут мимо Node: JavaScript участвует только в
 * управлении. Пакеты RTP не проходят через event loop, поэтому звонок не
 * заикается от того, что рядом кто-то запросил отчёт.
 *
 * Воркеров поднимается по числу ядер: один воркер — один поток, и весь
 * трафик его комнат обрабатывается на одном ядре. Роутер (комната)
 * целиком живёт внутри одного воркера — перенести его между воркерами
 * нельзя, поэтому распределение делается один раз при создании.
 */
@Injectable()
export class SfuService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SfuService.name);
  private readonly workers: types.Worker[] = [];
  private readonly routers = new Map<string, types.Router>();
  private readonly workerOfRouter = new Map<string, number>();
  private readonly loadByWorker: number[] = [];
  private nextWorker = 0;

  constructor(@Inject(VIDEO_CONFIG) private readonly config: VideoConfig) {}

  async onApplicationBootstrap(): Promise<void> {
    const count = this.config.workers > 0 ? this.config.workers : Math.max(1, cpus().length);

    // Диапазон портов делится между воркерами: они слушают UDP напрямую,
    // и пересечение диапазонов означало бы гонку за один порт при старте.
    const perWorker = Math.max(
      1,
      Math.floor((this.config.rtcMaxPort - this.config.rtcMinPort + 1) / count),
    );

    for (let index = 0; index < count; index += 1) {
      const minPort = this.config.rtcMinPort + index * perWorker;
      const maxPort = index === count - 1 ? this.config.rtcMaxPort : minPort + perWorker - 1;

      const worker = await mediasoup.createWorker({
        logLevel: 'warn',
        rtcMinPort: minPort,
        rtcMaxPort: maxPort,
      });

      // Падение воркера уносит все звонки на нём. Восстановить их
      // нельзя — состояние DTLS живёт в самом процессе, — но сервис
      // обязан об этом сказать, а не молча оставить клиентов ждать
      // пакетов, которых больше не будет.
      worker.on('died', () => {
        this.logger.error({
          message: 'воркер SFU умер: звонки на нём прерваны',
          pid: worker.pid,
        });
      });

      this.workers.push(worker);
      this.loadByWorker.push(0);
      this.logger.log({ message: 'воркер SFU поднят', pid: worker.pid, minPort, maxPort });
    }

    this.logger.log({
      message: 'медиаплоскость готова',
      workers: this.workers.length,
      announcedIp: this.config.announcedIp,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    for (const router of this.routers.values()) router.close();
    this.routers.clear();
    for (const worker of this.workers) worker.close();
  }

  /**
   * Роутер комнаты. Создаётся при первом входе, а не при создании
   * комнаты: приглашённых может быть десять, а войти — никто, и держать
   * ради этого ресурсы воркера незачем.
   */
  async routerFor(roomId: string): Promise<types.Router> {
    const existing = this.routers.get(roomId);
    if (existing && !existing.closed) return existing;

    const workerIndex = this.pickWorker();
    const router = await this.workers[workerIndex].createRouter({ mediaCodecs: MEDIA_CODECS });

    this.routers.set(roomId, router);
    this.workerOfRouter.set(roomId, workerIndex);
    this.loadByWorker[workerIndex] += 1;

    this.logger.debug({ message: 'роутер комнаты создан', roomId, worker: workerIndex });
    return router;
  }

  hasRouter(roomId: string): boolean {
    const router = this.routers.get(roomId);
    return router !== undefined && !router.closed;
  }

  /** Закрытие роутера обрывает все транспорты комнаты разом. */
  closeRoom(roomId: string): void {
    const router = this.routers.get(roomId);
    if (!router) return;

    router.close();
    this.routers.delete(roomId);

    const workerIndex = this.workerOfRouter.get(roomId);
    if (workerIndex !== undefined) {
      this.loadByWorker[workerIndex] = Math.max(0, this.loadByWorker[workerIndex] - 1);
      this.workerOfRouter.delete(roomId);
    }
    this.logger.debug({ message: 'роутер комнаты закрыт', roomId });
  }

  /**
   * Транспорт участника.
   *
   * listenIp — 0.0.0.0, announcedIp — публичный адрес. Разделение
   * обязательно: слушать нужно на всех интерфейсах контейнера, а
   * объявлять клиенту адрес, по которому до сервера действительно можно
   * достучаться. Объявишь адрес контейнера — ICE будет вечно в checking.
   */
  async createTransport(router: types.Router): Promise<types.WebRtcTransport> {
    return router.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp: this.config.announcedIp }],
      enableUdp: true,
      // TCP как запасной путь: в сетях, где UDP закрыт, без него звонок
      // не состоится вовсе. UDP предпочтительнее — отсюда preferUdp.
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1_000_000,
    });
  }

  stats(): { workers: number; rooms: number } {
    return { workers: this.workers.length, rooms: this.routers.size };
  }

  /**
   * Наименее загруженный воркер.
   *
   * Считаем комнаты, а не участников: перенести роутер между воркерами
   * потом нельзя, и решение принимается один раз — когда о будущем числе
   * участников ещё ничего не известно. Круговой перебор при равной
   * загрузке разводит комнаты по ядрам.
   */
  private pickWorker(): number {
    let best = 0;
    for (let index = 1; index < this.loadByWorker.length; index += 1) {
      if (this.loadByWorker[index] < this.loadByWorker[best]) best = index;
    }

    if (this.loadByWorker[best] >= MAX_ROUTERS_PER_WORKER) {
      this.logger.warn({
        message: 'воркеры SFU перегружены комнатами',
        routersPerWorker: this.loadByWorker[best],
      });
    }

    if (this.loadByWorker.every((load) => load === this.loadByWorker[best])) {
      best = this.nextWorker % this.workers.length;
      this.nextWorker += 1;
    }
    return best;
  }
}
