import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import { SERVICES } from '@crm/contracts';
import { DEADLINES_MS, grpcClientToken } from '@crm/grpc-clients';

export type FileEntityType =
  | 'CHAT_MESSAGE'
  | 'TASK_CARD'
  | 'CALL_RECORDING'
  | 'EMPLOYEE_AVATAR'
  | 'TIMESHEET_EXPORT';

export interface FileMetaDto {
  file_id: string;
  filename: string;
  sha256: string;
  size_bytes: number;
  mime_type: string;
  owner_employee_id: string;
  visibility: string;
  refcount: number;
  has_thumbnail: boolean;
  created_at: number;
}

interface FileGrpc {
  GetFileMeta(data: { file_id: string }): Observable<FileMetaDto>;
  GetFilesBatch(data: { ids: string[] }): Observable<{ files: FileMetaDto[] }>;
  IssueSignedLink(data: {
    file_id: string;
    actor_employee_id: string;
    ttl_seconds: number;
    thumbnail: boolean;
    client_ip: string;
  }): Observable<{ url: string; expires_at: number }>;
  AttachToEntity(data: {
    file_id: string;
    entity_type: string;
    entity_id: string;
  }): Observable<FileMetaDto>;
  DetachFromEntity(data: {
    file_id: string;
    entity_type: string;
    entity_id: string;
  }): Observable<object>;
  GetQuotaUsage(data: { owner_employee_id: string }): Observable<{
    used_bytes: number;
    limit_bytes: number;
    file_count: number;
  }>;
}

/**
 * Клиент к file-service.
 *
 * Байты через шлюз не ходят: загрузку и скачивание nginx направляет в
 * file-service напрямую (§9.2, §9.3). Здесь только метаданные и
 * привязки — то, чем шлюз дополняет выдачу сообщений и карточек.
 */
@Injectable()
export class FileClient implements OnModuleInit {
  private readonly logger = new Logger(FileClient.name);
  private service!: FileGrpc;

  constructor(@Inject(grpcClientToken(SERVICES.FILE)) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.service = this.client.getService<FileGrpc>('FileService');
  }

  private call<T>(source: Observable<T>, deadline: number = DEADLINES_MS.DEFAULT): Promise<T> {
    return firstValueFrom(source.pipe(timeout(deadline)));
  }

  /**
   * Метаданные пачкой. Отказ файлового сервиса не должен ломать выдачу
   * переписки: сообщение отрисуется, вложение — без имени и размера.
   */
  async metaByIds(fileIds: string[]): Promise<Map<string, FileMetaDto>> {
    const unique = [...new Set(fileIds.filter(Boolean))];
    if (unique.length === 0) return new Map();

    return this.call(this.service.GetFilesBatch({ ids: unique }))
      .then((result) => new Map(result.files.map((file) => [file.file_id, file])))
      .catch((error: unknown) => {
        this.logger.warn({
          message: 'метаданные вложений недоступны',
          error: error instanceof Error ? error.message : String(error),
        });
        return new Map<string, FileMetaDto>();
      });
  }

  attach(fileId: string, entityType: FileEntityType, entityId: string) {
    return this.call(
      this.service.AttachToEntity({
        file_id: fileId,
        entity_type: entityType,
        entity_id: entityId,
      }),
    );
  }

  detach(fileId: string, entityType: FileEntityType, entityId: string) {
    return this.call(
      this.service.DetachFromEntity({
        file_id: fileId,
        entity_type: entityType,
        entity_id: entityId,
      }),
    );
  }

  /**
   * Привязка списка файлов к сущности.
   *
   * Ошибка привязки не отменяет уже созданную сущность: сообщение
   * отправлено, карточка сохранена, и откатывать их из-за счётчика ссылок
   * нельзя. Непривязанный файл не пропадёт немедленно — сборщик мусора
   * трогает только то, что пролежало без привязки неделю (§9.5), и этого
   * запаса достаточно, чтобы заметить и починить.
   */
  async attachAll(
    fileIds: string[],
    entityType: FileEntityType,
    entityId: string,
  ): Promise<void> {
    const unique = [...new Set(fileIds.filter(Boolean))];
    if (unique.length === 0) return;

    const results = await Promise.allSettled(
      unique.map((fileId) => this.attach(fileId, entityType, entityId)),
    );

    const failed = results.filter((item) => item.status === 'rejected').length;
    if (failed > 0) {
      this.logger.warn({
        message: 'часть вложений не привязана',
        entityType,
        entityId,
        failed,
        total: unique.length,
      });
    }
  }

  quota(ownerEmployeeId: string) {
    return this.call(this.service.GetQuotaUsage({ owner_employee_id: ownerEmployeeId }));
  }

  signedLink(input: {
    fileId: string;
    actorEmployeeId: string;
    clientIp: string;
    ttlSeconds?: number;
    thumbnail?: boolean;
  }) {
    return this.call(
      this.service.IssueSignedLink({
        file_id: input.fileId,
        actor_employee_id: input.actorEmployeeId,
        ttl_seconds: input.ttlSeconds ?? 0,
        thumbnail: input.thumbnail ?? false,
        client_ip: input.clientIp,
      }),
    );
  }
}

/** Форма вложения в ответах API. Одна на сообщения и карточки. */
export function toPublicAttachment(fileId: string, meta?: FileMetaDto) {
  return {
    fileId,
    filename: meta?.filename ?? null,
    mimeType: meta?.mime_type ?? null,
    sizeBytes: meta ? Number(meta.size_bytes) : null,
    // Адрес скачивания, а не содержимое: nginx направит его в
    // file-service, тот проверит права и отдаст файл через sendfile.
    url: `/api/files/${fileId}`,
  };
}
