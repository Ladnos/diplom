import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Response } from 'express';
import { getRequestContext } from '@crm/common';

/**
 * Перевод ошибок gRPC в коды HTTP.
 *
 * Без этого фильтра любая доменная ошибка превращается в 500: клиент не
 * отличает «email занят» от «база недоступна», а фронтенд не может
 * показать осмысленное сообщение.
 */
const STATUS_MAP: Partial<Record<number, number>> = {
  [GrpcStatus.OK]: 200,
  [GrpcStatus.INVALID_ARGUMENT]: 400,
  [GrpcStatus.FAILED_PRECONDITION]: 400,
  [GrpcStatus.OUT_OF_RANGE]: 400,
  [GrpcStatus.UNAUTHENTICATED]: 401,
  [GrpcStatus.PERMISSION_DENIED]: 403,
  [GrpcStatus.NOT_FOUND]: 404,
  [GrpcStatus.ALREADY_EXISTS]: 409,
  [GrpcStatus.ABORTED]: 409,
  [GrpcStatus.RESOURCE_EXHAUSTED]: 429,
  [GrpcStatus.CANCELLED]: 499,
  [GrpcStatus.UNIMPLEMENTED]: 501,
  // Недоступность адресата и таймаут — это 503/504, а не 500:
  // клиенту имеет смысл повторить запрос позже.
  [GrpcStatus.UNAVAILABLE]: 503,
  [GrpcStatus.DEADLINE_EXCEEDED]: 504,
};

interface GrpcError {
  code?: number;
  details?: string;
  message?: string;
}

@Catch()
export class GrpcExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GrpcExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const correlationId = getRequestContext().correlationId;

    // Фильтр зарегистрирован глобально и вызывается для всех транспортов.
    // Ответа с кодом состояния нет ни у сообщения из RabbitMQ, ни у
    // сообщения WebSocket: попытка вызвать response.status() там дала бы
    // вторую ошибку поверх первой и скрыла бы исходную.
    if (host.getType() !== 'http') {
      this.logger.error({
        message: 'необработанная ошибка вне HTTP-запроса',
        transport: host.getType(),
        correlationId,
        detail: exception instanceof Error ? exception.message : String(exception),
        stack: exception instanceof Error ? exception.stack : undefined,
      });
      return;
    }

    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).json({
        statusCode: status,
        message: exception.message,
        correlationId,
      });
      return;
    }

    const error = exception as GrpcError;
    const status = (error.code !== undefined && STATUS_MAP[error.code]) || 500;
    const message = error.details ?? error.message ?? 'внутренняя ошибка';

    // Пятисотки логируем со стеком: это наши баги, а не ошибки клиента
    if (status >= 500) {
      this.logger.error({
        message: 'ошибка обработки запроса',
        correlationId,
        grpcCode: error.code,
        detail: message,
        stack: exception instanceof Error ? exception.stack : undefined,
      });
    }

    // Скрывается только 500: там в detail может оказаться текст ошибки БД
    // с именами таблиц. 501 (не реализовано), 503 и 504 — осознанные
    // ответы, и их текст объясняет клиенту, что происходит. Подмена его
    // на «внутреннюю ошибку» превращает понятный отказ в загадку —
    // именно на этом был потерян час при отладке закрытия периода.
    const hideDetail = status === 500;

    response.status(status).json({
      statusCode: status,
      message: hideDetail ? 'внутренняя ошибка сервиса' : message,
      correlationId,
    });
  }
}
