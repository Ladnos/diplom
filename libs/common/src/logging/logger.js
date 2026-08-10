"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppLogger = void 0;
exports.levelsFrom = levelsFrom;
exports.createLogger = createLogger;
const common_1 = require("@nestjs/common");
/**
 * Логгер с двумя режимами вывода.
 *
 * development — человекочитаемый формат Nest, чтобы читать в терминале.
 * production  — JSON-строка на событие, чтобы Loki/Promtail разбирали её
 *               без regex-парсинга и correlationId был доступен как поле,
 *               а не как кусок текста.
 */
class AppLogger extends common_1.ConsoleLogger {
    json;
    constructor(context, json) {
        super(context);
        this.json = json;
    }
    formatMessage(logLevel, message, _pidMessage, _formattedLogLevel, contextMessage, timestampDiff) {
        if (!this.json) {
            return super.formatMessage(logLevel, message, _pidMessage, _formattedLogLevel, contextMessage, timestampDiff);
        }
        const payload = typeof message === 'object' && message !== null
            ? message
            : { message };
        return (JSON.stringify({
            level: logLevel,
            time: new Date().toISOString(),
            service: process.env.SERVICE_NAME,
            context: this.context,
            ...payload,
        }) + '\n');
    }
}
exports.AppLogger = AppLogger;
const LEVEL_ORDER = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];
/** Уровни от указанного и выше — Nest принимает именно список, а не порог. */
function levelsFrom(minLevel) {
    const normalized = minLevel === 'info' ? 'log' : minLevel;
    const index = LEVEL_ORDER.indexOf(normalized);
    return index === -1 ? LEVEL_ORDER.slice(2) : LEVEL_ORDER.slice(index);
}
function createLogger(serviceName, logLevel, json) {
    const logger = new AppLogger(serviceName, json);
    logger.setLogLevels(levelsFrom(logLevel));
    return logger;
}
//# sourceMappingURL=logger.js.map