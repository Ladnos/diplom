#!/bin/bash
# ============================================================================
# Создание баз и ролей — по одной на сервис (Database per Service).
#
# Выполняется автоматически при ПЕРВОМ старте контейнера postgres, когда том
# pgdata пуст. Если базы нужно пересоздать: docker compose down -v
#
# Ключевой момент: каждая роль получает доступ ТОЛЬКО к своей базе, и
# CONNECT для PUBLIC отзывается. Это переводит архитектурное правило
# «сервис не ходит в чужую БД» из договорённости в ограничение СУБД:
# нарушить его нельзя даже случайно, подставив не тот DATABASE_URL.
#
# docs/architecture.md §1 (допущение 2), §2.1
# ============================================================================
set -euo pipefail

SERVICE_PASSWORD="${POSTGRES_SERVICE_PASSWORD:?переменная POSTGRES_SERVICE_PASSWORD не задана}"

# db_name:role_name
DATABASES=(
  "auth_db:auth_svc"
  "hr_db:hr_svc"
  "approval_db:approval_svc"
  "task_db:task_svc"
  "chat_db:chat_svc"
  "video_db:video_svc"
  "file_db:file_svc"
  "notification_db:notification_svc"
  "analytics_db:analytics_svc"
  # attendance_db ЗАРЕЗЕРВИРОВАНА под будущий сервис фактического учёта
  # времени (docs/architecture.md §3.4) и сейчас не создаётся.
)

echo "Создание баз данных сервисов..."

for entry in "${DATABASES[@]}"; do
  db="${entry%%:*}"
  role="${entry##*:}"

  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
    CREATE ROLE $role WITH LOGIN PASSWORD '$SERVICE_PASSWORD';
    CREATE DATABASE $db WITH OWNER = $role ENCODING = 'UTF8';

    -- Никто, кроме владельца, не должен даже подключаться
    REVOKE ALL ON DATABASE $db FROM PUBLIC;
    GRANT CONNECT, TEMPORARY ON DATABASE $db TO $role;
EOSQL

  # Схема public принадлежит сервисной роли: Prisma создаёт таблицы в ней
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<-EOSQL
    ALTER SCHEMA public OWNER TO $role;
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    GRANT ALL ON SCHEMA public TO $role;
EOSQL

  echo "  ✓ $db (владелец $role)"
done

echo "Готово: создано ${#DATABASES[@]} баз."
