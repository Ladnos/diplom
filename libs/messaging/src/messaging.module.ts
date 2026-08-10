import { DynamicModule, Global, Module, Provider } from '@nestjs/common';
import { ClientProxyFactory, Transport } from '@nestjs/microservices';
import { Exchanges } from '@crm/contracts';
import { buildRabbitUrl } from '@crm/common';
import { EventPublisher } from './event-publisher';
import { COMMANDS_CLIENT, EVENTS_CLIENT } from './tokens';

function createClientFactory(exchange: string) {
  return () =>
    ClientProxyFactory.create({
      transport: Transport.RMQ,
      options: {
        urls: [buildRabbitUrl()],
        exchange,
        exchangeType: 'topic',
        // wildcards переводит клиент в режим публикации по routing key:
        // ключом становится первый аргумент emit(). Без него транспорт
        // писал бы в одну именованную очередь, минуя маршрутизацию.
        wildcards: true,
        persistent: true,
        // Обменник уже создан assertTopology при старте сервиса.
        noAssert: true,
        // Клиент только публикует, своя очередь ему не нужна.
        queue: '',
      },
    });
}

@Global()
@Module({})
export class MessagingModule {
  static forRoot(): DynamicModule {
    const providers: Provider[] = [
      { provide: EVENTS_CLIENT, useFactory: createClientFactory(Exchanges.EVENTS) },
      { provide: COMMANDS_CLIENT, useFactory: createClientFactory(Exchanges.COMMANDS) },
      EventPublisher,
    ];

    return {
      module: MessagingModule,
      providers,
      exports: [EventPublisher, EVENTS_CLIENT, COMMANDS_CLIENT],
    };
  }
}
