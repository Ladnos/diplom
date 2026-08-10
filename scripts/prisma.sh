#!/usr/bin/env bash
# ============================================================================
# Массовые операции Prisma по всем сервисам с базой данных.
#
#   ./scripts/prisma.sh generate            — сгенерировать клиенты
#   ./scripts/prisma.sh push                — залить схему в БД без миграции (dev)
#   ./scripts/prisma.sh migrate <name>      — создать и применить миграцию
#   ./scripts/prisma.sh deploy              — применить миграции (prod)
#   ./scripts/prisma.sh studio hr-service   — открыть Prisma Studio для сервиса
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CMD="${1:-generate}"
shift || true

# Сервисы с собственной базой. api-gateway в списке отсутствует: у него
# нет БД, только Redis (см. docs/architecture.md §2.1).
SERVICES=(
  auth-service
  hr-service
  approval-service
  task-service
  chat-service
  video-service
  file-service
  notification-service
  analytics-service
)

# Загружаем .env, если он есть — нужен DATABASE_URL для операций с БД
if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi

# Скрипт запускается С ХОСТА, а внутри контейнеров postgres доступен по
# имени сервиса. Поэтому хост по умолчанию 127.0.0.1: нужен запущенный
# docker-compose.dev.yml, который публикует 5432 наружу.
DB_HOST="${PRISMA_DB_HOST:-127.0.0.1}"
# 15432, а не 5432 — см. комментарий в docker-compose.dev.yml: штатный порт
# на машине разработчика обычно занят локальным PostgreSQL.
DB_PORT="${PRISMA_DB_PORT:-15432}"
DB_PASSWORD="${POSTGRES_SERVICE_PASSWORD:-}"

# Каждый сервис ходит в свою базу под своей ролью — та же изоляция, что
# и в рантайме (docker/postgres/init/01-init-databases.sh). Запуск миграций
# под суперпользователем скрыл бы ошибки прав до продакшена.
service_database_url() {
  local svc="$1"
  local base="${svc%-service}"       # auth-service → auth
  base="${base//-/_}"
  echo "postgresql://${base}_svc:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${base}_db?schema=public"
}

run_for_service() {
  local svc="$1"; shift
  local schema="$ROOT/apps/$svc/prisma/schema.prisma"
  [ -f "$schema" ] || { echo "  пропуск $svc: нет schema.prisma"; return 0; }
  echo "── $svc"
  ( cd "$ROOT/apps/$svc" \
      && DATABASE_URL="$(service_database_url "$svc")" \
         npx prisma "$@" --schema=prisma/schema.prisma )
}

case "$CMD" in
  generate)
    for s in "${SERVICES[@]}"; do run_for_service "$s" generate; done ;;
  push)
    for s in "${SERVICES[@]}"; do run_for_service "$s" db push --skip-generate; done ;;
  migrate)
    NAME="${1:-init}"
    for s in "${SERVICES[@]}"; do run_for_service "$s" migrate dev --name "$NAME"; done ;;
  deploy)
    for s in "${SERVICES[@]}"; do run_for_service "$s" migrate deploy; done ;;
  studio)
    SVC="${1:?укажите сервис, например: ./scripts/prisma.sh studio hr-service}"
    run_for_service "$SVC" studio ;;
  *)
    echo "Неизвестная команда: $CMD" >&2
    sed -n '3,12p' "$0" >&2
    exit 1 ;;
esac

echo "Готово."
