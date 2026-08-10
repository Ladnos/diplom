"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertTopology = assertTopology;
const common_1 = require("@nestjs/common");
const amqp = __importStar(require("amqplib"));
const contracts_1 = require("@crm/contracts");
/**
 * Объявление топологии RabbitMQ перед подключением потребителя.
 * docs/architecture.md §7.1
 *
 * Каждый сервис объявляет обменники и СВОЮ очередь с привязками. Операции
 * идемпотентны, поэтому порядок старта контейнеров не важен: кто первый
 * поднялся, тот и создал обменники, остальные получат их готовыми.
 *
 * Почему не доверить это транспорту NestJS: он привязывает к обменнику все
 * паттерны из @EventPattern скопом, а нам нужны разные паттерны для
 * crm.events и crm.commands в одной очереди. Поэтому топология
 * объявляется здесь явно, а транспорт подключается с noAssert: true.
 */
async function assertTopology(rabbitUrl, queue, instanceSuffix) {
    const logger = new common_1.Logger('Topology');
    let connection;
    try {
        connection = await amqp.connect(rabbitUrl);
        const channel = await connection.createChannel();
        for (const exchange of contracts_1.EXCHANGE_DEFINITIONS) {
            try {
                await channel.assertExchange(exchange.name, exchange.type, exchange.options);
            }
            catch (error) {
                // x-delayed-message требует плагина rabbitmq_delayed_message_exchange.
                // Без него отложенные повторы недоступны, но остальная система
                // работает — поэтому предупреждение, а не падение.
                if (exchange.type === 'x-delayed-message') {
                    logger.warn({
                        message: 'обменник crm.retry не создан: нет плагина rabbitmq_delayed_message_exchange. ' +
                            'Отложенные повторы отключены, отказы уйдут сразу в DLQ',
                        error: error instanceof Error ? error.message : String(error),
                    });
                    // Канал после ошибки непригоден — открываем новый
                    await connection.createChannel().then((ch) => Object.assign(channel, ch));
                    continue;
                }
                throw error;
            }
        }
        if (queue) {
            const queueName = queue.perInstance && instanceSuffix
                ? `${queue.name}.${instanceSuffix}`
                : queue.name;
            await channel.assertQueue(queueName, {
                durable: true,
                arguments: (0, contracts_1.withDeadLetter)(queueName),
                ...queue.options,
            });
            for (const binding of queue.bindings) {
                for (const pattern of binding.patterns) {
                    await channel.bindQueue(queueName, binding.exchange, pattern);
                }
            }
            // DLQ: сюда попадает то, что не разобралось за MAX_RETRY_ATTEMPTS
            const dlq = (0, contracts_1.dlqName)(queueName);
            await channel.assertQueue(dlq, { durable: true });
            await channel.bindQueue(dlq, contracts_1.Exchanges.DLX, dlq);
            logger.log({
                message: 'топология объявлена',
                queue: queueName,
                bindings: queue.bindings.reduce((sum, b) => sum + b.patterns.length, 0),
            });
        }
        else {
            logger.log({ message: 'обменники объявлены, очередь не требуется' });
        }
        await channel.close();
    }
    finally {
        await connection?.close().catch(() => undefined);
    }
}
//# sourceMappingURL=assert-topology.js.map