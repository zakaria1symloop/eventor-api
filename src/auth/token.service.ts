import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SessionAudience } from '../common/enums/auth.enums.js';
import type { UserRole } from '../common/enums/user.enums.js';
import { envConfig, type Env } from '../config/env.js';
import type { AccessTokenPayload } from './auth.types.js';

export const JWT_ISSUER = 'eventor-api';

/** Signs and verifies access tokens (HS256, 15 min). Refresh tokens come with module 1. */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(envConfig.KEY) private readonly env: Env,
  ) {}

  signAccessToken(user: {
    id: string;
    role: UserRole;
    audience?: SessionAudience;
    sessionId?: string;
  }): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      role: user.role,
      aud: user.audience ?? SessionAudience.Dashboard,
      ...(user.sessionId ? { sid: user.sessionId } : {}),
    };
    return this.jwt.signAsync(payload, {
      secret: this.env.JWT_ACCESS_SECRET,
      expiresIn: this.env.JWT_ACCESS_TTL,
      issuer: JWT_ISSUER,
      algorithm: 'HS256',
    });
  }

  verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    return this.jwt.verifyAsync<AccessTokenPayload>(token, {
      secret: this.env.JWT_ACCESS_SECRET,
      issuer: JWT_ISSUER,
      algorithms: ['HS256'],
    });
  }
}
