/**
 * @crm/messaging — асинхронный обмен через RabbitMQ.
 *
 * Публикация событий и команд, дедупликация потребителя и интерфейс
 * транзакционного outbox.
 *
 * Объявление топологии живёт в @crm/common → assertTopology(): оно должно
 * выполниться до подключения транспорта, то есть внутри bootstrap, а не
 * в DI-контейнере.
 *
 * docs/architecture.md §7
 */

export * from './tokens';
export * from './event-publisher';
export * from './messaging.module';
export * from './idempotency';
export * from './consumer';
