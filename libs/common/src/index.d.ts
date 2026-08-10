/**
 * @crm/common — инфраструктурный код, одинаковый для всех сервисов:
 * конфигурация, логирование, health-проверки, трассировка, объявление
 * топологии RabbitMQ и bootstrap.
 *
 * Доменной логики здесь нет и быть не должно: всё, что появляется в этой
 * библиотеке, автоматически становится зависимостью всех десяти сервисов.
 */
export * from './config/env';
export * from './logging/logger';
export * from './health/health.module';
export * from './tracing/correlation';
export * from './messaging/assert-topology';
export * from './bootstrap/bootstrap';
//# sourceMappingURL=index.d.ts.map