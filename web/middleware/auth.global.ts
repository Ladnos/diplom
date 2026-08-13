import { useAuthStore } from '~/stores/auth';

/** Маршруты, доступные без входа. */
const PUBLIC_ROUTES = new Set(['/login', '/register']);

/**
 * Защита маршрутов.
 *
 * Глобальный middleware, а не проверка в каждой странице: забыть его на
 * одной странице — значит открыть её целиком, и заметить это можно
 * только случайно.
 *
 * Настоящая защита при этом на сервере: скрытая страница не мешает
 * запросить данные напрямую, и каждый ответ api-gateway всё равно
 * проверяет право. Здесь — только чтобы человек не смотрел на пустой
 * интерфейс, который всё равно ничего не покажет.
 */
/**
 * Путь без завершающего слэша.
 *
 * Статическая сборка раскладывает каждую страницу каталогом
 * (`login/index.html`), поэтому nginx перенаправляет `/login` на
 * `/login/`, и в маршрутизатор приходит путь со слэшем. Сравнение по
 * точному совпадению на нём разваливается: страница входа перестаёт
 * считаться открытой, и вошедший получает перенаправление на самого
 * себя — с бесконечным `next=/login/`.
 */
function normalize(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

export default defineNuxtRouteMiddleware((to) => {
  if (import.meta.server) return;

  const auth = useAuthStore();
  const path = normalize(to.path);

  if (PUBLIC_ROUTES.has(path)) {
    // Вошедшему на странице входа делать нечего
    return auth.isAuthenticated ? navigateTo('/') : undefined;
  }

  if (!auth.isAuthenticated) {
    // Куда шли — запоминаем: после входа человек окажется там, а не на
    // главной, и не будет искать нужный раздел заново.
    return navigateTo({ path: '/login', query: path === '/' ? {} : { next: to.fullPath } });
  }
});

export { normalize as normalizePath, PUBLIC_ROUTES };
