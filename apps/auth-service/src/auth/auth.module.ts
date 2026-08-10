import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthGrpcController } from './auth.grpc.controller';
import { HrEventsController } from './hr-events.controller';
import { OrgProjectionService } from './org-projection.service';
import { PasswordService } from './password.service';
import { PermissionService } from './permission.service';
import { RbacSeed } from './rbac.seed';
import { TokenService } from './token.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthGrpcController, HrEventsController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    PermissionService,
    OrgProjectionService,
    RbacSeed,
  ],
  exports: [AuthService, PermissionService],
})
export class AuthModule {}
