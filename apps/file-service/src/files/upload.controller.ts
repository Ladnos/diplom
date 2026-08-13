import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import {
  BadRequestException,
  Controller,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import busboy from 'busboy';
import type { Request, Response } from 'express';
import { EntityType, Visibility } from '../../generated/prisma';
import { TokenGuard } from '../auth/token.guard';
import { StorageService, UploadTooLargeError, type StoredObject } from '../storage/storage.service';
import { FileService, QuotaExceededError } from './file.service';

const MAX_FILENAME_LENGTH = 255;

/**
 * Приём загрузок. docs/architecture.md §9.2
 *
 * Маршрут `/api/files/upload` nginx направляет СЮДА напрямую, минуя
 * api-gateway: многомегабайтные тела не должны проходить через сервис,
 * обслуживающий все остальные запросы. Поэтому здесь же проверяется и
 * токен — предъявлен он этому сервису, и переложить проверку не на кого.
 *
 * Тело не буферизуется нигде: `proxy_request_buffering off` в nginx,
 * потоковый разбор multipart здесь, запись на диск с параллельным
 * подсчётом sha256. Файл на пятьдесят мегабайт не занимает пятидесяти
 * мегабайт памяти ни в одном звене.
 */
@Controller('api/files')
@UseGuards(TokenGuard)
export class UploadController {
  private readonly logger = new Logger(UploadController.name);

  constructor(
    private readonly files: FileService,
    private readonly storage: StorageService,
  ) {}

  @Post('upload')
  async upload(@Req() request: Request, @Res() response: Response): Promise<void> {
    const actor = request.actor;
    if (!actor?.employeeId) {
      response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'у учётной записи нет карточки сотрудника',
      });
      return;
    }

    // Грубая проверка до чтения тела: если место кончилось ещё вчера,
    // незачем принимать байты, чтобы тут же их удалить.
    try {
      await this.files.assertQuotaBefore(actor.employeeId);
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        response.status(HttpStatus.PAYLOAD_TOO_LARGE).json(quotaBody(error));
        return;
      }
      throw error;
    }

    let parsed: ParsedUpload;
    try {
      parsed = await this.parse(request);
    } catch (error) {
      if (error instanceof UploadTooLargeError) {
        response.status(HttpStatus.PAYLOAD_TOO_LARGE).json({
          statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
          message: error.message,
        });
        return;
      }
      if (error instanceof BadRequestException) {
        response.status(HttpStatus.BAD_REQUEST).json({
          statusCode: HttpStatus.BAD_REQUEST,
          message: error.message,
        });
        return;
      }
      throw error;
    }

    // Точная проверка: до чтения размер был неизвестен. Объект уже на
    // диске — но если он появился этой же загрузкой, его надо убрать,
    // а если переиспользован, трогать нельзя: на него ссылается чужая
    // запись.
    try {
      await this.files.assertQuotaAfter(actor.employeeId, parsed.stored.sizeBytes);
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        if (!parsed.stored.deduplicated) await this.storage.remove(parsed.stored.sha256);
        response.status(HttpStatus.PAYLOAD_TOO_LARGE).json(quotaBody(error));
        return;
      }
      throw error;
    }

    const meta = await this.files.register({
      stored: parsed.stored,
      filename: parsed.filename,
      mimeType: parsed.mimeType,
      ownerEmployeeId: actor.employeeId,
      visibility: parsed.visibility,
    });

    // Привязка сразу при загрузке — для случаев, когда сущность уже
    // существует: аватар сотрудника, вложение к открытой карточке. Для
    // сообщения чата, которого ещё нет, привязку делает сервис-владелец
    // по событию file.upload.completed.
    if (parsed.entityType && parsed.entityId) {
      await this.files.attach(meta.id, parsed.entityType, parsed.entityId);
    }

    this.logger.log({
      message: 'файл принят',
      fileId: meta.id,
      sizeBytes: meta.sizeBytes,
      deduplicated: parsed.stored.deduplicated,
      ownerEmployeeId: actor.employeeId,
    });

    response.status(HttpStatus.CREATED).json({
      fileId: meta.id,
      filename: meta.filename,
      mimeType: meta.mimeType,
      sizeBytes: meta.sizeBytes,
      sha256: meta.sha256,
      visibility: meta.visibility,
      deduplicated: parsed.stored.deduplicated,
    });
  }

  /**
   * Разбор multipart.
   *
   * Поля читаются вместе с файлом, но применяются после: порядок частей
   * в запросе задаёт клиент, и полагаться на то, что `visibility` придёт
   * раньше содержимого, нельзя. На укладку файла это не влияет — имя на
   * диске выводится из хэша, а не из полей формы.
   */
  private parse(request: Request): Promise<ParsedUpload> {
    return new Promise<ParsedUpload>((resolve, reject) => {
      const parser = busboy({
        headers: request.headers,
        // Кодировка имён частей. По умолчанию busboy читает их как
        // latin1 — так было принято в RFC 7578 до появления UTF-8, — и
        // «договор.txt» приезжает как «Ð´Ð¾Ð³Ð¾Ð²Ð¾Ñ.txt». Браузеры
        // давно шлют UTF-8, поэтому умолчание приходится переопределять.
        defParamCharset: 'utf8',
        // Одно вложение на запрос. Пакетная загрузка ничего не упрощает:
        // отказ по квоте на третьем файле оставил бы два принятых и один
        // отвергнутый в одном ответе, который клиенту нечем разобрать.
        limits: { files: 1, fields: 8, fieldSize: 1024 },
      });

      const fields = new Map<string, string>();
      let pending: Promise<StoredObject> | null = null;
      let filename = 'file';
      let mimeType = 'application/octet-stream';
      let settled = false;

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        request.unpipe(parser);
        // ДОЧИТАТЬ И ВЫБРОСИТЬ остаток тела. Без этого поток остаётся без
        // потребителя, буфер заполняется, nginx блокируется на записи и
        // отвечает клиенту 504 вместо нашего 413: ответ, уже готовый в
        // Node, до него просто не доходит.
        //
        // Байты при этом никуда не попадают — только читаются и
        // отбрасываются. Объём ограничен сверху client_max_body_size в
        // nginx, поэтому «дочитать» здесь означает не больше пятидесяти
        // мегабайт даже при попытке загрузить гигабайт.
        request.resume();
        reject(error);
      };

      parser.on('field', (name, value) => fields.set(name, value));

      parser.on('file', (_name, stream: Readable, info) => {
        filename = sanitizeFilename(info.filename);
        mimeType = info.mimeType || mimeType;
        pending = this.storage.store(stream);
        // Отказ обрабатывается СРАЗУ, а не по событию close.
        //
        // Превышение предела рвёт поток изнутри pipeline, и busboy,
        // лишившись потребителя файловой части, события close уже не
        // даёт. Ожидание его означало бы, что ответ не отправится
        // никогда: клиент дошлёт тело и будет ждать заголовков, пока
        // nginx не оборвёт запрос по таймауту — то есть вместо честного
        // 413 через миллисекунды получится 504 через пять минут.
        pending.catch(fail);
      });

      parser.on('error', (error: unknown) =>
        fail(error instanceof Error ? error : new Error(String(error))),
      );

      parser.on('close', () => {
        if (settled) return;
        if (!pending) {
          fail(new BadRequestException('в запросе нет файла'));
          return;
        }

        pending.then((stored) => {
          settled = true;
          resolve({
            stored,
            filename,
            mimeType,
            visibility: toVisibility(fields.get('visibility')),
            entityType: toEntityType(fields.get('entityType')),
            entityId: fields.get('entityId') || undefined,
          });
        }, fail);
      });

      request.pipe(parser);
    });
  }
}

