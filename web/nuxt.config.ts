import tailwindcss from '@tailwindcss/vite';

/**
 * Конфигурация фронтенда.
 *
 * SSR ВЫКЛЮЧЕН намеренно. Рендерить на сервере значило бы поднять ещё один
 * контейнер с Node, который на каждый запрос ходил бы в api-gateway с
 * токеном пользователя, — то есть завести второй краевой сервис рядом с
 * тем, что уже есть. Ничего, кроме первой отрисовки, это не улучшит:
 * система за логином, поисковым роботам её страницы недоступны, а данные
 * всё равно приходят по WebSocket после загрузки.
 *
 * Поэтому сборка статическая: nginx отдаёт файлы напрямую и разбирает
 * маршруты history-fallback'ом (§11.1), а приложение живёт целиком в
 * браузере.
 */
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  ssr: false,
  devtools: { enabled: false },

  modules: ['@pinia/nuxt'],
  css: ['~/assets/css/main.css'],

  vite: {
    plugins: [tailwindcss()],
  },

  app: {
    head: {
      title: 'CRM — учёт работы сотрудников',
      htmlAttrs: { lang: 'ru' },
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'color-scheme', content: 'light dark' },
      ],
    },
  },

  runtimeConfig: {
    public: {
      /**
       * Пусто — значит тот же источник, откуда отдана страница. В Docker
       * это nginx, который сам разложит /api/ по сервисам. Абсолютный
       * адрес нужен только при разработке, когда Nuxt поднят отдельно.
       */
      apiBase: process.env.NUXT_PUBLIC_API_BASE ?? '',
    },
  },

  /**
   * В dev-режиме фронтенд поднят на своём порту, а стенд — на 8080.
   * Прокси избавляет от CORS и от необходимости объяснять браузеру, что
   * cookie с refresh-токеном относятся к другому источнику.
   */
  nitro: {
    devProxy: {
      '/api': { target: 'http://127.0.0.1:8080/api', changeOrigin: true },
      '/ws': { target: 'http://127.0.0.1:8080', changeOrigin: true, ws: true },
      '/signaling': { target: 'http://127.0.0.1:8080', changeOrigin: true, ws: true },
      '/files': { target: 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
});
