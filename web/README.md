# Интерфейс

Nuxt 4 в режиме статической сборки, компоненты shadcn-vue поверх
Tailwind 4. Собирается в `.output/public` и раздаётся `nginx` из общего
тома — отдельного контейнера с Node в рантайме нет.

## Разработка

```bash
npm install
npm run dev        # http://localhost:3000
```

Стенд должен быть поднят: `nuxt.config.ts` проксирует `/api`, `/ws`,
`/signaling` и `/media` на `http://127.0.0.1:8080`. Прокси избавляет от
CORS и от объяснений браузеру, почему запрос к другому источнику несёт
заголовок `Authorization`.

```bash
npm run build      # статика в .output/public
npm run typecheck  # проверка типов без сборки
```

## Почему вне workspaces

Каталог `web/` намеренно не входит в `apps/*` монорепозитория. У него
своё дерево зависимостей — Vue, Vite, Tailwind, mediasoup-client, — и ни
одному из девяти сервисов оно не нужно. При включении в workspaces
`npm ci` в образе каждого сервиса ставил бы его целиком.

## Устройство

```
composables/useApi.ts        токен, обновление, ошибки, файлы
composables/useRealtime.ts   одно WSS-соединение на всё приложение
composables/useCall.ts       mediasoup: транспорты, produce/consume
stores/auth.ts               сессия и роли
stores/notifications.ts      лента и счётчик непрочитанного
middleware/auth.global.ts    закрытые маршруты
components/ui/               Button, Card, Dialog, Select, DataTable…
lib/domain.ts                перевод кодов домена на человеческий язык
```

Компоненты shadcn-vue лежат в исходниках, а не приходят зависимостью:
такова сама идея библиотеки — код принадлежит проекту и правится под
него. `reka-ui` под ними отвечает за поведение (фокус, клавиатура,
доступность), а внешний вид задан здесь.

## Совместимость версий

`@pinia/nuxt` требует Pinia 3 — не 4. В образе `npm` обновляется до 11-й
версии: `node:22-alpine` несёт десятую, а она иначе трактует
необязательные платформенные зависимости `oxc-parser` и отказывается
ставить по чужому lock-файлу.
