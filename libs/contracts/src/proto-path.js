"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GRPC_LOADER_OPTIONS = exports.PROTO_DIR = void 0;
exports.protoPath = protoPath;
const node_path_1 = require("node:path");
/**
 * Резолвер путей к .proto для загрузки в рантайме через @grpc/proto-loader.
 *
 * Этот файл лежит в КОРНЕ src/ намеренно: после компиляции он оказывается
 * в dist/proto-path.js, поэтому '..' от __dirname всегда указывает на корень
 * пакета libs/contracts, где лежит каталог proto/. Вложенность сломала бы
 * расчёт, поэтому переносить файл в подкаталог нельзя.
 */
exports.PROTO_DIR = (0, node_path_1.join)(__dirname, '..', 'proto');
/** Абсолютный путь к контракту: protoPath('hr') → .../libs/contracts/proto/hr.proto */
function protoPath(name) {
    return (0, node_path_1.join)(exports.PROTO_DIR, `${name}.proto`);
}
/**
 * Опции загрузчика, единые для всех сервисов.
 *
 * keepCase: true — имена полей остаются snake_case, как в .proto. Иначе
 * контракт и код разъезжаются: в .proto `employee_id`, а в TypeScript
 * `employeeId`, и при чтении логов gRPC приходится держать в голове
 * два варианта одного имени.
 *
 * longs: String — int64 в JavaScript не помещается в number; строка
 * безопаснее молчаливой потери точности.
 */
exports.GRPC_LOADER_OPTIONS = {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    arrays: true,
    objects: true,
};
//# sourceMappingURL=proto-path.js.map