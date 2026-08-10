/**
 * @crm/contracts — единый источник истины по межсервисным интерфейсам.
 *
 * Содержит:
 *   • proto/          — gRPC-контракты (загружаются в рантайме)
 *   • events/         — конверт, каталог routing key и типы payload
 *   • messaging/      — декларативная топология RabbitMQ
 *   • services/       — реестр сервисов: порты, proto-пакеты, базы
 *
 * Именно ради этого пакета выбран монорепозиторий: контракты обязаны быть
 * едиными для всех сервисов, а при отдельных репозиториях потребовался бы
 * приватный npm-registry (docs/architecture.md §11.3).
 */

export * from './proto-path';
export * from './events/envelope';
export * from './events/routing-keys';
export * from './events/payloads';
export * from './messaging/topology';
export * from './services/registry';
