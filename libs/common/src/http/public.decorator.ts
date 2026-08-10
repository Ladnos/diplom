import { SetMetadata } from '@nestjs/common';

/**
 * Маршрут доступен без аутентификации.
 *
 * Живёт в @crm/common, а не в api-gateway, по конкретной причине:
 * health-эндпоинты объявлены здесь же, а глобальный guard регистрируется
 * в сервисе. Если бы маркер принадлежал сервису, HealthController не смог
 * бы себя пометить, и включение guard'а закрывало бы пробу — контейнер
 * стабильно вставал бы unhealthy при полностью рабочем приложении.
 */
export const IS_PUBLIC = 'auth:public';

export const Public = () => SetMetadata(IS_PUBLIC, true);
