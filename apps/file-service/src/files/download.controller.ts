import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Visibility } from '../../generated/prisma';
import { TokenGuard } from '../auth/token.guard';
import { StorageService } from '../storage/storage.service';
import { AccessService } from './access.service';
import { FileService } from './file.service';
import { SignedLinkService } from './signed-link.service';

/**
 * Отдача приватных файлов через `X-Accel-Redirect`. §9.3
 *
 * Node проверяет права и возвращает пустой ответ с заголовком, после чего
 * полностью выходит из передачи байтов: файл уходит клиенту через
 * `sendfile(2)` силами nginx. Файл на пятьсот мегабайт не проходит ни
 * через память процесса, ни через event loop.
 *
 * Это тот же эффект, ради которого в облачных архитектурах выдают
 * presigned URL, — но без объектного хранилища и без окна, в течение
 * которого выданная ссылка действует независимо от прав (ADR-4).
 */
@Controller('api/files')
@UseGuards(TokenGuard)
export class DownloadController {
  private readonly logger = new Logger(DownloadController.name);

  constructor(
    private readonly files: FileService,
    private readonly access: AccessService,
    private readonly storage: StorageService,
    private readonly links: SignedLinkService,
  ) {}

  /**
   * Занятая квота.
   *
   * Объявлен ДО `:id` — порядок здесь значим: Express берёт первый
   * подошедший маршрут, и после `:id` этот адрес разбирался бы как
   * идентификатор файла и падал на проверке UUID.
   */
  @Get('quota')
  async quota(@Req() request: Request) {
    const actor = request.actor!;
    if (!actor.employeeId) return { usedBytes: 0, limitBytes: 0, fileCount: 0 };

    const usage = await this.files.quotaUsage(actor.employeeId);
    return {
      usedBytes: usage.usedBytes,
      limitBytes: usage.limitBytes,
      fileCount: usage.fileCount,
      usedRatio: usage.limitBytes > 0 ? usage.usedBytes / usage.limitBytes : 0,
    };
  }

  /** Метаданные без содержимого: имя, размер, тип, кем загружен. */
  @Get(':id/meta')
  async meta(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    const actor = request.actor!;
    const meta = await this.files.getMeta(id).catch(() => null);
    if (!meta) throw new NotFoundException('файл не найден');
    if (!(await this.access.mayRead(meta, actor))) {
      throw new ForbiddenException('нет доступа к файлу');
    }

    return {
      fileId: meta.id,
      filename: meta.filename,
      mimeType: meta.mimeType,
      sizeBytes: meta.sizeBytes,
      visibility: meta.visibility,
      ownerEmployeeId: meta.ownerEmployeeId,
      refcount: meta.refcount,
      createdAt: meta.createdAt.toISOString(),
    };
  }

  /**
   * Подписанная ссылка на полупубличный файл.
   *
   * Адрес клиента берётся из X-Real-IP, который ставит nginx: тот же
   * адрес попадёт в `$remote_addr` при проверке подписи. Брать его из
   * сокета нельзя — до сервиса доходит адрес самого nginx, и подпись
   * получилась бы для чужого клиента.
   */
  @Post(':id/link')
  @HttpCode(200)
  async link(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    const actor = request.actor!;
    const meta = await this.files.getMeta(id).catch(() => null);
    if (!meta) throw new NotFoundException('файл не найден');
    if (!(await this.access.mayRead(meta, actor))) {
      throw new ForbiddenException('нет доступа к файлу');
    }
    if (meta.visibility !== Visibility.SEMI_PUBLIC) {
      throw new ForbiddenException(
        'подписанная ссылка выдаётся только для полупубличных файлов: ' +
          'приватные отдаются с проверкой прав на каждое обращение',
      );
    }

    const link = this.links.issue({
      relativePath: this.storage.relativePath(meta.sha256),
      clientIp: clientIp(request),
    });
    return { url: link.url, expiresAt: new Date(link.expiresAt).toISOString() };
  }

  @Get(':id')
  @HttpCode(200)
  // Ответ пустой и зависит от прав конкретного пользователя: попадание
  // такого в общий кэш отдало бы файл следующему запросившему.
  @Header('Cache-Control', 'private, no-store')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const actor = request.actor!;
    const meta = await this.files.getMeta(id).catch(() => null);
    if (!meta) throw new NotFoundException('файл не найден');

    if (!(await this.access.mayRead(meta, actor))) {
      // Не различаем «нет файла» и «нет доступа»: иначе по коду ответа
      // перебором выясняется, какие файлы существуют.
      this.logger.debug({ message: 'отказ в доступе к файлу', fileId: id, userId: actor.userId });
      throw new ForbiddenException('нет доступа к файлу');
    }

    // Путь отдаётся nginx как внутренний: location /internal-files/
    // объявлен `internal` и снаружи недоступен.
    response.setHeader('X-Accel-Redirect', `/internal-files/${this.storage.relativePath(meta.sha256)}`);
    response.setHeader('Content-Type', meta.mimeType);
    response.setHeader('Content-Length', String(meta.sizeBytes));
    response.setHeader('Content-Disposition', contentDisposition(meta.filename));
    response.end();
  }
}

/**
 * Имя файла в заголовке.
 *
 * Два варианта в одном заголовке — требование RFC 6266: `filename` для
 * старых клиентов, `filename*` в кодировке UTF-8 для остальных. Без
 * второго русские имена приходят как набор вопросительных знаков, без
 * первого их теряют старые загрузчики.
 */
/**
 * Адрес клиента для подписи ссылки.
 *
 * X-Real-IP ставит nginx, и именно это значение он же подставит в
 * `$remote_addr` при проверке подписи. Адрес из сокета здесь — это адрес
 * самого nginx, и подпись по нему не сойдётся ни у одного клиента.
 */
function clientIp(request: Request): string {
  const header = request.headers['x-real-ip'];
  if (typeof header === 'string' && header.length > 0) return header;
  return request.socket.remoteAddress ?? '';
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
