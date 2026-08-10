"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrapService = bootstrapService;
const node_os_1 = require("node:os");
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const microservices_1 = require("@nestjs/microservices");
const contracts_1 = require("@crm/contracts");
const env_1 = require("../config/env");
const logger_1 = require("../logging/logger");
const assert_topology_1 = require("../messaging/assert-topology");
const correlation_1 = require("../tracing/correlation");
async function bootstrapService(options) {
    const { service, module, httpHost = '0.0.0.0', skipRmq = false } = options;
    const config = (0, env_1.loadBaseConfig)();
    const logger = new common_1.Logger('Bootstrap');
    process.env.SERVICE_NAME = service.name;
    const app = await core_1.NestFactory.create(module, {
        logger: (0, logger_1.createLogger)(service.name, config.logLevel, config.isProduction),
        bufferLogs: true,
    });
    app.useGlobalPipes(new common_1.ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    app.useGlobalInterceptors(new correlation_1.CorrelationInterceptor());
    app.enableShutdownHooks();
    // ── gRPC-сервер ──────────────────────────────────────────────────────────
    // Вместе с доменным контрактом всегда грузится health.proto: стандартный
    // grpc.health.v1.Health нужен клиентам для circuit breaker (§6.4).
    if (service.grpcPort && service.protoFile && service.protoPackage) {
        app.connectMicroservice({
            transport: microservices_1.Transport.GRPC,
            options: {
                package: [service.protoPackage, 'grpc.health.v1'],
                protoPath: [(0, contracts_1.protoPath)(service.protoFile), (0, contracts_1.protoPath)('health')],
                url: `0.0.0.0:${service.grpcPort}`,
                // includeDirs нужен, чтобы разрешался `import "common.proto"`
                loader: { ...contracts_1.GRPC_LOADER_OPTIONS, includeDirs: [contracts_1.PROTO_DIR] },
            },
        }, { inheritAppConfig: true });
    }
    // ── Потребитель RabbitMQ ─────────────────────────────────────────────────
    const queueDef = (0, contracts_1.queueForService)(service.name);
    if (queueDef && !skipRmq) {
        // Очередь на инстанс получает суффикс из hostname: в Docker это id
        // контейнера, поэтому у каждой реплики gateway своя очередь и WS-событие
        // доходит до всех клиентов, а не до подключённых к одной реплике (§8.1).
        const queueName = queueDef.perInstance ? `${queueDef.name}.${(0, node_os_1.hostname)()}` : queueDef.name;
        // Топология объявляется ЯВНО до подключения транспорта: одна очередь
        // может быть привязана и к crm.events, и к crm.commands с разными
        // паттернами, чего автоматическая привязка NestJS не умеет.
        await (0, assert_topology_1.assertTopology)(config.rabbitmqUrl, queueDef, (0, node_os_1.hostname)());
        app.connectMicroservice({
            transport: microservices_1.Transport.RMQ,
            options: {
                urls: [config.rabbitmqUrl],
                queue: queueName,
                // Очередь и привязки уже созданы assertTopology — транспорту
                // остаётся только читать из неё.
                noAssert: true,
                wildcards: true,
                noAck: false,
                prefetchCount: queueDef.prefetch,
                persistent: true,
            },
        }, { inheritAppConfig: true });
    }
    else if (!queueDef) {
        // Сервис ничего не потребляет, но обменники всё равно должны
        // существовать: он может публиковать события.
        await (0, assert_topology_1.assertTopology)(config.rabbitmqUrl).catch((error) => {
            logger.warn({
                message: 'обменники не объявлены при старте',
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }
    await app.startAllMicroservices();
    await app.listen(service.httpPort, httpHost);
    logger.log({
        message: 'сервис запущен',
        service: service.name,
        grpc: service.grpcPort ? `0.0.0.0:${service.grpcPort}` : 'нет',
        http: `${httpHost}:${service.httpPort}`,
        queue: queueDef && !skipRmq ? queueDef.name : 'нет подписок',
        env: config.nodeEnv,
    });
    return app;
}
//# sourceMappingURL=bootstrap.js.map