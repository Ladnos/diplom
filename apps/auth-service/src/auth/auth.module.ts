import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthGrpcController } from './auth.grpc.controller';
import { AdminService } from './admin.service';
import { AdminGrpcController } from './admin.grpc.controller';
import { AdminBootstrap } from './admin-bootstrap';
import { HrEventsController } from './hr-events.controller';
import { OrgProjectionService } from './org-projection.service';
import { PasswordService } from './password.service';
import { PermissionService } from './permission.service';
import { RbacSeed } from './rbac.seed';
import { TokenService } from './token.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthGrpcController, AdminGrpcController, HrEventsController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    PermissionService,
    OrgProjectionService,
    AdminService,
    // RbacSeed НЕ имеет собственного хука запуска: создание админа
    // требует уже существующих ролей (внешний ключ user_roles → roles),
    // и полагаться на порядок вызова onApplicationBootstrap у двух
    // независимых провайдеров было бы гаданием. Последовательность
    // задаёт AdminBootstrap явно.
    RbacSeed,
    AdminBootstrap,
  ],
  exports: [AuthService, PermissionService, AdminService],
})
export class AuthModule {}
