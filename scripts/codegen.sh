#!/usr/bin/env bash
# ============================================================================
# Кодогенерация TypeScript-типов из .proto через ts-proto.
#
# Результат коммитится в репозиторий (libs/contracts/src/generated/), чтобы
# сборка и `docker compose up` не требовали установленного protoc — важно для
# open source self-hosted: контрибьютор делает git clone и запускает проект.
#
# Запускать только при изменении .proto:  npm run codegen
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROTO_DIR="$ROOT/libs/contracts/proto"
OUT_DIR="$ROOT/libs/contracts/src/generated"
PLUGIN="$ROOT/node_modules/.bin/protoc-gen-ts_proto"

if ! command -v protoc >/dev/null 2>&1; then
  echo "ОШИБКА: protoc не найден." >&2
  echo "  Arch:   sudo pacman -S protobuf" >&2
  echo "  Debian: sudo apt install -y protobuf-compiler" >&2
  echo "  macOS:  brew install protobuf" >&2
  exit 1
fi

if [ ! -x "$PLUGIN" ]; then
  echo "ОШИБКА: ts-proto не установлен. Выполните: npm install" >&2
  exit 1
fi

echo "Очистка $OUT_DIR"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

mapfile -t PROTO_FILES < <(find "$PROTO_DIR" -name '*.proto' | sort)
echo "Генерация из ${#PROTO_FILES[@]} .proto файлов"

protoc \
  --plugin="protoc-gen-ts_proto=$PLUGIN" \
  --ts_proto_out="$OUT_DIR" \
  --ts_proto_opt=nestJs=true \
  --ts_proto_opt=addGrpcMetadata=true \
  --ts_proto_opt=addNestjsRestParameter=false \
  --ts_proto_opt=useDate=false \
  --ts_proto_opt=esModuleInterop=true \
  --ts_proto_opt=snakeToCamel=false \
  --ts_proto_opt=outputServices=grpc-js \
  --ts_proto_opt=outputServices=nice-grpc \
  --proto_path="$PROTO_DIR" \
  "${PROTO_FILES[@]}"

# index.ts со ре-экспортом всех сгенерированных модулей
{
  echo "// Файл сгенерирован scripts/codegen.sh — не редактировать вручную."
  for f in "$OUT_DIR"/*.ts; do
    base="$(basename "$f" .ts)"
    [ "$base" = "index" ] && continue
    echo "export * from './$base';"
  done
} > "$OUT_DIR/index.ts"

echo "Готово: $OUT_DIR"
