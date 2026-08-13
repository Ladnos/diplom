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

# WSL определяется по отметке Microsoft в версии ядра — так делает и сам
# дистрибутив. Переменная WSL_DISTRO_NAME есть не всегда: под sudo и в
# службах окружение обрезается.
IS_WSL=false
if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
  IS_WSL=true
  ok "WSL: $(grep -oiE 'microsoft[^ ]*' /proc/version | head -1)"
fi

if ! command -v docker >/dev/null; then
  if $IS_WSL; then
    fail "docker не найден. В Docker Desktop включите Settings → Resources → WSL Integration для этого дистрибутива, либо поставьте docker внутрь WSL"
  fi
  fail "docker не найден"
fi

docker compose version >/dev/null 2>&1 || fail "нужен docker compose v2 (плагин docker-compose-plugin)"

if ! docker info >/dev/null 2>&1; then
  if $IS_WSL; then
    fail "демон docker недоступен — запущен ли Docker Desktop в Windows?"
  fi
  fail "демон docker недоступен — запущен ли он и есть ли права у пользователя?"
fi
ok "docker $(docker version --format '{{.Server.Version}}')"

# ── Переводы строк ──────────────────────────────────────────────────────────
#
# Git для Windows при клоне подменяет LF на CRLF. В репозитории есть
# .gitattributes, который это запрещает, но клон мог быть сделан до его
# появления либо файл правили в блокноте. Симптомы бессмысленные: пароль
# на экране верный, а сервис отвергает вход, потому что в конце \r.
#
# Чиним молча: спрашивать разрешения на удаление невидимого символа,
# который здесь не нужен никогда, значит требовать решения там, где
# правильный ответ один.
if grep -qlU $'\r' scripts/*.sh 2>/dev/null; then
  warn "в скриптах найдены windows-переводы строк — исправляю"
  find scripts -name '*.sh' -exec sed -i 's/\r$//' {} +
  ok "переводы строк приведены к LF"
fi

# Свободного места нужно порядочно: образы с Prisma и mediasoup крупные.
# У Docker Desktop образы лежат в виртуальном диске WSL, и /var/lib/docker
# в дистрибутиве не существует — тогда смотрим на корень.
DOCKER_ROOT=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /)
[ -d "$DOCKER_ROOT" ] || DOCKER_ROOT=/
FREE_GB=$(df -BG --output=avail "$DOCKER_ROOT" 2>/dev/null | tail -1 | tr -dc '0-9')
if [ -n "${FREE_GB:-}" ] && [ "$FREE_GB" -lt 10 ]; then
  warn "свободно ${FREE_GB} ГБ — образы могут не поместиться, нужно около 10"
fi

# ── Расположение репозитория ────────────────────────────────────────────────
#
# Каталог под /mnt/ — это диск Windows, подключённый через 9p. Он в разы
# медленнее родной файловой системы WSL, а inotify на нём не работает
# вовсе, поэтому пересборка при разработке интерфейса не срабатывает.
# Сборка отсюда возможна, но занимает заметно дольше.
if $IS_WSL && [[ "$ROOT" == /mnt/* ]]; then
  warn "репозиторий лежит на диске Windows ($ROOT)"
  note "сборка будет в разы медленнее, а слежение за файлами не сработает"
  note "перенесите проект в файловую систему WSL, например в ~/diplom"
  echo
  read -r -p "  Продолжить отсюда? [y/N] " answer
  [[ "$answer" =~ ^[Yy] ]] || fail "отменено"
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

  # .env мог быть отредактирован в Windows. Символ \r попал бы в пароль и
  # дал бы отказ входа с совершенно верным паролем на экране.
  if grep -qU $'\r' .env 2>/dev/null; then
    sed -i 's/\r$//' .env
    ok "из .env убраны windows-переводы строк"
  fi

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
  sed -i 's/\r$//' .env

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

# Из WSL браузер живёт в Windows. Порт туда пробрасывает сам WSL2, так что
# адрес тот же — но открыть его отсюда просто так нельзя, нужен вызов
# windows-приложения.
if $IS_WSL; then
  note "адрес открывается в браузере Windows — порт пробрасывается автоматически"
  if command -v explorer.exe >/dev/null 2>&1; then
    read -r -p "  Открыть браузер? [Y/n] " answer
    # explorer.exe возвращает ненулевой код даже при успехе — не считаем
    # это ошибкой и не даём set -e прервать скрипт на последнем шаге
    [[ "$answer" =~ ^[Nn] ]] || explorer.exe "http://localhost:${PORT}" || true
  fi
  echo
fi

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
