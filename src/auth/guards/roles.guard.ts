import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../../common/errors/app.exception.js';
import { SessionAudience } from '../../common/enums/auth.enums.js';
import type { UserRole } from '../../common/enums/user.enums.js';
import type { AuthUser } from '../auth.types.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';

/**
 * Which token audience a route family accepts. The dashboard (`/admin/**`) and
 * the mobile app (`/app/**`) never share a session: one minted for the other is
 * refused with 403 FORBIDDEN_AUDIENCE, even when the role would allow it.
 * Routes outside both families (files, health) accept either.
 */
export function audienceForPath(path: string): SessionAudience | null {
  const route = path.split('?')[0] ?? '';
  if (/(^|\/)api\/v1\/app(\/|$)/.test(route)) return SessionAudience.App;
  if (/(^|\/)api\/v1\/admin(\/|$)/.test(route)) return SessionAudience.Dashboard;
  return null;
}

/**
 * Global guard, runs after JwtAuthGuard: enforces `@Roles(...)` (403
 * FORBIDDEN_ROLE) and then the route family's token audience (403
 * FORBIDDEN_AUDIENCE).
 *
 * The role is checked **first** on purpose. A client token on `/admin/**` is
 * both the wrong role and the wrong audience, and `FORBIDDEN_ROLE` is the more
 * specific answer — it is also the one every admin endpoint has documented
 * since module 1, so the dashboard's error handling does not move. The audience
 * check is what is left: a session that *would* pass the role test but belongs
 * to the other application.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }
    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;

    if (roles && roles.length > 0) {
      if (!user) {
        throw AppException.of('AUTH_TOKEN_MISSING');
      }
      if (!roles.includes(user.role)) {
        throw AppException.of('FORBIDDEN_ROLE');
      }
    }

    // `@Public()` routes may carry an optional token (browsing while signed in):
    // a foreign audience there just means the request stays anonymous, never a 403.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (user && !isPublic) {
      const expected = audienceForPath(request.originalUrl ?? request.url ?? '');
      if (expected && user.audience !== expected) {
        throw AppException.of('FORBIDDEN_AUDIENCE', { expected, actual: user.audience });
      }
    }
    return true;
  }
}
