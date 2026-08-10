# syntax=docker/dockerfile:1
# ════════════════════════════════════════════════════════════════════════════
#  hr-service — HTTP 3002 (health), gRPC 50052
#
#  Контекст сборки — КОРЕНЬ репозитория, а не каталог сервиса: монорепозиторий
#  использует npm workspaces, и общие библиотеки @crm/* должны попасть в образ.
#      docker build -f apps/hr-service/Dockerfile .
#  В docker-compose это задано через build.context: .
# ════════════════════════════════════════════════════════════════════════════

# ── Сборка ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# openssl нужен движку запросов Prisma
RUN apk add --no-cache openssl

# Манифесты копируются до исходников: слой с npm ci переиспользуется, пока
# не менялись зависимости, и пересборка после правки кода не тянет установку.
COPY package.json package-lock.json tsconfig.base.json ./
COPY libs/contracts/package.json      libs/contracts/
COPY libs/common/package.json         libs/common/
COPY libs/messaging/package.json      libs/messaging/
COPY libs/grpc-clients/package.json   libs/grpc-clients/
COPY apps/api-gateway/package.json          apps/api-gateway/
COPY apps/auth-service/package.json         apps/auth-service/
COPY apps/hr-service/package.json           apps/hr-service/
COPY apps/approval-service/package.json     apps/approval-service/
COPY apps/task-service/package.json         apps/task-service/
COPY apps/chat-service/package.json         apps/chat-service/
COPY apps/video-service/package.json        apps/video-service/
COPY apps/file-service/package.json         apps/file-service/
COPY apps/notification-service/package.json apps/notification-service/
COPY apps/analytics-service/package.json    apps/analytics-service/

RUN npm ci

COPY libs ./libs
COPY apps/hr-service ./apps/hr-service

RUN npx prisma generate --schema=apps/hr-service/prisma/schema.prisma

# Порядок обязателен: приложения импортируют @crm/* через симлинки
# workspaces в собранные dist, а не в исходники (см. tsconfig.base.json).
RUN npm run build:libs \
 && npm run build --workspace=@crm/hr-service

# Убираем devDependencies: typescript, @nestjs/cli, prisma CLI и прочее
# в рантайме не нужны, а весят больше самого приложения.
RUN npm prune --omit=dev \
 && find apps -mindepth 1 -maxdepth 1 -type d ! -name 'hr-service' -exec rm -rf {} + \
 && rm -rf /root/.npm /app/libs/*/src

# ── Рантайм ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# tini как init: без него node становится PID 1 и не получает SIGTERM,
# из-за чего graceful shutdown не срабатывает и docker stop бьёт по таймауту.
RUN apk add --no-cache openssl tini \
 && addgroup -S crm \
 && adduser -S -G crm -h /app crm

ENV NODE_ENV=production \
    SERVICE_NAME=hr-service

# Копируется целиком: node_modules содержит симлинки на libs/*, которые
# сломались бы при покомпонентном копировании.
COPY --from=builder --chown=crm:crm /app /app

USER crm

EXPOSE 3002 50052

# Проба ходит по HTTP, а не по gRPC: бинарника grpc_health_probe в образе
# нет, а тянуть его ради healthcheck — лишняя зависимость. Сам сервис при
# этом реализует и grpc.health.v1.Health для межсервисных клиентов (§6.4).
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3002/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/hr-service/dist/main.js"]
