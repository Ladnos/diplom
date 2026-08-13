import type { FetchOptions } from 'ofetch';
import { useAuthStore } from '~/stores/auth';

export interface ApiError extends Error {
  status: number;
  /** Идентификатор запроса из ответа шлюза — по нему ищут в журналах. */
  correlationId?: string;
}

/**
 * Единственная точка обращения к API.
 *
 * Три вещи, которые иначе пришлось бы повторять в каждом компоненте:
 * подстановка токена, его обновление при истечении и разбор ошибки в
 * человеческий текст.
 *
 * ОБНОВЛЕНИЕ ТОКЕНА ОДНО НА ВСЕХ. Страница открывает несколько запросов
 * разом, и все они упрутся в один и тот же протухший токен. Без общего
 * обещания каждый пошёл бы обновлять сам, а refresh одноразовый —
 * второй же получил бы отказ, и auth-service расценил бы это как кражу
 * токена, отозвав все сессии пользователя.
 */
let refreshing: Promise<boolean> | null = null;

async function ensureFreshToken(): Promise<boolean> {
  const auth = useAuthStore();
  if (!auth.refreshToken) return false;
  if (!auth.isAccessExpired) return true;

  refreshing ??= auth.refresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export function useApi() {
  const auth = useAuthStore();
  const config = useRuntimeConfig();

  async function request<T>(path: string, options: FetchOptions = {}): Promise<T> {
    if (auth.refreshToken) await ensureFreshToken();

    const headers: Record<string, string> = { ...(options.headers as Record<string, string>) };
    if (auth.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`;

    try {
      return await $fetch<T>(path, {
        ...options,
        baseURL: config.public.apiBase,
        headers,
      } as FetchOptions<'json'>);
    } catch (error) {
      const failure = error as { status?: number; statusCode?: number; data?: unknown };
      const status = failure.status ?? failure.statusCode ?? 0;

      // Единственный 401, до которого доходит дело, — это отозванная
      // сессия: истёкший токен обновлён выше. Отправляем на вход, не
      // пытаясь обновлять второй раз.
      if (status === 401 && auth.isAuthenticated) {
        auth.clear();
        await navigateTo('/login');
      }

      throw toApiError(error);
    }
  }

  return {
    get: <T>(path: string, query?: Record<string, unknown>) =>
      request<T>(path, { method: 'GET', query }),
    post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
    patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
    put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
    delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
    raw: request,

    /**
     * Загрузка файла.
     *
     * Идёт напрямую в file-service мимо шлюза (§9.2), поэтому здесь
     * XMLHttpRequest, а не fetch: он умеет сообщать о ходе передачи, а
     * многомегабайтный файл без индикатора выглядит как зависший
     * интерфейс.
     */
    upload(
      file: File,
      fields: Record<string, string> = {},
      onProgress?: (percent: number) => void,
    ): Promise<{ fileId: string; filename: string; sizeBytes: number; mimeType: string }> {
      return new Promise((resolve, reject) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.append(key, value);
        form.append('file', file, file.name);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${config.public.apiBase}/api/files/upload`);
        xhr.setRequestHeader('Authorization', `Bearer ${auth.accessToken}`);

        xhr.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
        });

        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(JSON.parse(xhr.responseText));
            return;
          }
          const error = new Error(parseMessage(xhr.responseText)) as ApiError;
          error.status = xhr.status;
          reject(error);
        });

        xhr.addEventListener('error', () => reject(new Error('соединение прервано')));
        xhr.send(form);
      });
    },

    /** Скачивание с токеном: обычная ссылка в браузере его не пошлёт. */
    async download(path: string, filename?: string): Promise<void> {
      if (auth.refreshToken) await ensureFreshToken();

      const response = await fetch(`${config.public.apiBase}${path}`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      });
      if (!response.ok) throw new Error(await response.text());

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename ?? path.split('/').pop() ?? 'file';
      link.click();
      // Освобождаем сразу: ссылка уже нажата, а объект держит файл в памяти
      URL.revokeObjectURL(url);
    },
  };
}

function toApiError(error: unknown): ApiError {
  const failure = error as {
    status?: number;
    statusCode?: number;
    data?: { message?: string | string[]; correlationId?: string };
    message?: string;
  };

  const raw = failure.data?.message ?? failure.message ?? 'неизвестная ошибка';
  // ValidationPipe отдаёт массив сообщений — по одному на поле
  const message = Array.isArray(raw) ? raw.join('; ') : raw;

  const result = new Error(message) as ApiError;
  result.status = failure.status ?? failure.statusCode ?? 0;
  result.correlationId = failure.data?.correlationId;
  return result;
}

function parseMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string };
    return parsed.message ?? 'не удалось загрузить файл';
  } catch {
    return 'не удалось загрузить файл';
  }
}
