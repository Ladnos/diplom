<script setup lang="ts">
import { ref } from 'vue';
import { useAuthStore } from '~/stores/auth';

definePageMeta({ layout: 'blank' });

const auth = useAuthStore();
const api = useApi();

const email = ref('');
const password = ref('');
const fullName = ref('');
const loading = ref(false);
const failure = ref('');

/**
 * Регистрация сразу входит в систему.
 *
 * Заставлять человека вводить те же данные второй раз незачем: учётная
 * запись только что создана, и пароль у нас уже есть.
 */
async function submit() {
  failure.value = '';
  loading.value = true;

  try {
    await api.post('/api/auth/register', {
      email: email.value.trim(),
      password: password.value,
      fullName: fullName.value.trim(),
    });
    await auth.login(email.value.trim(), password.value);
    await navigateTo('/');
  } catch (caught) {
    failure.value = caught instanceof Error ? caught.message : 'Не удалось зарегистрироваться';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="grid min-h-screen place-items-center px-4">
    <div class="w-full max-w-sm">
      <div class="mb-8 text-center">
        <h1 class="text-lg font-semibold">Регистрация</h1>
        <p class="text-muted-foreground text-sm">Профиль сотрудника создастся автоматически</p>
      </div>

      <UiCard>
        <form class="space-y-4" @submit.prevent="submit">
          <div class="space-y-1.5">
            <label for="fullName" class="text-sm font-medium">Фамилия, имя и отчество</label>
            <UiInput id="fullName" v-model="fullName" placeholder="Иванов Иван Иванович" required />
          </div>

          <div class="space-y-1.5">
            <label for="email" class="text-sm font-medium">Электронная почта</label>
            <UiInput id="email" v-model="email" type="email" autocomplete="username" required />
          </div>

          <div class="space-y-1.5">
            <label for="password" class="text-sm font-medium">Пароль</label>
            <UiInput
              id="password"
              v-model="password"
              type="password"
              autocomplete="new-password"
              required
            />
            <p class="text-muted-foreground text-xs">Не короче десяти символов</p>
          </div>

          <p v-if="failure" class="text-destructive text-xs">{{ failure }}</p>

          <UiButton type="submit" class="w-full" :loading="loading">Зарегистрироваться</UiButton>
        </form>

        <template #footer>
          <p class="text-muted-foreground text-center text-xs">
            Уже есть учётная запись?
            <NuxtLink to="/login" class="text-foreground underline underline-offset-4">Войти</NuxtLink>
          </p>
        </template>
      </UiCard>
    </div>
  </div>
</template>