interface ParsedUpload {
  stored: StoredObject;
  filename: string;
  mimeType: string;
  visibility: Visibility;
  entityType?: EntityType;
  entityId?: string;
}

function quotaBody(error: QuotaExceededError) {
  return {
    statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
    message: 'квота на файлы исчерпана',
    usedBytes: error.usage.usedBytes,
    limitBytes: error.usage.limitBytes,
  };
}

/**
 * Имя файла приходит от клиента и попадает в заголовок Content-Disposition
 * при скачивании. На диске оно не используется — путь выводится из хэша, —
 * но каталоги в нём всё равно срезаются: имя вида `../../etc/passwd`
 * бессмысленно как имя и опасно как привычка.
 */
function sanitizeFilename(raw: string | undefined): string {
  // Управляющие символы удаляются намеренно: они попадают в заголовок
  // Content-Disposition, где перевод строки означает конец заголовка и
  // начало следующего — то есть возможность подставить свой.
  // eslint-disable-next-line no-control-regex
  const name = basename(raw ?? '').replace(/[\u0000-\u001f\u007f"\\]/g, '').trim();
  if (name.length === 0) return 'file';
  return name.length > MAX_FILENAME_LENGTH ? name.slice(-MAX_FILENAME_LENGTH) : name;
}

/**
 * По умолчанию PRIVATE.
 *
 * Умолчание выбрано в сторону закрытости: полупубличный файл доступен по
 * ссылке всякому, кто её получил, и ошибка в эту сторону не отменяется
 * задним числом — ссылка уже разошлась.
 */
function toVisibility(value: string | undefined): Visibility {
  return value === 'SEMI_PUBLIC' ? Visibility.SEMI_PUBLIC : Visibility.PRIVATE;
}

function toEntityType(value: string | undefined): EntityType | undefined {
  if (!value) return undefined;
  return value in EntityType ? (value as EntityType) : undefined;
}
