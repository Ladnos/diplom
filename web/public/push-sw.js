/**
 * Service worker для Web Push.
 *
 * Единственная его задача — показать уведомление, когда вкладка закрыта:
 * без зарегистрированного обработчика `push` браузер подписку примет, но
 * сообщения будут приходить в никуда.
 *
 * Файл лежит в public/ и отдаётся с корня: service worker управляет
 * только теми страницами, что лежат не выше него по пути, и из
 * подкаталога он не увидел бы приложение целиком.
 */

self.addEventListener('push', (event) => {
  const payload = (() => {
    try {
      return event.data ? event.data.json() : {};
    } catch {
      return { title: 'Уведомление', body: event.data ? event.data.text() : '' };
    }
  })();

  event.waitUntil(
    self.registration.showNotification(payload.title || 'CRM', {
      body: payload.body || '',
      // Тег схлопывает повторы: десять сообщений из одного чата не должны
      // выстраиваться в десять карточек поверх экрана
      tag: payload.tag || payload.data?.notificationId,
      data: payload.data || {},
      icon: '/favicon.ico',
      requireInteraction: payload.priority === 'URGENT',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = event.notification.data?.link || '/';

  // Если приложение уже открыто, переиспользуем вкладку, а не плодим новые
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(link);
          return client.focus();
        }
      }
      return self.clients.openWindow(link);
    }),
  );
});
