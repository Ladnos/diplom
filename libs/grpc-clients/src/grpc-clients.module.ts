import { DynamicModule, Module, Provider } from '@nestjs/common';
import { ClientProxyFactory, Transport } from '@nestjs/microservices';
import {
  GRPC_LOADER_OPTIONS,
  PROTO_DIR,
  ServiceDescriptor,
  grpcAddress,
  protoPath,
} from '@crm/contracts';

/**
 * Типизированные gRPC-клиенты к другим сервисам.
 * docs/architecture.md §6.1, §6.4
 *
 * Адрес берётся из реестра @crm/contracts, а не из строки в коде сервиса:
 * порт задан ровно в одном месте, и рассинхрон «клиент стучится на 50052,
 * сервер слушает 50053» становится невозможен.
 */

export function grpcClientToken(service: ServiceDescriptor): string {
  return `GRPC_CLIENT_${service.name}`;
}

function createProvider(service: ServiceDescriptor): Provider {
  if (!service.protoFile || !service.protoPackage || !service.grpcPort) {
    throw new Error(
      `Сервис ${service.name} не предоставляет gRPC-интерфейс и не может быть клиентом`,
    );
  }

  return {
    provide: grpcClientToken(service),
    useFactory: () =>
      ClientProxyFactory.create({
        transport: Transport.GRPC,
        options: {
          package: [service.protoPackage!, 'grpc.health.v1'],
          protoPath: [protoPath(service.protoFile!), protoPath('health')],
          url: grpcAddress(service),
          loader: { ...GRPC_LOADER_OPTIONS, includeDirs: [PROTO_DIR] },
          // keepalive держит HTTP/2-соединение живым между редкими вызовами:
          // иначе первый запрос после паузы платит за новый TCP+TLS handshake.
          channelOptions: {
            'grpc.keepalive_time_ms': 30_000,
            'grpc.keepalive_timeout_ms': 5_000,
            'grpc.keepalive_permit_without_calls': 1,
            'grpc.max_receive_message_length': 16 * 1024 * 1024,
          },
        },
      }),
  };
}

@Module({})
export class GrpcClientsModule {
  /**
   * Регистрирует клиентов к перечисленным сервисам.
   *
   * @example
   * GrpcClientsModule.register([SERVICES.AUTH, SERVICES.HR])
   */
  static register(services: ServiceDescriptor[]): DynamicModule {
    const providers = services.map(createProvider);
    return {
      module: GrpcClientsModule,
      providers,
      exports: providers.map((p) => (p as { provide: string }).provide),
      global: true,
    };
  }
}
