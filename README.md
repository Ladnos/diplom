# CRM для учёта работы сотрудников

Open source, self-hosted CRM: кадровый учёт и графики работы, расчётный табель,
согласование заявок, Kanban-доска, корпоративный чат и видеозвонки.

Микросервисная архитектура на **NestJS**, синхронное взаимодействие через
**gRPC**, асинхронное — через **RabbitMQ**, всё в **Docker**.

Полное описание архитектуры и обоснование решений: [`docs/architecture.md`](docs/architecture.md).

---

## Быстрый старт

```bash
cp .env.example .env          # обязательно поменяйте секреты
docker compose up -d
```

Приложение поднимется на <http://localhost:8080>.

При первом запуске PostgreSQL сам создаст 9 баз и ролей — по одной на сервис.
Дальше нужно создать таблицы:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
npm install
npm run prisma:push
```

Проверить, что всё живо:

```bash
docker compose ps                          # все контейнеры healthy
curl http://localhost:8080/healthz          # nginx
curl http://localhost:3002/health/ready     # hr-service + его БД
```

---

## Состав системы

**10 сервисов**: 1 краевой + 9 доменных.

| Сервис | gRPC | HTTP | База | Ответственность |
|---|---|---|---|---|
| `api-gateway` | — | 3000 | — (Redis) | REST + WebSocket, единая точка входа, BFF-агрегация |
| `auth-service` | 50051 | 3001 | `auth_db` | JWT, RBAC, права «руководитель ↔ подчинённый» |
| `hr-service` | 50052 | 3002 | `hr_db` | Сотрудники, типы найма, графики, отсутствия, табель |
| `approval-service` | 50053 | 3003 | `approval_db` | Заявки, маршруты согласования, делегирование |
| `task-service` | 50054 | 3004 | `task_db` | Kanban: доски, колонки, карточки |
| `chat-service` | 50055 | 3005 | `chat_db` | Каналы, сообщения, треды, упоминания |
| `video-service` | 50056 | 3006 | `video_db` | Комнаты, WebRTC-сигналинг, SFU |
| `file-service` | 50057 | 3008 | `file_db` | Локальное файловое хранилище |
| `notification-service` | 50058 | 3009 | `notification_db` | E-mail, Web Push, in-app |
| `analytics-service` | 50059 | 3010 | `analytics_db` | Отчёты, read-модели CQRS, аудит |

Инфраструктура: PostgreSQL 17, Redis 7, RabbitMQ 4.1 (с плагином отложенных
сообщений), nginx, coturn (профиль `media`), mailhog (профиль `dev`).

> `attendance-service` (порт 50060, база `attendance_db`) **зарезервирован и
> намеренно не разворачивается**. Фактический учёт прихода и ухода не ведётся:
> при окладной оплате он не влияет ни на одно решение, а табель считается как
> `норма по графику − отсутствия + согласованные переработки`.
> Обоснование и задел под почасовых сотрудников — ADR-2 и §3.4 архитектуры.

---

## Структура репозитория

```
├── apps/                        10 приложений NestJS
│   └── <service>/
│       ├── src/                 исходники
│       ├── prisma/schema.prisma схема БД сервиса
│       ├── generated/prisma/    клиент Prisma (не в git)
│       └── Dockerfile
├── libs/
│   ├── contracts/               ЕДИНЫЙ ИСТОЧНИК ИСТИНЫ
│   │   ├── proto/               11 gRPC-контрактов
│   │   └── src/
│   │       ├── events/          конверт, routing key, типы payload
│   │       ├── messaging/       топология RabbitMQ как данные
│   │       └── services/        реестр: порты, пакеты, базы
│   ├── common/                  конфиг, логгер, health, трассировка, bootstrap
│   ├── messaging/               EventPublisher, идемпотентность, outbox
│   └── grpc-clients/            фабрика клиентов, дедлайны, повторы
├── docker/
│   ├── nginx/nginx.conf         X-Accel-Redirect, secure_link, лимиты
│   ├── postgres/init/           создание 9 баз и ролей
│   └── rabbitmq/                образ с плагином x-delayed-message
├── docs/architecture.md         архитектура и ADR
├── scripts/                     codegen.sh, prisma.sh
├── docker-compose.yml           продакшен-конфигурация
└── docker-compose.dev.yml       оверрайд разработчика
```

---

## Команды

```bash
npm run build              # собрать всё (сначала libs, потом apps)
npm run build:libs         # только общие библиотеки
npm run codegen            # перегенерировать TS-типы из .proto (нужен protoc)
npm run lint / format

npm run prisma:generate    # клиенты Prisma для всех сервисов
npm run prisma:push        # схема в БД без миграции (разработка)
npm run prisma:migrate     # создать и применить миграцию
./scripts/prisma.sh studio hr-service

