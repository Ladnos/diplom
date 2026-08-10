import { hostname } from 'node:os';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import {
  GRPC_LOADER_OPTIONS,
  PROTO_DIR,
  ServiceDescriptor,
  protoPath,
  queueForService,
} from '@crm/contracts';
import { loadBaseConfig } from '../config/env';
import { createLogger } from '../logging/logger';
import { assertTopology } from '../messaging/assert-topology';
import { CorrelationInterceptor } from '../tracing/correlation';

/**
 * Общий bootstrap сервиса.
 *
 * Каждый сервис — гибридное приложение: gRPC-сервер для входящих вызовов,
 * RabbitMQ-консьюмер для событий и HTTP под health/metrics (у api-gateway
 * HTTP — это ещё и публичный API с WebSocket).
 *
 * Вынесение сюда даёт две вещи: main.ts каждого сервиса умещается в десять
 * строк, и настройки транспортов (prefetch, DLX, loader) невозможно
 * случайно расстроить между сервисами.
 *
 * docs/architecture.md §6.1, §7.1
 */

export interface BootstrapOptions {
  /** Описание сервиса из реестра @crm/contracts. */
  service: ServiceDescriptor;
  /** Корневой модуль приложения. */
  module: unknown;
  /** Слушать HTTP на 0.0.0.0 — обязательно внутри контейнера. */
  httpHost?: string;
  /** Не подключать потребителя RabbitMQ, даже если очередь описана. */
  skipRmq?: boolean;
}

export async function bootstrapService(options: BootstrapOptions): Promise<INestApplication> {
  const { service, module, httpHost = '0.0.0.0', skipRmq = false } = options;
  const config = loadBaseConfig();
  const logger = new Logger('Bootstrap');

  process.env.SERVICE_NAME = service.name;

  const app = await NestFactory.create(module as never, {
    logger: createLogger(service.name, config.logLevel, config.isProduction),
    bufferLogs: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalInterceptors(new CorrelationInterceptor());
  app.enableShutdownHooks();

  // ── gRPC-сервер ──────────────────────────────────────────────────────────
  // Вместе с доменным контрактом всегда грузится health.proto: стандартный
  // grpc.health.v1.Health нужен клиентам для circuit breaker (§6.4).
  if (service.grpcPort && service.protoFile && service.protoPackage) {
    app.connectMicroservice<MicroserviceOptions>(
      {
        transport: Transport.GRPC,
        options: {
          package: [service.protoPackage, 'grpc.health.v1'],
          protoPath: [protoPath(service.protoFile), protoPath('health')],
          url: `0.0.0.0:${service.grpcPort}`,
          // includeDirs нужен, чтобы разрешался `import "common.proto"`
          loader: { ...GRPC_LOADER_OPTIONS, includeDirs: [PROTO_DIR] },
        },
      },
      { inheritAppConfig: true },
    );
  }

  // ── Потребитель RabbitMQ ─────────────────────────────────────────────────
  const queueDef = queueForService(service.name);
  if (queueDef && !skipRmq) {
    // Очередь на инстанс получает суффикс из hostname: в Docker это id
    // контейнера, поэтому у каждой реплики gateway своя очередь и WS-событие
    // доходит до всех клиентов, а не до подключённых к одной реплике (§8.1).
    const queueName = queueDef.perInstance ? `${queueDef.name}.${hostname()}` : queueDef.name;

    // Топология объявляется ЯВНО до подключения транспорта: одна очередь
    // может быть привязана и к crm.events, и к crm.commands с разными
    // паттернами, чего автоматическая привязка NestJS не умеет.
    await assertTopology(config.rabbitmqUrl, queueDef, hostname());

    app.connectMicroservice<MicroserviceOptions>(
      {
        transport: Transport.RMQ,
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
      },
      { inheritAppConfig: true },
    );
  } else if (!queueDef) {
    // Сервис ничего не потребляет, но обменники всё равно должны
    // существовать: он может публиковать события.
    await assertTopology(config.rabbitmqUrl).catch((error: unknown) => {
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
