
#!/usr/bin/env bash
# ============================================================================
# Первый запуск одной командой.
#
#   ./scripts/setup.sh              полная установка
#   ./scripts/setup.sh --dev        плюс проброс портов сервисов на хост
#   ./scripts/setup.sh --reset      снести данные и поставить заново
#
# Скрипт делает ровно то, что README описывает по шагам: готовит .env с
# настоящими секретами, поднимает стенд, создаёт таблицы и показывает,
# куда идти и под кем входить.
#
# ЗАВИСИМОСТЬ ТОЛЬКО ОДНА — docker. Схемы накатываются одноразовым
# контейнером в сети compose, поэтому ни Node, ни npm, ни проброшенный
# наружу порт PostgreSQL на машине не нужны.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEV=false
RESET=false
for arg in "$@"; do
  case "$arg" in
    --dev) DEV=true ;;
    --reset) RESET=true ;;
    -h|--help)
      # Текст задан явно, а не вырезан из шапки по номерам строк: те
      # разъезжаются при первой же правке комментария, и справка начинает
      # обрываться на полуслове.
      cat <<'HELP'
Первый запуск одной командой.

  ./scripts/setup.sh            полная установка
  ./scripts/setup.sh --dev      плюс проброс портов сервисов на хост
  ./scripts/setup.sh --reset    снести данные и поставить заново

Готовит .env с настоящими секретами, собирает образы, поднимает стенд,
создаёт таблицы во всех девяти базах и показывает адрес приложения
вместе с паролем администратора.

Из зависимостей нужен только docker: схемы накатываются одноразовым
контейнером внутри сети compose.
HELP
      exit 0 ;;
    *) echo "Неизвестный аргумент: $arg" >&2; exit 1 ;;
  esac
done

COMPOSE=(docker compose -f docker-compose.yml)
$DEV && COMPOSE+=(-f docker-compose.dev.yml)

# ── Вывод ───────────────────────────────────────────────────────────────────
# Цвета отключаются, когда вывод идёт не в терминал: в файле журнала
# escape-последовательности только мешают читать.
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  RED=$'\033[31m'; RESET_C=$'\033[0m'
else
  BOLD=''; DIM=''; GREEN=''; YELLOW=''; RED=''; RESET_C=''
fi

step()  { echo; echo "${BOLD}▸ $1${RESET_C}"; }
ok()    { echo "  ${GREEN}✓${RESET_C} $1"; }
warn()  { echo "  ${YELLOW}!${RESET_C} $1"; }
fail()  { echo "  ${RED}✗${RESET_C} $1" >&2; exit 1; }
note()  { echo "  ${DIM}$1${RESET_C}"; }

# ── 0. Проверка окружения ───────────────────────────────────────────────────
step "Проверяю окружение"

command -v docker >/dev/null || fail "docker не найден"
docker compose version >/dev/null 2>&1 || fail "нужен docker compose v2 (плагин docker-compose-plugin)"
docker info >/dev/null 2>&1 || fail "демон docker недоступен — запущен ли он и есть ли права у пользователя?"
ok "docker $(docker version --format '{{.Server.Version}}')"

# Свободного места нужно порядочно: образы с Prisma и mediasoup крупные
FREE_GB=$(df -BG --output=avail /var/lib/docker 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)
if [ "${FREE_GB:-0}" -gt 0 ] && [ "$FREE_GB" -lt 10 ]; then
  warn "на диске под docker меньше 10 ГБ — сборка может не поместиться"
fi

# ── 1. Настройки ────────────────────────────────────────────────────────────
step "Готовлю .env"

