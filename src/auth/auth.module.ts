import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AdminAuthController } from './admin-auth.controller.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AuthMailListener } from './auth-mail.listener.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { UserOrIpThrottlerGuard } from './guards/throttler.guard.js';
import { PasswordService } from './password.service.js';
import { SessionsService } from './sessions.service.js';
import { TokenService } from './token.service.js';

/**
 * Tokens, sessions, passwords, admin sign-in routes and the global guards, in
 * order JwtAuthGuard → RolesGuard → throttler (so limits apply per user when known).
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AdminAuthController],
  providers: [
    TokenService,
    PasswordService,
    SessionsService,
    AdminAuthService,
    AuthMailListener,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: UserOrIpThrottlerGuard },
  ],
  exports: [TokenService, PasswordService, SessionsService],
})
export class AuthModule {}
