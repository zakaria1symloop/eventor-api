import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../../common/errors/app.exception.js';
import type { UserRole } from '../../common/enums/user.enums.js';
import type { AuthUser } from '../auth.types.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';

/** Global guard, runs after JwtAuthGuard: enforces `@Roles(...)` (403 FORBIDDEN_ROLE). */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) {
      return true;
    }
    const user = context.switchToHttp().getRequest<Request & { user?: AuthUser }>().user;
    if (!user) {
      throw AppException.of('AUTH_TOKEN_MISSING');
    }
    if (!roles.includes(user.role)) {
      throw AppException.of('FORBIDDEN_ROLE');
    }
    return true;
  }
}
