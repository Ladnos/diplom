import { ConsoleLogger, LogLevel } from '@nestjs/common';

/**
 * Логгер с двумя режимами вывода.
 *
 * development — человекочитаемый формат Nest, чтобы читать в терминале.
 * production  — JSON-строка на событие, чтобы Loki/Promtail разбирали её
 *               без regex-парсинга и correlationId был доступен как поле,
 *               а не как кусок текста.
 */
export class AppLogger extends ConsoleLogger {
  constructor(
    context: string,
    private readonly json: boolean,
  ) {
    super(context);
  }

  protected formatMessage(
    logLevel: LogLevel,
    message: unknown,
    _pidMessage: string,
    _formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
  ): string {
    if (!this.json) {
      return super.formatMessage(
        logLevel,
        message,
        _pidMessage,
        _formattedLogLevel,
        contextMessage,
        timestampDiff,
      );
    }

    const payload =
      typeof message === 'object' && message !== null
        ? (message as Record<string, unknown>)
        : { message };

    return (
      JSON.stringify({
        level: logLevel,
        time: new Date().toISOString(),
        service: process.env.SERVICE_NAME,
        context: this.context,
        ...payload,
      }) + '\n'
    );
  }
}

const LEVEL_ORDER: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];

/** Уровни от указанного и выше — Nest принимает именно список, а не порог. */
export function levelsFrom(minLevel: string): LogLevel[] {
  const normalized = minLevel === 'info' ? 'log' : (minLevel as LogLevel);
  const index = LEVEL_ORDER.indexOf(normalized);
  return index === -1 ? LEVEL_ORDER.slice(2) : LEVEL_ORDER.slice(index);
}

export function createLogger(serviceName: string, logLevel: string, json: boolean): AppLogger {
  const logger = new AppLogger(serviceName, json);
  logger.setLogLevels(levelsFrom(logLevel));
  return logger;
}
