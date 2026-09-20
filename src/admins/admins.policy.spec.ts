import { AppException } from '../common/errors/app.exception.js';
import { lockoutRetryAfterSeconds } from '../auth/admin-auth.service.js';
import { assertCanRemoveAdmin, emailChangeNeedsPassword } from './admins.policy.js';

const codeOf = (fn: () => void) => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as AppException).code;
  }
};

describe('assertCanRemoveAdmin', () => {
  it('refuses removing yourself', () => {
    expect(codeOf(() => assertCanRemoveAdmin({ actorId: 'a', targetId: 'a', remainingActiveAdmins: 3 }))).toBe('CANNOT_REMOVE_SELF');
  });

  it('refuses removing the last admin', () => {
    expect(codeOf(() => assertCanRemoveAdmin({ actorId: 'a', targetId: 'b', remainingActiveAdmins: 0 }))).toBe('LAST_ADMIN');
  });

  it('allows removing another admin when others remain', () => {
    expect(codeOf(() => assertCanRemoveAdmin({ actorId: 'a', targetId: 'b', remainingActiveAdmins: 1 }))).toBeNull();
  });
});

describe('emailChangeNeedsPassword', () => {
  it('only when the email actually changes', () => {
    expect(emailChangeNeedsPassword('a@x.dz', undefined)).toBe(false);
    expect(emailChangeNeedsPassword('a@x.dz', 'a@x.dz')).toBe(false);
    expect(emailChangeNeedsPassword('a@x.dz', 'b@x.dz')).toBe(true);
  });
});

describe('lockoutRetryAfterSeconds', () => {
  const now = new Date('2026-09-15T10:00:00Z');
  const ago = (min: number) => ({ createdAt: new Date(now.getTime() - min * 60_000) });

  it('is not locked below 5 failures', () => {
    expect(lockoutRetryAfterSeconds([ago(1), ago(2), ago(3), ago(4)], now)).toBeNull();
  });

  it('locks for 15 min after the 5th failure', () => {
    expect(lockoutRetryAfterSeconds([ago(1), ago(2), ago(3), ago(4), ago(5)], now)).toBe(14 * 60);
  });

  it('unlocks once 15 min have passed', () => {
    expect(lockoutRetryAfterSeconds([ago(15), ago(15), ago(15), ago(15), ago(15)], now)).toBeNull();
  });
});
