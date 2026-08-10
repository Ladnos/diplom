"use strict";
/**
 * Реестр сервисов: имена, порты, proto-пакеты, наличие БД.
 * docs/architecture.md §2.1, §11.1
 *
 * Единый источник истины для gRPC-клиентов, bootstrap-хелперов и
 * скриптов Prisma. Порт сервиса задаётся здесь и нигде больше не дублируется.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RESERVED_ATTENDANCE_SERVICE = exports.SERVICES_WITH_DB = exports.SERVICE_LIST = exports.SERVICES = void 0;
exports.grpcAddress = grpcAddress;
exports.SERVICES = {
    API_GATEWAY: {
        name: 'api-gateway',
        httpPort: 3000,
        description: 'REST + WebSocket, единая точка входа, BFF-агрегация',
    },
    AUTH: {
        name: 'auth-service',
        grpcPort: 50051,
        httpPort: 3001,
        protoPackage: 'auth',
        protoFile: 'auth',
        database: 'auth_db',
        description: 'JWT, RBAC, scope-проверки «руководитель ↔ подчинённый»',
    },
    HR: {
        name: 'hr-service',
        grpcPort: 50052,
        httpPort: 3002,
        protoPackage: 'hr',
        protoFile: 'hr',
        database: 'hr_db',
        description: 'Сотрудники, типы найма, графики, отсутствия, табель',
    },
    APPROVAL: {
        name: 'approval-service',
        grpcPort: 50053,
        httpPort: 3003,
        protoPackage: 'approval',
        protoFile: 'approval',
        database: 'approval_db',
        description: 'Заявки, маршруты согласования, делегирование, эскалация',
    },
    TASK: {
        name: 'task-service',
        grpcPort: 50054,
        httpPort: 3004,
        protoPackage: 'task',
        protoFile: 'task',
        database: 'task_db',
        description: 'Kanban: доски, колонки, карточки',
    },
    CHAT: {
        name: 'chat-service',
        grpcPort: 50055,
        httpPort: 3005,
        protoPackage: 'chat',
        protoFile: 'chat',
        database: 'chat_db',
        description: 'Каналы, сообщения, треды, упоминания, поиск',
    },
    VIDEO: {
        name: 'video-service',
        grpcPort: 50056,
        httpPort: 3006,
        protoPackage: 'video',
        protoFile: 'video',
        database: 'video_db',
        description: 'Комнаты, WebRTC-сигналинг (WS на том же порту), управление SFU',
    },
    FILE: {
        name: 'file-service',
        grpcPort: 50057,
        httpPort: 3008,
        protoPackage: 'file',
        protoFile: 'file',
        database: 'file_db',
        description: 'Локальное хранилище, приём загрузок на HTTP-порту',
    },
    NOTIFICATION: {
        name: 'notification-service',
        grpcPort: 50058,
        httpPort: 3009,
        protoPackage: 'notification',
        protoFile: 'notification',
        database: 'notification_db',
        description: 'E-mail, Web Push, in-app. В штатном режиме без входящих gRPC',
    },
    ANALYTICS: {
        name: 'analytics-service',
        grpcPort: 50059,
        httpPort: 3010,
        protoPackage: 'analytics',
        protoFile: 'analytics',
        database: 'analytics_db',
        description: 'Read-модели CQRS, отчёты, журнал аудита',
    },
};
exports.SERVICE_LIST = Object.values(exports.SERVICES);
/** Сервисы с собственной БД — Database per Service. */
exports.SERVICES_WITH_DB = exports.SERVICE_LIST.filter((s) => s.database !== undefined);
/**
 * ЗАРЕЗЕРВИРОВАНО под будущий сервис фактического учёта времени (§3.4, ADR-2).
 * Порт 50060, база attendance_db, очередь attendance.events и префикс
 * routing key attendance.* не заняты ничем другим. Сервис не разворачивается.
 */
exports.RESERVED_ATTENDANCE_SERVICE = {
    name: 'attendance-service',
    grpcPort: 50060,
    httpPort: 3011,
    protoPackage: 'attendance',
    protoFile: 'attendance',
    database: 'attendance_db',
    description: 'НЕ РЕАЛИЗОВАН: фактический учёт для политики FACT_BASED',
};
/** Адрес сервиса из переменной окружения с фолбэком на DNS-имя контейнера. */
function grpcAddress(service) {
    const envKey = `${service.name.replace(/-/g, '_').toUpperCase()}_URL`;
    return process.env[envKey] ?? `${service.name}:${service.grpcPort}`;
}
//# sourceMappingURL=registry.js.map