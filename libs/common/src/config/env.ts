/**
 * Чтение и валидация переменных окружения.
 *
 * Сервис падает на старте, если обязательная переменная отсутствует или
 * некорректна. Это осознанный выбор: контейнер, поднявшийся с пустым
 * DATABASE_URL, отвалится позже и в непредсказуемом месте, а fail-fast
 * виден сразу в `docker compose logs`.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Ошибка конфигурации: ${message}`);
    this.name = 'ConfigError';
  }
}

export function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    throw new ConfigError(`переменная ${key} не задана`);
  }
  return value;
}

export function optionalEnv(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

export function numberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`переменная ${key} должна быть числом, получено "${raw}"`);
  }
  return parsed;
}

export function booleanEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export type NodeEnv = 'development' | 'production' | 'test';

export interface BaseConfig {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  logLevel: string;
  rabbitmqUrl: string;
  redisUrl: string;
}

export function loadBaseConfig(): BaseConfig {
  const nodeEnv = optionalEnv('NODE_ENV', 'development') as NodeEnv;
  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
    rabbitmqUrl: buildRabbitUrl(),
    redisUrl: buildRedisUrl(),
  };
}

export function buildRabbitUrl(): string {
  if (process.env.RABBITMQ_URL) return process.env.RABBITMQ_URL;
  const user = encodeURIComponent(optionalEnv('RABBITMQ_USER', 'crm'));
  const pass = encodeURIComponent(optionalEnv('RABBITMQ_PASSWORD', 'crm'));
  const host = optionalEnv('RABBITMQ_HOST', 'rabbitmq');
  const port = numberEnv('RABBITMQ_PORT', 5672);
  const vhost = optionalEnv('RABBITMQ_VHOST', '/');
  const vhostPath = vhost === '/' ? '' : `/${encodeURIComponent(vhost)}`;
  return `amqp://${user}:${pass}@${host}:${port}${vhostPath}`;
}

export function buildRedisUrl(): string {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  const pass = process.env.REDIS_PASSWORD;
  const auth = pass ? `:${encodeURIComponent(pass)}@` : '';
  const host = optionalEnv('REDIS_HOST', 'redis');
  const port = numberEnv('REDIS_PORT', 6379);
  return `redis://${auth}${host}:${port}`;
}
