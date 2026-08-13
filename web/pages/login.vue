<script setup lang="ts">
import { ref } from 'vue';
import { useAuthStore } from '~/stores/auth';
import { PUBLIC_ROUTES } from '~/middleware/auth.global';

definePageMeta({ layout: 'blank' });

const auth = useAuthStore();
const route = useRoute();
const { error } = useToast();

const email = ref('');
const password = ref('');
const loading = ref(false);
const failure = ref('');

/**
 * Куда идти после входа.
 *
 * Значение `next` приходит из адресной строки, то есть от кого угодно.
 * Две проверки обязательны: адрес должен быть внутренним — иначе форма
 * входа превращается в открытое перенаправление на чужой сайт, — и не
 * должен вести обратно на страницу входа, иначе человек, войдя,
 * остаётся на ней же.
 */
function nextRoute(): string {
  const next = route.query.next;
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return '/';

  const path = next.split('?')[0].replace(/\/$/, '') || '/';
  return PUBLIC_ROUTES.has(path) ? '/' : next;
}

async function submit() {
  failure.value = '';
  loading.value = true;

  try {
    await auth.login(email.value.trim(), password.value);
    await navigateTo(nextRoute());
  } catch (caught) {
    // Текст показываем в форме, а не всплывающим сообщением: ошибка
    // относится к тому, что человек сейчас заполняет, и должна быть
    // рядом с полями, а не в углу экрана.
    failure.value = caught instanceof Error ? caught.message : 'Не удалось войти';
    if (failure.value.includes('недоступ')) error('Сервис недоступен', failure.value);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="grid min-h-screen place-items-center px-4">
    <div class="w-full max-w-sm">
      <div class="mb-8 flex flex-col items-center gap-3 text-center">
        <div class="bg-primary text-primary-foreground grid size-11 place-items-center rounded-xl">
          <span class="text-sm font-bold">УР</span>
        </div>
        <div>
          <h1 class="text-lg font-semibold">Учёт работы сотрудников</h1>
          <p class="text-muted-foreground text-sm">Войдите, чтобы продолжить</p>
        </div>
      </div>

      <UiCard>
        <form class="space-y-4" @submit.prevent="submit">
          <div class="space-y-1.5">
            <label for="email" class="text-sm font-medium">Электронная почта</label>
            <UiInput
              id="email"
              v-model="email"
              type="email"
              autocomplete="username"
              placeholder="name@example.local"
              required
              :aria-invalid="Boolean(failure)"
            />
          </div>

          <div class="space-y-1.5">
            <label for="password" class="text-sm font-medium">Пароль</label>
            <UiInput
              id="password"
              v-model="password"
              type="password"
              autocomplete="current-password"
              required
              :aria-invalid="Boolean(failure)"
            />
          </div>

          <p v-if="failure" class="text-destructive text-xs">{{ failure }}</p>

          <UiButton type="submit" class="w-full" :loading="loading">Войти</UiButton>
        </form>

        <template #footer>
          <p class="text-muted-foreground text-center text-xs">
            Нет учётной записи?
            <NuxtLink to="/register" class="text-foreground underline underline-offset-4">
              Зарегистрироваться
            </NuxtLink>
          </p>
        </template>
      </UiCard>
    </div>
  </div>
</template>
