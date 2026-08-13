import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { FileEvents, type StorageLow } from '@crm/contracts';
import { EventPublisher } from '@crm/messaging';
import { PrismaService } from '../prisma/prisma.service';
import { outboxRow } from '../prisma/outbox.store';
import { FILE_CONFIG, type FileConfig } from '../config';
import { StorageService } from '../storage/storage.service';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GcReport {
  removedMetas: number;
  removedObjects: number;
  removedTemporary: number;
  freedBytes: number;
}

/**
 * Обслуживание хранилища: сборка мусора и контроль места. §9.5
 *
 * Обе задачи запускаются и по расписанию внутри сервиса, и командой
 * `file.gc.run` извне. Внутренний таймер нужен потому, что в self-hosted
 * установке внешнего планировщика может не быть вовсе, а диск кончается
 * независимо от того, настроил ли кто-то cron.
 */
@Injectable()
export class MaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private static readonly GC_INTERVAL_MS = 6 * 60 * 60 * 1000;
  private static readonly DISK_INTERVAL_MS = 5 * 60 * 1000;
  /** Не чаще раза в сутки: предупреждение о диске не должно превращаться в шум. */
  private static readonly DISK_ALERT_COOLDOWN_MS = DAY_MS;
  /** Недописанные загрузки старше суток — точно брошенные. */
  private static readonly TMP_TTL_MS = DAY_MS;

  private readonly logger = new Logger(MaintenanceService.name);
  private timers: NodeJS.Timeout[] = [];
  private lastDiskAlertAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly publisher: EventPublisher,
    @Inject(FILE_CONFIG) private readonly config: FileConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.timers.push(setInterval(() => void this.collect(), MaintenanceService.GC_INTERVAL_MS));
    this.timers.push(
      setInterval(() => void this.checkDisk(), MaintenanceService.DISK_INTERVAL_MS),
    );
    for (const timer of this.timers) timer.unref();

    // Первая проверка места сразу после старта: если диск уже кончился,
    // узнать об этом через пять минут — поздно.
    void this.checkDisk();
  }

  onApplicationShutdown(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  /**
   * Сборка мусора.
   *
   * Удаляются загрузки с нулевым счётчиком ссылок старше отсрочки, а
   * следом — содержимое, на которое не ссылается ни одна загрузка.
   *
   * ОТСРОЧКА ОБЯЗАТЕЛЬНА. Между загрузкой файла и его привязкой к
   * сообщению проходит время: пользователь прикрепил файл, потом писал
   * текст, потом отправил. Немедленная уборка стирала бы файл прямо между
   * двумя действиями одного человека. Семь суток — это запас, а не
   * точность: цена ошибки в одну сторону — потерянный файл, в другую —
   * несколько лишних мегабайт на неделю.
   */
  async collect(): Promise<GcReport> {
    const deadline = new Date(Date.now() - this.config.gcGraceDays * DAY_MS);

    const abandoned = await this.prisma.fileMeta.findMany({
      where: { refcount: { lte: 0 }, createdAt: { lt: deadline } },
      select: { id: true, sha256: true, sizeBytes: true },
    });

    let removedMetas = 0;
    if (abandoned.length > 0) {
      const result = await this.prisma.fileMeta.deleteMany({
        where: { id: { in: abandoned.map((item) => item.id) } },
      });
      removedMetas = result.count;
    }

    // Содержимое удаляется отдельным шагом и только то, на которое никто
    // не ссылается: тот же файл мог быть загружен кем-то ещё, и его
    // байты обязаны пережить уборку чужой копии.
    const orphans = await this.prisma.fileObject.findMany({
      where: { metas: { none: {} } },
      select: { sha256: true, sizeBytes: true, thumbPath: true },
    });

    let freedBytes = 0;
    for (const orphan of orphans) {
      await this.storage.remove(orphan.sha256);
      if (orphan.thumbPath) await this.storage.removeThumb(orphan.thumbPath);
      freedBytes += orphan.sizeBytes;
    }
    if (orphans.length > 0) {
      await this.prisma.fileObject.deleteMany({
        where: { sha256: { in: orphans.map((item) => item.sha256) } },
      });
    }

    const removedTemporary = await this.storage.sweepTemporary(MaintenanceService.TMP_TTL_MS);

    const report: GcReport = {
      removedMetas,
      removedObjects: orphans.length,
      removedTemporary,
      freedBytes,
    };

    if (removedMetas + orphans.length + removedTemporary > 0) {
      this.logger.log({ message: 'сборка мусора завершена', ...report });
    }
    return report;
  }

  /**
   * Свободное место.
   *
   * Специфика self-hosted: диск конечен, и никто не расширит его
   * автоматически. Предупреждение уходит событием администратору, а не
   * только в журнал: журнал читают после аварии, а событие приходит до.
   */
  async checkDisk(): Promise<void> {
    const usage = await this.storage.diskUsage().catch((error: unknown) => {
      this.logger.warn({
        message: 'не удалось узнать занятость диска',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (!usage) return;

    if (usage.usedRatio < this.config.diskAlertThreshold) {
      // Место освободилось — следующее превышение сообщим сразу, не
      // дожидаясь истечения паузы.
      this.lastDiskAlertAt = 0;
      return;
    }

    if (Date.now() - this.lastDiskAlertAt < MaintenanceService.DISK_ALERT_COOLDOWN_MS) return;
    this.lastDiskAlertAt = Date.now();

    const envelope = this.publisher.wrap<StorageLow>(FileEvents.STORAGE_LOW, {
      freeBytes: usage.freeBytes,
      totalBytes: usage.totalBytes,
      usedRatio: Number(usage.usedRatio.toFixed(4)),
    });
    await this.prisma.outbox.create({ data: outboxRow(envelope) });

    this.logger.warn({
      message: 'мало места в хранилище',
      usedRatio: usage.usedRatio,
      freeBytes: usage.freeBytes,
    });
  }
}
