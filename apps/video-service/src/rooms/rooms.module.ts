import { Module } from '@nestjs/common';
import { SfuService } from '../sfu/sfu.service';
import { SignalingGateway } from '../signaling/signaling.gateway';
import { RoomService } from './room.service';
import { JoinTokenService } from './join-token.service';
import { VideoGrpcController } from './video.grpc.controller';
import { HrEventsController } from './hr-events.controller';

/**
 * Звонки: комнаты, пропуска, сигналинг и SFU.
 *
 * Три плоскости разведены намеренно и в коде тоже. Управление идёт по
 * gRPC и переживает звонок в базе; сигналинг — отдельное WSS-соединение
 * со своим сроком жизни; медиа вообще не проходит через Node. Смешать их
 * в одном слое означало бы связать задержку разговора со скоростью
 * обработки обычных запросов.
 */
@Module({
  controllers: [VideoGrpcController, HrEventsController],
  providers: [RoomService, JoinTokenService, SfuService, SignalingGateway],
  exports: [RoomService, SfuService],
})
export class RoomsModule {}
