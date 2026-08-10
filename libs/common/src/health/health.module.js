"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HealthModule = exports.GrpcHealthController = exports.HealthController = exports.HealthService = exports.HEALTH_INDICATORS = void 0;
const common_1 = require("@nestjs/common");
const microservices_1 = require("@nestjs/microservices");
exports.HEALTH_INDICATORS = Symbol('HEALTH_INDICATORS');
let HealthService = class HealthService {
    indicators;
    constructor(indicators = []) {
        this.indicators = indicators;
    }
    async readiness() {
        const checks = await Promise.all((this.indicators ?? []).map(async (indicator) => {
            try {
                return await indicator.check();
            }
            catch (error) {
                return {
                    name: indicator.name,
                    healthy: false,
                    detail: error instanceof Error ? error.message : String(error),
                };
            }
        }));
        return { ready: checks.every((c) => c.healthy), checks };
    }
};
exports.HealthService = HealthService;
exports.HealthService = HealthService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Optional)()),
    __param(0, (0, common_1.Inject)(exports.HEALTH_INDICATORS)),
    __metadata("design:paramtypes", [Array])
], HealthService);
let HealthController = class HealthController {
    health;
    constructor(health) {
        this.health = health;
    }
    /** Liveness. Отвечает всегда, пока процесс способен обработать запрос. */
    live() {
        return {
            status: 'ok',
            service: process.env.SERVICE_NAME ?? 'unknown',
            uptimeSec: Math.round(process.uptime()),
        };
    }
    /** Readiness. 200 — готов, 503 — зависимости недоступны. */
    async ready() {
        const result = await this.health.readiness();
        if (!result.ready) {
            // Бросаем объект с кодом, чтобы Nest вернул 503 без отдельного фильтра
            const error = new Error('not ready');
            error.status = 503;
            error.response = { status: 'not_ready', checks: result.checks };
            throw error;
        }
        return { status: 'ready', checks: result.checks };
    }
};
exports.HealthController = HealthController;
__decorate([
    (0, common_1.Get)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], HealthController.prototype, "live", null);
__decorate([
    (0, common_1.Get)('ready'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], HealthController.prototype, "ready", null);
exports.HealthController = HealthController = __decorate([
    (0, common_1.Controller)('health'),
    __metadata("design:paramtypes", [HealthService])
], HealthController);
/** Реализация стандартного grpc.health.v1.Health. */
let GrpcHealthController = class GrpcHealthController {
    health;
    constructor(health) {
        this.health = health;
    }
    async check() {
        const result = await this.health.readiness();
        return { status: result.ready ? 'SERVING' : 'NOT_SERVING' };
    }
};
exports.GrpcHealthController = GrpcHealthController;
__decorate([
    (0, microservices_1.GrpcMethod)('Health', 'Check'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], GrpcHealthController.prototype, "check", null);
exports.GrpcHealthController = GrpcHealthController = __decorate([
    (0, common_1.Controller)(),
    __metadata("design:paramtypes", [HealthService])
], GrpcHealthController);
let HealthModule = class HealthModule {
};
exports.HealthModule = HealthModule;
exports.HealthModule = HealthModule = __decorate([
    (0, common_1.Module)({
        controllers: [HealthController, GrpcHealthController],
        providers: [HealthService],
        exports: [HealthService],
    })
], HealthModule);
//# sourceMappingURL=health.module.js.map