random_secret() {
  # openssl есть не везде; /dev/urandom есть всегда
  if command -v openssl >/dev/null; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# Переменные, которые compose требует непустыми. Оставить их со значением
# из .env.example — значит поставить систему с ключами, известными всем,
# у кого есть этот репозиторий.
SECRETS=(
  POSTGRES_SUPERUSER_PASSWORD
  POSTGRES_SERVICE_PASSWORD
  REDIS_PASSWORD
  RABBITMQ_PASSWORD
  JWT_ACCESS_SECRET
  JWT_REFRESH_SECRET
  FILE_SIGNED_LINK_SECRET
  VIDEO_JOIN_TOKEN_SECRET
)

if [ -f .env ]; then
  ok ".env уже есть — оставляю как есть"

  # Проверяем, что обязательные переменные заданы и не остались примерами
  MISSING=()
  for key in "${SECRETS[@]}"; do
    value=$(grep -E "^${key}=" .env | head -1 | cut -d= -f2- || true)
    if [ -z "$value" ] || [[ "$value" == change_me* ]]; then
      MISSING+=("$key")
    fi
  done

  if [ ${#MISSING[@]} -gt 0 ]; then
    warn "не заданы или остались примерами: ${MISSING[*]}"
    read -r -p "  Сгенерировать их сейчас? [Y/n] " answer
    if [[ ! "$answer" =~ ^[Nn] ]]; then
      for key in "${MISSING[@]}"; do
        secret=$(random_secret)
        if grep -qE "^${key}=" .env; then
          # Разделитель | вместо / — в hex его не бывает, а в путях бывает
          sed -i "s|^${key}=.*|${key}=${secret}|" .env
        else
          echo "${key}=${secret}" >> .env
        fi
      done
      ok "сгенерировано секретов: ${#MISSING[@]}"
    else
      fail "без этих переменных compose не стартует"
    fi
  else
    ok "обязательные переменные заданы"
  fi
else
  [ -f .env.example ] || fail ".env.example не найден — вы в корне репозитория?"
  cp .env.example .env

  for key in "${SECRETS[@]}"; do
    secret=$(random_secret)
    if grep -qE "^${key}=" .env; then
      sed -i "s|^${key}=.*|${key}=${secret}|" .env
    else
      echo "${key}=${secret}" >> .env
    fi
  done
  ok ".env создан, ${#SECRETS[@]} секретов сгенерировано"
  note "файл в .gitignore — в репозиторий не попадёт"
fi

# ── 2. Сброс, если попросили ────────────────────────────────────────────────
if $RESET; then
  step "Сношу прежнюю установку"
  read -r -p "  Будут удалены ВСЕ данные: базы, файлы, очереди. Продолжить? [y/N] " answer
  [[ "$answer" =~ ^[Yy] ]] || fail "отменено"

  "${COMPOSE[@]}" down -v --remove-orphans
  ok "контейнеры и тома удалены"
fi

# ── 3. Сборка и запуск ──────────────────────────────────────────────────────
step "Собираю образы"
note "первая сборка занимает 10–20 минут: дольше всего собирается"
note "нативный воркер mediasoup для SFU видеозвонков"

"${COMPOSE[@]}" build

step "Запускаю стенд"
"${COMPOSE[@]}" up -d

# ── 4. Ожидание готовности ──────────────────────────────────────────────────
# Ждём именно PostgreSQL: схемы накатывать не во что, пока он не поднялся.
step "Жду PostgreSQL"

for attempt in $(seq 1 60); do
  state=$(docker inspect --format '{{.State.Health.Status}}' crm-postgres 2>/dev/null || echo starting)
  [ "$state" = "healthy" ] && break
  [ "$attempt" -eq 60 ] && fail "PostgreSQL не поднялся за минуту: ${COMPOSE[*]} logs postgres"
  sleep 1
done
ok "PostgreSQL готов"

# ── 5. Схемы баз данных ─────────────────────────────────────────────────────
#
# Одноразовым контейнером в сети compose, а не с хоста: так не нужны ни
# Node на машине, ни проброшенный наружу порт PostgreSQL — обращение идёт
# к `postgres` по имени, ровно как у остальных контейнеров.
step "Создаю таблицы"

# Сеть данных объявлена internal: маршрута в интернет у неё нет (§11.1), и
# скачать Prisma изнутри не получится. Поэтому CLI кладётся в образ
# заранее — у сборки доступ в сеть есть. Заодно это один запуск на девять
# баз вместо девяти установок подряд.
docker build -q -t crm-migrator:local - >/dev/null <<'DOCKERFILE'
FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /work
RUN npm init -y >/dev/null && npm i prisma@6 --no-audit --no-fund
ENTRYPOINT ["/bin/sh", "-c"]
DOCKERFILE
ok "инструмент миграций готов"

NETWORK=$(docker inspect crm-postgres \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' \
  | tr ' ' '\n' | grep -- '-data' | head -1)
[ -n "$NETWORK" ] || fail "не нашёл сеть данных: поднялся ли стенд?"

# shellcheck disable=SC1091
set -a; . ./.env; set +a

# Схема копируется внутрь контейнера, а не открывается по месту: каталог
# репозитория примонтирован только для чтения, а Prisma пишет рядом со
# схемой свои временные файлы.
if docker run --rm \
    --network "$NETWORK" \
    -v "$ROOT/apps:/schemas:ro" \
    -e "PGPASS=$POSTGRES_SERVICE_PASSWORD" \
    crm-migrator:local '
      failed=0
      for svc in auth hr approval task chat video file notification analytics; do
        cp "/schemas/${svc}-service/prisma/schema.prisma" /work/schema.prisma
        printf "  %-14s" "$svc"
        if DATABASE_URL="postgresql://${svc}_svc:${PGPASS}@postgres:5432/${svc}_db?schema=public" \
             npx prisma db push --schema=/work/schema.prisma \
               --skip-generate --accept-data-loss >/tmp/out 2>&1; then
          echo "ok"
        else
          echo "ОШИБКА"
          tail -5 /tmp/out
          failed=1
        fi
      done
      exit $failed
    '; then
  ok "девять баз готовы"
else
  fail "схемы применились не полностью — см. вывод выше"
fi

# ── 6. Ожидание сервисов ────────────────────────────────────────────────────
step "Жду сервисы"

# Контейнер web не ждём: он собирает статику и штатно завершается
EXPECTED=$("${COMPOSE[@]}" ps --services | grep -v '^web$' | wc -l)

for attempt in $(seq 1 120); do
  healthy=$("${COMPOSE[@]}" ps --format '{{.Name}} {{.Status}}' 2>/dev/null | grep -c 'healthy' || true)
  [ "$healthy" -ge $((EXPECTED - 2)) ] && break
  [ "$attempt" -eq 120 ] && warn "не все сервисы стали healthy за две минуты"
  sleep 1
done

"${COMPOSE[@]}" ps --format '{{.Name}}\t{{.Status}}' | sed 's/^/  /'

# ── 7. Куда идти ────────────────────────────────────────────────────────────
PORT=$(grep -E '^PUBLIC_HTTP_PORT=' .env | cut -d= -f2 || echo 8080)
PORT=${PORT:-8080}

step "Проверяю интерфейс"
for attempt in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/" || echo 000)
  [ "$code" = "200" ] && break
  [ "$attempt" -eq 30 ] && warn "интерфейс не ответил: ${COMPOSE[*]} logs nginx web"
  sleep 1
done
[ "${code:-}" = "200" ] && ok "отдаётся, код 200"

echo
echo "${BOLD}═══════════════════════════════════════════════════════════${RESET_C}"
echo "  ${BOLD}Приложение:${RESET_C}  http://localhost:${PORT}"
echo "${BOLD}═══════════════════════════════════════════════════════════${RESET_C}"
echo

# Пароль администратора печатается в журнал ровно один раз — вылавливаем
# его здесь, чтобы человеку не пришлось искать самому.
ADMIN_LINE=$("${COMPOSE[@]}" logs auth-service 2>/dev/null | grep -A 6 'СОЗДАН АДМИНИСТРАТОР' | tail -8 || true)

if [ -n "$ADMIN_LINE" ]; then
  echo "  ${BOLD}Администратор${RESET_C}"
  echo "$ADMIN_LINE" | grep -E "email|password" | sed "s/^/  ${DIM}/;s/\$/${RESET_C}/" || true
  echo
  warn "пароль показан ОДИН раз: в базе лежит только хэш"
else
  note "Администратор был создан в одном из прежних запусков —"
  note "пароль в журнале уже не найти. Либо зарегистрируйтесь:"
  note "http://localhost:${PORT}/register"
fi

echo
echo "  ${DIM}Журналы:   ${COMPOSE[*]} logs -f${RESET_C}"
echo "  ${DIM}Остановка: ${COMPOSE[*]} down${RESET_C}"
$DEV || echo "  ${DIM}Порты сервисов наружу: ./scripts/setup.sh --dev${RESET_C}"
echo
