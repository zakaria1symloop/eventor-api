import type { DeepPartial } from 'typeorm';
import { TokenService } from '../../src/auth/token.service.js';
import type { Session } from '../../src/auth/entities/session.entity.js';
import { SessionAudience } from '../../src/common/enums/auth.enums.js';
import { UserRole } from '../../src/common/enums/user.enums.js';
import type { User } from '../../src/users/entities/user.entity.js';
import type { TestApp } from './create-app.js';
import { makeProvider, makeSession, makeUser } from './factories.js';

export interface LoggedIn {
  user: User;
  session: Session;
  token: string;
  /** `{ Authorization: 'Bearer …' }` for supertest's `.set()`. */
  headers: { Authorization: string };
}

/**
 * Creates a user with this role, a live session, and mints an access token for
 * it directly (faster than going through the login endpoint). Providers get a
 * provider profile too.
 */
export async function loginAs(
  testApp: TestApp,
  role: UserRole | `${UserRole}`,
  overrides: DeepPartial<User> = {},
): Promise<LoggedIn> {
  const db = testApp.dataSource;
  const user =
    role === UserRole.Provider
      ? (await makeProvider(db, { user: overrides })).user
      : await makeUser(db, { ...overrides, role: role as UserRole });

  return tokenFor(testApp, user);
}

/** A new session + access token for an existing user. */
export async function tokenFor(testApp: TestApp, user: User): Promise<LoggedIn> {
  const audience = user.role === UserRole.Admin ? SessionAudience.Dashboard : SessionAudience.App;
  const session = await makeSession(testApp.dataSource, { userId: user.id, audience });
  const token = await testApp.get(TokenService).signAccessToken({
    id: user.id,
    role: user.role,
    audience,
    sessionId: session.id,
  });
  return { user, session, token, headers: { Authorization: `Bearer ${token}` } };
}
