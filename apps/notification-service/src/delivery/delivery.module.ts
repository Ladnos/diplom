import { Module } from '@nestjs/common';
import { EmailSender } from './email.sender';
import { PushSender } from './push.sender';
import { DeliveryWorker } from './delivery.worker';
import { RetentionWorker } from './retention.worker';

/**
 * Внешние каналы доставки и фоновые воркеры.
 *
 * Единственное место сервиса, которое ходит наружу — поэтому
 * notification-service единственный из доменных подключён к сети
 * crm-public (docker-compose.yml). Остальные сидят в internal-сетях
 * без выхода в интернет.
 */
@Module({
  providers: [EmailSender, PushSender, DeliveryWorker, RetentionWorker],
  exports: [EmailSender, PushSender],
})
export class DeliveryModule {}
