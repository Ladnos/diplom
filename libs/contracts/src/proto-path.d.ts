/**
 * Резолвер путей к .proto для загрузки в рантайме через @grpc/proto-loader.
 *
 * Этот файл лежит в КОРНЕ src/ намеренно: после компиляции он оказывается
 * в dist/proto-path.js, поэтому '..' от __dirname всегда указывает на корень
 * пакета libs/contracts, где лежит каталог proto/. Вложенность сломала бы
 * расчёт, поэтому переносить файл в подкаталог нельзя.
 */
export declare const PROTO_DIR: string;
/** Абсолютный путь к контракту: protoPath('hr') → .../libs/contracts/proto/hr.proto */
export declare function protoPath(name: string): string;
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
export declare const GRPC_LOADER_OPTIONS: {
    readonly keepCase: true;
    readonly longs: StringConstructor;
    readonly enums: StringConstructor;
    readonly defaults: true;
    readonly oneofs: true;
    readonly arrays: true;
    readonly objects: true;
};
//# sourceMappingURL=proto-path.d.ts.map