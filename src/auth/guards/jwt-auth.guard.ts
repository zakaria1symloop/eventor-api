import { Injectable, Logger, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Request } from 'express';
import type { DataSource } from 'typeorm';
import { AppException } from '../../common/errors/app.exception.js';
import { UserRole, UserStatus } from '../../common/enums/user.enums.js';
import { getRequestContext } from '../../common/request-context/request-context.js';
import { User } from '../../users/entities/user.entity.js';
import type { AuthUser } from '../auth.types.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { Session } from '../entities/session.entity.js';
import { SessionsService } from '../sessions.service.js';
import { TokenService } from '../token.service.js';

/** `last_active_at` / `last_used_at` are written at most once per this interval. */
export const ACTIVITY_TOUCH_INTERVAL_MS = 60_000;

/**
 * Global guard: every route needs `Authorization: Bearer <access token>` unless
 * marked `@Public()`. Verifies signature, issuer and expiry, then the session
 * (`sid`) is still live and the account still active; attaches `request.user`
 * with the role from the database. A blocked account gets 401 ACCOUNT_BLOCKED
 * and all its sessions are revoked.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionsService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw AppException.of('AUTH_TOKEN_MISSING');
    }

    let payload;
    try {
      payload = await this.tokens.verifyAccessToken(token);
    } catch (error) {
      const expired = (error as { name?: string }).name === 'TokenExpiredError';
      throw AppException.of(expired ? 'AUTH_TOKEN_EXPIRED' : 'AUTH_TOKEN_INVALID');
    }
    if (!payload.sub || !payload.sid || !Object.values(UserRole).includes(payload.role)) {
      throw AppException.of('AUTH_TOKEN_INVALID');
    }

    const session = await this.dataSource.getRepository(Session).findOneBy({ id: payload.sid });
    if (!session || session.userId !== payload.sub) {
      throw AppException.of('AUTH_TOKEN_INVALID');
    }
    const now = new Date();
    if (session.revokedAt || session.expiresAt.getTime() <= now.getTime()) {
      throw AppException.of('AUTH_SESSION_REVOKED');
    }
    const user = await this.dataSource.getRepository(User).findOneBy({ id: payload.sub });
    if (!user) {
      await this.sessions.revoke(session.id);
      throw AppException.of('AUTH_SESSION_REVOKED');
    }
    if (user.status === UserStatus.Blocked) {
      await this.sessions.revokeAllForUser(user.id);
      throw new AppException(401, 'ACCOUNT_BLOCKED');
    }

    request.user = {
      id: user.id,
      role: user.role,
      audience: session.audience,
      sessionId: session.id,
    };
    const store = getRequestContext();
    if (store) {
      store.userId = user.id;
      store.userRole = user.role;
    }

    await this.touch(user, session, now);
    return true;
  }

  private async touch(user: User, session: Session, now: Date): Promise<void> {
    const stale = (value: Date | null) => !value || now.getTime() - value.getTime() >= ACTIVITY_TOUCH_INTERVAL_MS;
    try {
      if (stale(user.lastActiveAt)) {
        // Raw update: activity must not bump `updated_at` (used for optimistic concurrency).
        await this.dataSource.query('UPDATE `users` SET `last_active_at` = ? WHERE `id` = ?', [now, user.id]);
      }
      if (stale(session.lastUsedAt)) {
        await this.dataSource.getRepository(Session).update(session.id, { lastUsedAt: now });
      }
    } catch (error) {
      this.logger.warn(`Could not record activity: ${(error as Error).message}`);
    }
  }
}
