import { QueueDefinition } from '@crm/contracts';
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
export declare function assertTopology(rabbitUrl: string, queue?: QueueDefinition, instanceSuffix?: string): Promise<void>;
//# sourceMappingURL=assert-topology.d.ts.map