import { Controller } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { EntityType, Visibility, type FileMeta } from '../../generated/prisma';
import { StorageService } from '../storage/storage.service';
import { FileService } from './file.service';
import { SignedLinkService } from './signed-link.service';

/**
 * gRPC-фасад file-service.
 *
 * Отдачи и приёма байтов здесь нет и быть не может: и то и другое идёт по
 * HTTP через nginx, минуя gRPC (§9.2, §9.3). Через этот контракт ходят
 * только метаданные, привязки и подписанные ссылки.
 */
@Controller()
export class FileGrpcController {
  constructor(
    private readonly files: FileService,
    private readonly links: SignedLinkService,
    private readonly storage: StorageService,
  ) {}

  @GrpcMethod('FileService', 'GetFileMeta')
  async getFileMeta(data: { file_id: string }) {
    return mapMeta(await this.files.getMeta(data.file_id));
  }

  @GrpcMethod('FileService', 'GetFilesBatch')
  async getFilesBatch(data: { ids: string[] }) {
    const files = await this.files.getBatch(data.ids ?? []);
    return { files: files.map(mapMeta) };
  }

  /**
   * Ссылка на полупубличный файл.
   *
   * Только для SEMI_PUBLIC: подпись проверяет nginx, и приложение при
   * отдаче не вызывается вообще. Выдать такую ссылку на приватный
   * документ значило бы обойти проверку прав, ради которой он приватным
   * и сделан, — поэтому здесь отказ, а не молчаливое согласие.
   */
  @GrpcMethod('FileService', 'IssueSignedLink')
  async issueSignedLink(data: {
    file_id: string;
    actor_employee_id: string;
    ttl_seconds?: number;
    thumbnail?: boolean;
    client_ip?: string;
  }) {
    const meta = await this.files.getMeta(data.file_id);
    if (meta.visibility !== Visibility.SEMI_PUBLIC) {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'подписанная ссылка выдаётся только для полупубличных файлов',
      });
    }
    if (!data.client_ip) {
      // Адрес клиента входит в подпись: без него ссылка получится
      // недействительной, и разбираться в этом придётся по 403 от nginx
      // без единой записи в журнале приложения.
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'не передан адрес клиента: он входит в подпись ссылки',
      });
    }

    const link = this.links.issue({
      relativePath: this.storage.relativePath(meta.sha256),
      clientIp: data.client_ip,
      ttlSeconds: data.ttl_seconds || undefined,
      thumbnail: data.thumbnail,
    });
    return { url: link.url, expires_at: link.expiresAt };
  }

  @GrpcMethod('FileService', 'AttachToEntity')
  async attachToEntity(data: { file_id: string; entity_type: string; entity_id: string }) {
    const meta = await this.files.attach(
      data.file_id,
      toEntityType(data.entity_type),
      data.entity_id,
    );
    return mapMeta(meta);
  }

  @GrpcMethod('FileService', 'DetachFromEntity')
  async detachFromEntity(data: { file_id: string; entity_type: string; entity_id: string }) {
    await this.files.detach(data.file_id, toEntityType(data.entity_type), data.entity_id);
    return {};
  }

  @GrpcMethod('FileService', 'ListOwnFiles')
  async listOwnFiles(data: { owner_employee_id: string; limit?: number; offset?: number }) {
    const files = await this.files.listOwnFiles(
      data.owner_employee_id,
      data.limit || 50,
      data.offset || 0,
    );
    return { files: files.map(mapMeta) };
  }

  @GrpcMethod('FileService', 'GetQuotaUsage')
  async getQuotaUsage(data: { owner_employee_id: string }) {
    const usage = await this.files.quotaUsage(data.owner_employee_id);
    return {
      used_bytes: usage.usedBytes,
      limit_bytes: usage.limitBytes,
      file_count: usage.fileCount,
    };
  }

  @GrpcMethod('FileService', 'DeleteFile')
  async deleteFile(data: { file_id: string; actor_employee_id: string }) {
    await this.files.deleteFile(data.file_id, data.actor_employee_id || '');
    return {};
  }
}

function toEntityType(value: string): EntityType {
  if (value in EntityType) return value as EntityType;
  throw new RpcException({
    code: GrpcStatus.INVALID_ARGUMENT,
    message: `неизвестный тип сущности «${value}»`,
  });
}

function mapMeta(meta: FileMeta) {
  return {
    file_id: meta.id,
    filename: meta.filename,
    sha256: meta.sha256,
    size_bytes: meta.sizeBytes,
    mime_type: meta.mimeType,
    owner_employee_id: meta.ownerEmployeeId,
    visibility: meta.visibility,
    refcount: meta.refcount,
    // Превью не строятся: генерация идёт командой media.process через
    // ffmpeg, которого в образе нет. Поле остаётся в контракте и станет
    // осмысленным вместе с обработкой медиа.
    has_thumbnail: false,
    created_at: meta.createdAt.getTime(),
  };
}
