import { defineStore } from 'pinia';

export interface Employment {
  type: string;
  paymentForm: string;
  policy: string;
  rate: number;
}

export interface Employee {
  employeeId: string;
  fullName: string;
  position: string | null;
  departmentId: string | null;
  managerId: string | null;
  avatarFileId: string | null;
  active: boolean;
  employment: Employment | null;
}

export interface Me {
  userId: string;
  roles: string[];
  isManager: boolean;
  employee: Employee | null;
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

const STORAGE_KEY = 'crm.session';

/**
 * Сессия пользователя.
 *
 * Access-токен живёт пятнадцать минут, refresh — тридцать дней. Хранение
 * в localStorage — осознанный компромисс: httpOnly-cookie защищена от
 * XSS лучше, но требует, чтобы запросы шли с того же источника и с
 * учётом CSRF, а api-gateway рассчитан на заголовок Authorization.
 * Выбран заголовок, потому что тот же токен предъявляют загрузка файлов
 * (мимо шлюза) и WebSocket-рукопожатие, где cookie неудобны.
 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    accessToken: null as string | null,
    refreshToken: null as string | null,
    accessExpiresAt: 0,
    me: null as Me | null,
    /** Пока идёт восстановление сессии, маршруты ждут — иначе моргнёт вход. */
    restoring: true,
  }),

  getters: {
    isAuthenticated: (state) => Boolean(state.accessToken),

    /**
     * Запас в тридцать секунд перед формальным истечением.
     *
     * Токен, отправленный за секунду до конца срока, доедет до сервиса
     * уже просроченным. Обновляться заранее дешевле, чем разбирать
     * случайные 401 на медленной сети.
     */
    isAccessExpired: (state) => !state.accessExpiresAt || state.accessExpiresAt - 30_000 < Date.now(),

    employeeId: (state) => state.me?.employee?.employeeId ?? null,
    fullName: (state) => state.me?.employee?.fullName ?? 'Без профиля',
    roles: (state) => state.me?.roles ?? [],
    isAdmin: (state) => (state.me?.roles ?? []).includes('ADMIN'),
    isManager: (state) => state.me?.isManager === true,

    /**
     * Роль HR даёт кадровые разделы наравне с администратором.
     * Проверка ролей на клиенте — это ТОЛЬКО про то, какие пункты меню
     * показывать. Настоящее решение принимает auth-service на каждый
     * запрос, и спрятанный пункт меню ничего не защищает.
     */
    isHr(): boolean {
      return this.isAdmin || (this.me?.roles ?? []).includes('HR');
    },
  },

  actions: {
    async login(email: string, password: string) {
      const tokens = await $fetch<TokenPair>('/api/auth/login', {
        baseURL: useRuntimeConfig().public.apiBase,
        method: 'POST',
        body: { email, password },
      });

      this.applyTokens(tokens);
      await this.loadMe();
    },

    /**
     * Обновление access-токена.
     *
     * Возвращает false вместо исключения: вызывающий — перехватчик
     * запросов, и для него «не удалось обновить» это ветка логики, а не
     * авария. Refresh при этом одноразовый, поэтому повторное
     * использование старого токена auth-service расценит как кражу и
     * отзовёт все сессии.
     */
    async refresh(): Promise<boolean> {
      if (!this.refreshToken) return false;

      try {
        const tokens = await $fetch<TokenPair>('/api/auth/refresh', {
          baseURL: useRuntimeConfig().public.apiBase,
          method: 'POST',
          body: { refreshToken: this.refreshToken },
        });
        this.applyTokens(tokens);
        return true;
      } catch {
        this.clear();
        return false;
      }
    },

    async loadMe() {
      this.me = await $fetch<Me>('/api/auth/me', {
        baseURL: useRuntimeConfig().public.apiBase,
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
    },

    /** Восстановление сессии при загрузке страницы. */
    async restore() {
      this.restoring = true;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;

        const saved = JSON.parse(raw) as Partial<TokenPair>;
        if (!saved.refreshToken) return;

        this.refreshToken = saved.refreshToken;
        this.accessToken = saved.accessToken ?? null;
        this.accessExpiresAt = saved.accessExpiresAt ?? 0;

        // Токен из хранилища мог протухнуть, пока вкладка была закрыта:
        // обновляем сразу, не дожидаясь первого отказа на живом запросе.
        if (this.isAccessExpired && !(await this.refresh())) return;
        await this.loadMe();
      } catch {
        this.clear();
      } finally {
        this.restoring = false;
      }
    },

    logout() {
      this.clear();
      void navigateTo('/login');
    },

    clear() {
      this.accessToken = null;
      this.refreshToken = null;
      this.accessExpiresAt = 0;
      this.me = null;
      if (import.meta.client) localStorage.removeItem(STORAGE_KEY);
    },

    applyTokens(tokens: TokenPair) {
      this.accessToken = tokens.accessToken;
      this.refreshToken = tokens.refreshToken;
      this.accessExpiresAt = Number(tokens.accessExpiresAt) || 0;

      if (import.meta.client) {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            accessExpiresAt: this.accessExpiresAt,
          }),
        );
      }
    },
  },
});