npm run docker:build
npm run docker:up
npm run docker:up:infra    # только postgres + redis + rabbitmq
npm run docker:logs
npm run docker:down
```

### Порядок сборки

Библиотеки собираются **до** приложений: пакеты `@crm/*` резолвятся через
симлинки npm workspaces в собранные `dist`, а не в исходники. В
`tsconfig.base.json` намеренно нет `paths` с алиасами на `src` — иначе каждая
библиотека компилировалась бы внутрь каждого сервиса и падала на `rootDir`.

---

## Разработка

```bash
export COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml
docker compose up -d
```

Оверрайд публикует порты на `127.0.0.1`, включает `LOG_LEVEL=debug`
и человекочитаемые логи, поднимает mailhog.

| Что | Адрес |
|---|---|
| Приложение | <http://localhost:8080> |
| RabbitMQ management | <http://localhost:15672> (`crm` / из `.env`) |
| Mailhog (перехват почты) | <http://localhost:8025> |
| PostgreSQL | `127.0.0.1:15432` |
| Redis | `127.0.0.1:16379` |

**Почему БД на 15432, а не 5432.** На машине разработчика штатные порты часто
заняты локально установленными PostgreSQL и Redis. Тогда `psql` и Prisma молча
подключаются не к тому серверу, а ошибка выглядит как «неверный пароль».

**Почему нужна отдельная сеть `crm-devaccess`.** В основном компоузе сети
`crm-internal` и `crm-data` объявлены `internal: true`. Docker **не публикует**
порты контейнера, подключённого только к внутренним сетям: `publish` молча
игнорируется. Оверрайд добавляет обычную bridge-сеть, а не снимает флаг
`internal`, — так продакшен-изоляция остаётся нетронутой.

---

## Как всё связано

**gRPC** — когда ответ нужен, чтобы продолжить обработку запроса пользователя.
**RabbitMQ** — когда потеря сообщения недопустима, но ответ не нужен.
**Redis Pub/Sub** — для эфемерных сигналов, которые *обязаны* теряться при сбое
(индикатор набора текста живёт 3 секунды; доставленный с опозданием, он врёт).

Топология брокера описана данными в
[`libs/contracts/src/messaging/topology.ts`](libs/contracts/src/messaging/topology.ts)
и применяется каждым сервисом при старте идемпотентно, поэтому порядок запуска
контейнеров не важен.

Посмотреть реальную таблицу маршрутизации:

```bash
docker compose exec rabbitmq rabbitmqctl list_bindings source_name routing_key destination_name
```

### Гарантии

| Проблема | Решение |
|---|---|
| Событие потеряно между COMMIT и публикацией | Транзакционный outbox — таблица `outbox` в каждой БД |
| Дублирование при at-least-once | Таблица `processed_events`, составной ключ `(event_id, consumer)` |
| Ошибка обработки | `nack(requeue: false)` → `crm.dlx` → `<queue>.dlq` |
| Сервис ходит в чужую БД | Роль сервиса не имеет `CONNECT` к чужим базам — проверяется СУБД, а не договорённостью |

---

## Состояние проекта

Каркас готов, реализован **первый вертикальный срез** `auth → hr`.

**Работает:**

- регистрация, вход, обновление токенов с ротацией refresh и обнаружением
  повторного использования (признак кражи → отзыв всех сессий);
- пароли на scrypt из стандартной библиотеки Node, без нативных зависимостей;
- RBAC со **scope**: `SELF` / `SUBORDINATE` / `DEPARTMENT` / `GLOBAL`. Широкая
  область не включает узкую — поэтому руководитель не может утвердить
  собственный отпуск;
- проекция оргструктуры в `auth_db` с транзитивным замыканием дерева
  подчинения: проверка прав не ходит в `hr-service` и укладывается в 500 мс;
- **модель найма** — тип найма × форма оплаты → политика учёта времени,
  история договоров, перевод ГПХ ↔ штат;
- транзакционный **outbox** с воркером публикации и дедупликация потребителей;
- REST-слой gateway с guard'ами и BFF-агрегацией `GET /api/auth/me`.

Сквозной сценарий, проверенный на живом стенде:

```
POST /api/auth/register
  → auth_db: user + outbox (одна транзакция)
  → OutboxWorker → crm.events: auth.user.registered
  → hr-service: профиль + договор LABOR_CONTRACT/SALARY → NORM_BASED
  → crm.events: hr.employee.created
  → auth-service: связывает user.employee_id, строит замыкание
POST /api/auth/login  →  GET /api/auth/me  →  профиль виден целиком
```

**Ещё не реализовано:** графики и табель (`hr`), согласования (`approval`),
Kanban, чат, звонки, файлы, уведомления, аналитика, WebSocket-слой.

Порядок дальнейшей работы — §14 архитектуры. Каждый шаг вводит ровно один новый
архитектурный механизм поверх уже работающих:

1. ~~`auth → hr` — регистрация и событие `auth.user.registered`~~ ✅
2. `hr` целиком — графики, отсутствия, расчётный табель
3. `approval` — сага согласования с подтверждающим событием
4. `task` → `chat` (WebSocket и Redis Pub/Sub) → `file` (X-Accel-Redirect) → `video`
5. `notification`, `analytics`

---

## Лицензия

MIT
