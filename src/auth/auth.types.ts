import type { SessionAudience } from '../common/enums/auth.enums.js';
import type { UserRole } from '../common/enums/user.enums.js';

/** Claims inside an access token. */
export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
  aud: SessionAudience;
  /** Session id, once login (module 1) creates sessions. */
  sid?: string;
}

/** What guards attach to `request.user`. */
export interface AuthUser {
  id: string;
  role: UserRole;
  audience: SessionAudience;
  sessionId: string | null;
}
