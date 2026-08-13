import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { HEALTH_INDICATORS, HealthModule, type HealthIndicator } from '@crm/common';
import { MessagingModule } from '@crm/messaging';
import { GrpcClientsModule } from '@crm/grpc-clients';
import { SERVICES } from '@crm/contracts';
import { AuthClient } from './clients/auth.client';
import { AdminClient } from './clients/admin.client';
import { HrClient } from './clients/hr.client';
import { ScheduleClient } from './clients/schedule.client';
import { ApprovalClient } from './clients/approval.client';
import { TaskClient } from './clients/task.client';
import { NotificationClient } from './clients/notification.client';
import { ChatClient } from './clients/chat.client';
import { FileClient } from './clients/file.client';
import { VideoClient } from './clients/video.client';
import { AnalyticsClient } from './clients/analytics.client';
import { RedisService } from './cache/redis.service';
import { JwtAuthGuard } from './auth/auth.guard';
import { PermissionGuard } from './auth/permission.guard';
import { TokenResolver } from './auth/token-resolver';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { RealtimeEventsController } from './realtime/realtime.controller';
import { PresenceService } from './realtime/presence.service';
import { EphemeralBus } from './realtime/ephemeral.bus';
import { GrpcExceptionFilter } from './http/grpc-exception.filter';
import { AuthController } from './http/auth.controller';
import { EmployeesController } from './http/employees.controller';
import { AdminController } from './http/admin.controller';
import { ScheduleController } from './http/schedule.controller';
import { TimesheetController } from './http/timesheet.controller';
import { RequestsController } from './http/requests.controller';
import { BoardsController, CardsController } from './http/kanban.controller';
import { NotificationsController } from './http/notifications.controller';
import { ChannelsController, MessagesController } from './http/chat.controller';
import { CallsController } from './http/calls.controller';
import { ReportsController } from './http/reports.controller';

/**
 * Корневой модуль api-gateway.
 *
 * Единственный сервис без собственной БД: всё состояние в Redis.
 * Держит gRPC-клиентов ко всем доменным сервисам и собирает из них
 * ответы для клиента — это и есть BFF-агрегация из ADR-3, часть 3.
 *
 * Здесь же живёт WebSocket-слой (§8.1): RealtimeGateway держит соединения
 * клиентов, RealtimeEventsController читает очередь gateway.realtime и
 * раскладывает события по комнатам. Это единственный контроллер шлюза,
 * который слушает не HTTP, а брокер.
 *
 * Порядок guard'ов важен: JwtAuthGuard заполняет request.user, на
 * который опирается PermissionGuard. Nest применяет глобальные guard'ы
 * в порядке регистрации. Оба пропускают всё, что пришло не по HTTP, —
 * у сообщений брокера и WebSocket своя проверка.
 */
@Module({
  imports: [
    HealthModule,
    MessagingModule.forRoot(),
    GrpcClientsModule.register([
      SERVICES.AUTH,
      SERVICES.HR,
      SERVICES.APPROVAL,
      SERVICES.TASK,
      SERVICES.CHAT,
      SERVICES.VIDEO,
      SERVICES.FILE,
      SERVICES.NOTIFICATION,
      SERVICES.ANALYTICS,
    ]),
  ],
  controllers: [
    AuthController,
    EmployeesController,
    AdminController,
    ScheduleController,
    TimesheetController,
    RequestsController,
    BoardsController,
    CardsController,
    NotificationsController,
    ChannelsController,
    MessagesController,
    CallsController,
    ReportsController,
    RealtimeEventsController,
  ],
  providers: [
    RealtimeGateway,
    PresenceService,
    EphemeralBus,
    TokenResolver,
    AuthClient,
    AdminClient,
    HrClient,
    ScheduleClient,
    ApprovalClient,
    TaskClient,
    NotificationClient,
    ChatClient,
    FileClient,
    VideoClient,
    AnalyticsClient,
    RedisService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_FILTER, useClass: GrpcExceptionFilter },
    {
      // Доступность Redis попадает в readiness: без кэша gateway
      // работает, но деградировавшим — это должно быть видно снаружи.
      provide: HEALTH_INDICATORS,
      useFactory: (redis: RedisService): HealthIndicator[] => [redis],
      inject: [RedisService],
    },
  ],
})
export class AppModule {}
