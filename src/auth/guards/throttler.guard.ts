import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthUser } from '../auth.types.js';

/**
 * Rate limit per authenticated user, or per IP for anonymous calls. HTTP only:
 * WebSocket events (the `/admin` gateway) are authenticated at the handshake
 * and have no response object to set rate-limit headers on.
 */
@Injectable()
export class UserOrIpThrottlerGuard extends ThrottlerGuard {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    return super.canActivate(context);
  }

  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const user = req.user as AuthUser | undefined;
    return user ? `user:${user.id}` : `ip:${req.ip}`;
  }
}
