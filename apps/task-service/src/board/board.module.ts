import { Module } from '@nestjs/common';
import { BoardService } from './board.service';
import { CardService } from './card.service';
import { TaskGrpcController } from './task.grpc.controller';
import { HrEventsController } from './hr-events.controller';

/**
 * Kanban: доски, колонки, карточки, комментарии.
 *
 * Сервис самодостаточен: он не спрашивает кадровый сервис при отрисовке
 * доски, а держит минимальную проекцию доступности исполнителей,
 * наполняемую событиями. ФИО подмешивает api-gateway одним батчевым
 * вызовом — так доска остаётся работоспособной, даже если hr недоступен.
 */
@Module({
  controllers: [TaskGrpcController, HrEventsController],
  providers: [BoardService, CardService],
  exports: [BoardService, CardService],
})
export class BoardModule {}
