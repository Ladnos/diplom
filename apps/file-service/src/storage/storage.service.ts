import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { FILE_CONFIG, type FileConfig } from '../config';

/** Файл больше разрешённого — поток обрывается, не дочитывая до конца. */
export class UploadTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`файл больше разрешённых ${limitBytes} байт`);
  }
}

export interface StoredObject {
  sha256: string;
  sizeBytes: number;
  /** true, если содержимое уже лежало на диске и загрузка переиспользовала его. */
  deduplicated: boolean;
}

/**
 * Раскладка файлов на диске. docs/architecture.md §9.1
 *
 * ```
 * /data/files/
 * ├── objects/ab/cd/abcdef0123…   содержимое, адресуемое хэшем
 * ├── thumbs/ab/cd/abcdef…-256.webp
 * └── tmp/<uuid>                  незавершённые загрузки
 * ```
 *
 * Два уровня шардирования по первым четырём символам хэша дают не больше
 * нескольких тысяч файлов в каталоге при сотнях тысяч объектов. Без них
 * `readdir` на ext4 деградирует, а вместе с ним — всё, что перебирает
 * каталог: бэкап, сверка целостности, сборка мусора.
 */
@Injectable()
export class StorageService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorageService.name);

  constructor(@Inject(FILE_CONFIG) private readonly config: FileConfig) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const dir of [this.objectsRoot, this.thumbsRoot, this.tmpRoot]) {
      await mkdir(dir, { recursive: true });
    }
    this.logger.log({ message: 'хранилище готово', path: this.config.storagePath });
  }

  get objectsRoot(): string {
    return join(this.config.storagePath, 'objects');
  }

  get thumbsRoot(): string {
    return join(this.config.storagePath, 'thumbs');
  }

  get tmpRoot(): string {
    return join(this.config.storagePath, 'tmp');
  }

  /** Относительный путь объекта: ab/cd/abcdef… — он же суффикс URL для nginx. */
  relativePath(sha256: string): string {
    return join(sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  absolutePath(sha256: string): string {
    return join(this.objectsRoot, this.relativePath(sha256));
  }

  /**
   * Принять поток и уложить его в хранилище.
   *
   * Ни nginx, ни Node не держат тело в памяти: байты идут из сокета в
   * файл, а sha256 считается тем же проходом. Файл на пятьдесят мегабайт
   * не занимает пятидесяти мегабайт памяти и не блокирует event loop.
   *
   * Сначала запись во временный каталог, потом rename(2) в objects/ —
   * атомарная операция в пределах одной файловой системы. Обратный
   * порядок (писать сразу по конечному пути) оставлял бы после обрыва
   * связи полуфайл, неотличимый от целого: имя-то выводится из хэша,
   * которого при обрыве ещё нет.
   */
  async store(source: Readable): Promise<StoredObject> {
    const limit = this.config.maxUploadBytes;
    const tmpPath = join(this.tmpRoot, randomUUID());
    const hash = createHash('sha256');
    let sizeBytes = 0;

    try {
      await pipeline(
        source,
        async function* measure(chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            sizeBytes += chunk.length;
            if (sizeBytes > limit) {
              // Ошибка внутри pipeline рвёт всю цепочку: чтение
              // прекращается, поток записи закрывается. Дочитывать до
              // конца, чтобы «вежливо» отказать, означало бы принять на
              // диск ровно то, что мы заведомо не примем.
              throw new UploadTooLargeError(limit);
            }
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(tmpPath),
      );
    } catch (error) {
      await rm(tmpPath, { force: true });
      throw error;
    }

    const sha256 = hash.digest('hex');
    const target = this.absolutePath(sha256);

    if (await this.exists(target)) {
      // Содержимое уже на диске: временный файл не нужен, метаданные
      // сошлются на существующий объект (§9.1).
      await rm(tmpPath, { force: true });
      return { sha256, sizeBytes, deduplicated: true };
    }

    await mkdir(dirname(target), { recursive: true });
    try {
      await rename(tmpPath, target);
    } catch (error) {
      await rm(tmpPath, { force: true });
      // Гонка двух одновременных загрузок одного содержимого: соперник
      // успел переименовать первым. Результат тот же, что при
      // дедупликации, — байты на месте.
      if (await this.exists(target)) {
        return { sha256, sizeBytes, deduplicated: true };
      }
      throw error;
    }

    return { sha256, sizeBytes, deduplicated: false };
  }

  async remove(sha256: string): Promise<void> {
    await rm(this.absolutePath(sha256), { force: true });
  }

  async removeThumb(thumbPath: string): Promise<void> {
    await rm(join(this.thumbsRoot, thumbPath), { force: true });
  }

  /**
   * Занятость диска. Специфика self-hosted: место конечно и никто не
   * расширит его автоматически (§9.5).
   */
  async diskUsage(): Promise<{ totalBytes: number; freeBytes: number; usedRatio: number }> {
    const fs = await statfs(this.config.storagePath);
    const totalBytes = Number(fs.blocks) * Number(fs.bsize);
    const freeBytes = Number(fs.bavail) * Number(fs.bsize);
    return {
      totalBytes,
      freeBytes,
      usedRatio: totalBytes > 0 ? 1 - freeBytes / totalBytes : 0,
    };
  }

  /** Уборка недописанных загрузок: обрыв связи оставляет файл в tmp/. */
  async sweepTemporary(olderThanMs: number): Promise<number> {
    let removed = 0;

    const entries = await readdir(this.tmpRoot).catch(() => [] as string[]);
    const deadline = Date.now() - olderThanMs;

    for (const entry of entries) {
      const path = join(this.tmpRoot, entry);
      const info = await stat(path).catch(() => null);
      if (!info || info.mtimeMs > deadline) continue;
      await rm(path, { force: true });
      removed += 1;
    }
    return removed;
  }

  private async exists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }
}
