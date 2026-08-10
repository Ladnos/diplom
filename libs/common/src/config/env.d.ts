/**
 * Чтение и валидация переменных окружения.
 *
 * Сервис падает на старте, если обязательная переменная отсутствует или
 * некорректна. Это осознанный выбор: контейнер, поднявшийся с пустым
 * DATABASE_URL, отвалится позже и в непредсказуемом месте, а fail-fast
 * виден сразу в `docker compose logs`.
 */
export declare class ConfigError extends Error {
    constructor(message: string);
}
export declare function requireEnv(key: string): string;
export declare function optionalEnv(key: string, fallback: string): string;
export declare function numberEnv(key: string, fallback: number): number;
export declare function booleanEnv(key: string, fallback: boolean): boolean;
export type NodeEnv = 'development' | 'production' | 'test';
export interface BaseConfig {
    nodeEnv: NodeEnv;
    isProduction: boolean;
    logLevel: string;
    rabbitmqUrl: string;
    redisUrl: string;
}
export declare function loadBaseConfig(): BaseConfig;
export declare function buildRabbitUrl(): string;
export declare function buildRedisUrl(): string;
//# sourceMappingURL=env.d.ts.map