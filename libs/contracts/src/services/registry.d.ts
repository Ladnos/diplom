/**
 * Реестр сервисов: имена, порты, proto-пакеты, наличие БД.
 * docs/architecture.md §2.1, §11.1
 *
 * Единый источник истины для gRPC-клиентов, bootstrap-хелперов и
 * скриптов Prisma. Порт сервиса задаётся здесь и нигде больше не дублируется.
 */
export interface ServiceDescriptor {
    /** Имя контейнера и рабочей области npm (@crm/<name>). */
    name: string;
    /** gRPC-порт. Не публикуется на хост в продакшен-конфигурации. */
    grpcPort?: number;
    /** HTTP-порт: health/metrics у доменных сервисов, публичный API у gateway. */
    httpPort: number;
    /** Имя пакета в .proto и имя файла контракта. */
    protoPackage?: string;
    protoFile?: string;
    /** База данных. Отсутствует у api-gateway: у него только Redis. */
    database?: string;
    description: string;
}
export declare const SERVICES: {
    readonly API_GATEWAY: {
        readonly name: "api-gateway";
        readonly httpPort: 3000;
        readonly description: "REST + WebSocket, единая точка входа, BFF-агрегация";
    };
    readonly AUTH: {
        readonly name: "auth-service";
        readonly grpcPort: 50051;
        readonly httpPort: 3001;
        readonly protoPackage: "auth";
        readonly protoFile: "auth";
        readonly database: "auth_db";
        readonly description: "JWT, RBAC, scope-проверки «руководитель ↔ подчинённый»";
    };
    readonly HR: {
        readonly name: "hr-service";
        readonly grpcPort: 50052;
        readonly httpPort: 3002;
        readonly protoPackage: "hr";
        readonly protoFile: "hr";
        readonly database: "hr_db";
        readonly description: "Сотрудники, типы найма, графики, отсутствия, табель";
    };
    readonly APPROVAL: {
        readonly name: "approval-service";
        readonly grpcPort: 50053;
        readonly httpPort: 3003;
        readonly protoPackage: "approval";
        readonly protoFile: "approval";
        readonly database: "approval_db";
        readonly description: "Заявки, маршруты согласования, делегирование, эскалация";
    };
    readonly TASK: {
        readonly name: "task-service";
        readonly grpcPort: 50054;
        readonly httpPort: 3004;
        readonly protoPackage: "task";
        readonly protoFile: "task";
        readonly database: "task_db";
        readonly description: "Kanban: доски, колонки, карточки";
    };
    readonly CHAT: {
        readonly name: "chat-service";
        readonly grpcPort: 50055;
        readonly httpPort: 3005;
        readonly protoPackage: "chat";
        readonly protoFile: "chat";
        readonly database: "chat_db";
        readonly description: "Каналы, сообщения, треды, упоминания, поиск";
    };
    readonly VIDEO: {
        readonly name: "video-service";
        readonly grpcPort: 50056;
        readonly httpPort: 3006;
        readonly protoPackage: "video";
        readonly protoFile: "video";
        readonly database: "video_db";
        readonly description: "Комнаты, WebRTC-сигналинг (WS на том же порту), управление SFU";
    };
    readonly FILE: {
        readonly name: "file-service";
        readonly grpcPort: 50057;
        readonly httpPort: 3008;
        readonly protoPackage: "file";
        readonly protoFile: "file";
        readonly database: "file_db";
        readonly description: "Локальное хранилище, приём загрузок на HTTP-порту";
    };
    readonly NOTIFICATION: {
        readonly name: "notification-service";
        readonly grpcPort: 50058;
        readonly httpPort: 3009;
        readonly protoPackage: "notification";
        readonly protoFile: "notification";
        readonly database: "notification_db";
        readonly description: "E-mail, Web Push, in-app. В штатном режиме без входящих gRPC";
    };
    readonly ANALYTICS: {
        readonly name: "analytics-service";
        readonly grpcPort: 50059;
        readonly httpPort: 3010;
        readonly protoPackage: "analytics";
        readonly protoFile: "analytics";
        readonly database: "analytics_db";
        readonly description: "Read-модели CQRS, отчёты, журнал аудита";
    };
};
export type ServiceKey = keyof typeof SERVICES;
export declare const SERVICE_LIST: ServiceDescriptor[];
/** Сервисы с собственной БД — Database per Service. */
export declare const SERVICES_WITH_DB: ServiceDescriptor[];
/**
 * ЗАРЕЗЕРВИРОВАНО под будущий сервис фактического учёта времени (§3.4, ADR-2).
 * Порт 50060, база attendance_db, очередь attendance.events и префикс
 * routing key attendance.* не заняты ничем другим. Сервис не разворачивается.
 */
export declare const RESERVED_ATTENDANCE_SERVICE: {
    readonly name: "attendance-service";
    readonly grpcPort: 50060;
    readonly httpPort: 3011;
    readonly protoPackage: "attendance";
    readonly protoFile: "attendance";
    readonly database: "attendance_db";
    readonly description: "НЕ РЕАЛИЗОВАН: фактический учёт для политики FACT_BASED";
};
/** Адрес сервиса из переменной окружения с фолбэком на DNS-имя контейнера. */
export declare function grpcAddress(service: ServiceDescriptor): string;
//# sourceMappingURL=registry.d.ts.map