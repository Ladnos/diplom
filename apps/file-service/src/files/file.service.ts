import { Inject, Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import {
  FileEvents,
  type QuotaExceeded,
  type RequestContext,
  type UploadCompleted,
} from '@crm/contracts';
import { getRequestContext } from '@crm/common';
import { EventPublisher } from '@crm/messaging';
import { EntityType, Prisma, Visibility, type FileMeta } from '../../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { outboxRow } from '../prisma/outbox.store';
import { FILE_CONFIG, type FileConfig } from '../config';
import { StorageService, type StoredObject } from '../storage/storage.service';

export interface QuotaSnapshot {
  usedBytes: number;
  limitBytes: number;
  fileCount: number;
}

/**
 * Метаданные файлов, счётчик ссылок и квоты.
 *
 * Байты сюда не попадают: их принимает и укладывает StorageService, а
 * здесь только записи о том, что уложено, кому принадлежит и кем
 * используется.
 */
@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly publisher: EventPublisher,
    @Inject(FILE_CONFIG) private readonly config: FileConfig,
  ) {}

  /**
   * Зарегистрировать уже уложенный на диск объект.
   *
   * Объект и метаданные создаются одной транзакцией вместе с записью в
   * outbox: событие о загрузке — единственный способ для сервиса-владельца
   * узнать, что файл появился и его пора привязать. Потеря события
   * означала бы файл с нулевым счётчиком ссылок, который через неделю
   * молча уберёт сборщик мусора — прямо из-под живого сообщения.
   */
  async register(
    input: {
      stored: StoredObject;
      filename: string;
      mimeType: string;
      ownerEmployeeId: string;
      visibility: Visibility;
    },
    context: RequestContext = getRequestContext(),
  ): Promise<FileMeta> {
    const { stored } = input;

    return this.prisma.$transaction(async (tx) => {
      await tx.fileObject.upsert({
        where: { sha256: stored.sha256 },
        create: {
          sha256: stored.sha256,
          sizeBytes: stored.sizeBytes,
          mimeType: input.mimeType,
        },
        // Содержимое по этому хэшу уже есть, и менять в нём нечего:
        // размер и тип определяются самими байтами. Пустой update
        // оставлен намеренно — он превращает upsert в «создай, если нет».
        update: {},
      });

      const meta = await tx.fileMeta.create({
        data: {
          sha256: stored.sha256,
          filename: input.filename,
          mimeType: input.mimeType,
          sizeBytes: stored.sizeBytes,
          ownerEmployeeId: input.ownerEmployeeId,
          visibility: input.visibility,
        },
      });

      const envelope = this.publisher.wrap<UploadCompleted>(
        FileEvents.UPLOAD_COMPLETED,
        {
          fileId: meta.id,
          ownerEmployeeId: input.ownerEmployeeId,
          sha256: stored.sha256,
          sizeBytes: stored.sizeBytes,
          mimeType: input.mimeType,
          deduplicated: stored.deduplicated,
        },
        context,
      );
      await tx.outbox.create({ data: outboxRow(envelope) });

      return meta;
    });
  }

  /**
   * Занятая квота.
   *
   * Считается логический объём — сумма размеров загрузок, а не место на
   * диске. Дедупликация может сделать физический объём вдвое меньше, но
   * привязывать квоту к нему значило бы, что занятость пользователя
   * меняется от действий постороннего: коллега удалил свою копию того же
   * файла — и у первого «появилось место». Квота отвечает за то, сколько
   * человек загрузил, а не сколько байт из-за него легло на диск.
   */
  async quotaUsage(ownerEmployeeId: string): Promise<QuotaSnapshot> {
    const result = await this.prisma.fileMeta.aggregate({
      where: { ownerEmployeeId },
      _sum: { sizeBytes: true },
      _count: true,
    });

    return {
      usedBytes: result._sum.sizeBytes ?? 0,
      limitBytes: this.config.quotaPerUserBytes,
      fileCount: result._count,
    };
  }

  /**
   * Проверка квоты ДО чтения тела запроса.
   *
   * Отказать до приёма байтов дешевле для обеих сторон: клиент не тратит
   * канал на файл, который не примут, а диск не принимает то, что тут же
   * удалит. Точную проверку это не заменяет — размер известен только
   * после чтения, — но отсекает случай «место кончилось ещё вчера».
   */
  async assertQuotaBefore(ownerEmployeeId: string): Promise<QuotaSnapshot> {
    const usage = await this.quotaUsage(ownerEmployeeId);
    if (usage.usedBytes >= usage.limitBytes) {
      await this.reportQuotaExceeded(ownerEmployeeId, usage);
      throw new QuotaExceededError(usage);
    }
    return usage;
  }

  /** Точная проверка: размер стал известен после чтения потока. */
  async assertQuotaAfter(
    ownerEmployeeId: string,
    incomingBytes: number,
  ): Promise<void> {
    const usage = await this.quotaUsage(ownerEmployeeId);
    if (usage.usedBytes + incomingBytes <= usage.limitBytes) return;

    await this.reportQuotaExceeded(ownerEmployeeId, {
      ...usage,
      usedBytes: usage.usedBytes + incomingBytes,
    });
    throw new QuotaExceededError(usage);
  }

  async getMeta(fileId: string): Promise<FileMeta> {
    const meta = await this.prisma.fileMeta.findUnique({ where: { id: fileId } });
    if (!meta) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'файл не найден' });
    }
    return meta;
  }

  async getBatch(fileIds: string[]): Promise<FileMeta[]> {
    const unique = [...new Set(fileIds.filter(Boolean))];
    if (unique.length === 0) return [];
    return this.prisma.fileMeta.findMany({ where: { id: { in: unique } } });
  }

  /**
   * Собственные загрузки сотрудника, свежие сверху.
   *
   * Владелец фиксируется при загрузке и не меняется при дедупликации: два
   * человека, отправившие одно и то же содержимое, получают разные записи
   * метаданных на один файл на диске — иначе список «мои файлы» у одного
   * из них оказался бы чужим.
   */
  async listOwnFiles(ownerEmployeeId: string, limit: number, offset: number): Promise<FileMeta[]> {
    return this.prisma.fileMeta.findMany({
      where: { ownerEmployeeId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      skip: Math.max(offset, 0),
    });
  }

  /**
   * Привязка файла к сущности. Идемпотентна.
   *
   * Счётчик растёт только вместе с появлением строки привязки, и обе
   * операции идут одной транзакцией. Инкремент отдельно от строки означал
   * бы, что повторный вызов AttachToEntity — а он повторится, потому что
   * события доставляются at-least-once, — навсегда завысит счётчик, и
   * файл не удалится никогда.
   */
  async attach(
    fileId: string,
    entityType: EntityType,
    entityId: string,
  ): Promise<FileMeta> {
    const meta = await this.getMeta(fileId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.attachment.create({ data: { fileId, entityType, entityId } });
        return tx.fileMeta.update({
          where: { id: fileId },
          data: { refcount: { increment: 1 } },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) return meta;
      throw error;
    }
  }

  async detach(fileId: string, entityType: EntityType, entityId: string): Promise<void> {
    await this.prisma
      .$transaction(async (tx) => {
        await tx.attachment.delete({
          where: {
            fileId_entityType_entityId: { fileId, entityType, entityId },
          },
        });
        await tx.fileMeta.update({
          where: { id: fileId },
          data: { refcount: { decrement: 1 } },
        });
      })
      .catch((error: unknown) => {
        // Привязки не было — счётчик трогать нельзя. Повторная отвязка
        // приходит с повторной доставкой события об удалении сущности.
        if (isMissingRecord(error)) return;
        throw error;
      });
  }

  /**
   * Отпустить все вложения сущности.
   *
   * Вызывается по событию об удалении карточки или сообщения. Считаем по
   * фактически удалённым строкам, а не по списку из события: список мог
   * разойтись с состоянием, а строки привязок — это и есть то, что
   * держит счётчик.
   */
  async detachEntity(entityType: EntityType, entityId: string): Promise<number> {
    const attachments = await this.prisma.attachment.findMany({
      where: { entityType, entityId },
      select: { fileId: true },
    });
    if (attachments.length === 0) return 0;

    const fileIds = attachments.map((item) => item.fileId);

    await this.prisma.$transaction(async (tx) => {
      const removed = await tx.attachment.deleteMany({ where: { entityType, entityId } });
      if (removed.count === 0) return;

      // По одному update на файл, а не updateMany с общим decrement:
      // один и тот же файл может быть привязан к сущности единожды, но
      // список fileIds приходит уже дедуплицированным из привязок.
      for (const fileId of fileIds) {
        await tx.fileMeta.update({
          where: { id: fileId },
          data: { refcount: { decrement: 1 } },
        });
      }
    });

    this.logger.log({ message: 'вложения отвязаны', entityType, entityId, files: fileIds.length });
    return fileIds.length;
  }

  /**
   * Удаление загрузки.
   *
   * Удаляется запись метаданных, а не байты: на то же содержимое может
   * ссылаться чужая загрузка. Осиротевшее содержимое уберёт сборщик
   * мусора, когда убедится, что на него не ссылается никто.
   */
  async deleteFile(fileId: string, actorEmployeeId: string): Promise<void> {
    const meta = await this.getMeta(fileId);
    if (actorEmployeeId && meta.ownerEmployeeId !== actorEmployeeId) {
      throw new RpcException({
        code: GrpcStatus.PERMISSION_DENIED,
        message: 'удалить файл может только загрузивший',
      });
    }
    if (meta.refcount > 0) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: `файл используется в ${meta.refcount} местах`,
      });
    }

    await this.prisma.fileMeta.delete({ where: { id: fileId } });
  }

  private async reportQuotaExceeded(
    ownerEmployeeId: string,
    usage: QuotaSnapshot,
  ): Promise<void> {
    // Событие, а не только отказ в ответе: об исчерпании квоты должен
    // узнать и сам сотрудник, и администратор, а HTTP-ответ увидит лишь
    // тот, кто в этот момент нажал «загрузить».
    const envelope = this.publisher.wrap<QuotaExceeded>(FileEvents.QUOTA_EXCEEDED, {
      ownerEmployeeId,
      usedBytes: usage.usedBytes,
      limitBytes: usage.limitBytes,
    });
    await this.prisma.outbox.create({ data: outboxRow(envelope) });

    this.logger.warn({
      message: 'квота исчерпана',
      ownerEmployeeId,
      usedBytes: usage.usedBytes,
      limitBytes: usage.limitBytes,
    });
  }
}

/** Отдельный тип, чтобы HTTP-слой ответил 413, а gRPC — RESOURCE_EXHAUSTED. */
export class QuotaExceededError extends Error {
  constructor(readonly usage: QuotaSnapshot) {
    super('квота на файлы исчерпана');
  }
}

/** P2002 — нарушение уникального ключа. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** P2025 — операция не нашла строку. */
export function isMissingRecord(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}
