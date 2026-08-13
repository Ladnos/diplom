<script setup lang="ts">
import { useAuthStore } from '~/stores/auth';

const auth = useAuthStore();
</script>

<template>
  <!-- Пока сессия восстанавливается, показываем заглушку, а не интерфейс:
       иначе защищённая страница успевает мигнуть формой входа человеку,
       который на самом деле вошёл -->
  <div v-if="auth.restoring" class="bg-background grid min-h-screen place-items-center">
    <div class="flex flex-col items-center gap-3">
      <div class="border-muted-foreground/30 border-t-foreground size-6 animate-spin rounded-full border-2" />
      <p class="text-muted-foreground text-xs">Восстанавливаем сессию…</p>
    </div>
  </div>

  <NuxtLayout v-else>
    <NuxtPage />
  </NuxtLayout>
</template>
