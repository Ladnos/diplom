import { ConsoleLogger, LogLevel } from '@nestjs/common';
/**
 * Логгер с двумя режимами вывода.
 *
 * development — человекочитаемый формат Nest, чтобы читать в терминале.
 * production  — JSON-строка на событие, чтобы Loki/Promtail разбирали её
 *               без regex-парсинга и correlationId был доступен как поле,
 *               а не как кусок текста.
 */
export declare class AppLogger extends ConsoleLogger {
    private readonly json;
    constructor(context: string, json: boolean);
    protected formatMessage(logLevel: LogLevel, message: unknown, _pidMessage: string, _formattedLogLevel: string, contextMessage: string, timestampDiff: string): string;
}
/** Уровни от указанного и выше — Nest принимает именно список, а не порог. */
export declare function levelsFrom(minLevel: string): LogLevel[];
export declare function createLogger(serviceName: string, logLevel: string, json: boolean): AppLogger;
//# sourceMappingURL=logger.d.ts.map