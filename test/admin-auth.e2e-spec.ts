import request from 'supertest';
import { AdminInvitation } from '../src/auth/entities/admin-invitation.entity.js';
import { LoginAttempt } from '../src/auth/entities/login-attempt.entity.js';
import { Session } from '../src/auth/entities/session.entity.js';
import { PasswordService } from '../src/auth/password.service.js';
import { hashToken } from '../src/auth/refresh-token.js';
import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { UserRole, UserStatus } from '../src/common/enums/user.enums.js';
import { MailService } from '../src/mail/mail.service.js';
import { User } from '../src/users/entities/user.entity.js';
import { createApp, expectError, makeUser, uid, type TestApp } from './utils/index.js';

const PASSWORD = 'Sunflower42x';
const BASE = '/api/v1/admin/auth';

function refreshCookie(res: request.Response): string {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = cookies.find((c) => c.startsWith('eventor_admin_rt='));
  expect(cookie).toBeDefined();
  return cookie!;
}
const cookiePair = (setCookie: string) => setCookie.split(';')[0]!;

describe('Admin auth (e2e)', () => {
  let t: TestApp;
  let hash: string;

  beforeAll(async () => {
    t = await createApp();
    hash = await t.get(PasswordService).hash(PASSWORD);
  });

  afterAll(async () => {
    await t?.close();
  });

  const makeAdmin = (overrides: Partial<User> = {}) =>
    makeUser(t.dataSource, { role: UserRole.Admin, passwordHash: hash, ...overrides });

  const login = (email: string, password = PASSWORD, extra: Record<string, unknown> = {}) =>
    request(t.http).post(`${BASE}/login`).send({ email, password, ...extra });

  describe('POST /login', () => {
    it('signs in an admin, sets the refresh cookie and creates a dashboard session', async () => {
      const admin = await makeAdmin();
      const res = await login(admin.email.toUpperCase(), PASSWORD, { remember: true }).expect(200);

      expect(res.body.data).toEqual({
        accessToken: expect.any(String),
        expiresIn: 900,
        user: {
          id: admin.id,
          fullName: admin.fullName,
          email: admin.email,
          language: 'en',
          avatarUrl: null,
          createdAt: expect.any(String),
          lastActiveAt: null,
        },
      });
      const cookie = refreshCookie(res);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(cookie).toMatch(/Path=\/api\/v1\/admin\/auth/);
      expect(cookie).toMatch(/Max-Age=2592000/);

      const sessions = await t.dataSource.getRepository(Session).findBy({ userId: admin.id });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.audience).toBe('dashboard');

      await request(t.http).get('/api/v1/admin/me').set('Authorization', `Bearer ${res.body.data.accessToken}`).expect(200);
      expect(await t.dataSource.getRepository(AuditLog).existsBy({ action: 'auth.login', actorId: admin.id })).toBe(true);
    });

    it('uses a browser-session cookie without remember', async () => {
      const admin = await makeAdmin();
      const res = await login(admin.email).expect(200);
      expect(refreshCookie(res)).not.toMatch(/Max-Age/);
    });

    it('400 VALIDATION_FAILED for missing fields, wrong types and unknown fields', async () => {
      const res = await request(t.http).post(`${BASE}/login`).send({ password: 12, remember: 'yes', extra: 1 });
      expectError(res, 400, 'VALIDATION_FAILED');
      const fields = (res.body.details as { field: string }[]).map((d) => d.field);
      expect(fields).toEqual(expect.arrayContaining(['email', 'password', 'remember', 'extra']));
    });

    it('401 INVALID_CREDENTIALS for a wrong password or unknown email, in Arabic too', async () => {
      const admin = await makeAdmin();
      expectError(await login(admin.email, 'WrongPass123'), 401, 'INVALID_CREDENTIALS');
      const res = await login(`nobody.${uid()}@eventor.dz`).set('Accept-Language', 'ar');
      expectError(res, 401, 'INVALID_CREDENTIALS');
      expect(res.body.message).toBe('البريد الإلكتروني أو كلمة المرور غير صحيحة.');
    });

    it('403 FORBIDDEN_ROLE for a non-admin account', async () => {
      const client = await makeUser(t.dataSource, { role: UserRole.Client, passwordHash: hash });
      expectError(await login(client.email), 403, 'FORBIDDEN_ROLE');
    });

    it('403 ACCOUNT_BLOCKED for a blocked admin', async () => {
      const admin = await makeAdmin({ status: UserStatus.Blocked });
      expectError(await login(admin.email), 403, 'ACCOUNT_BLOCKED');
    });

    it('locks the email for 15 min after 5 failed attempts', async () => {
      const admin = await makeAdmin();
      for (let i = 0; i < 5; i += 1) {
        expectError(await login(admin.email, 'WrongPass123'), 401, 'INVALID_CREDENTIALS');
      }
      const res = await login(admin.email);
      expectError(res, 429, 'ACCOUNT_LOCKED');
      expect(res.body.details.retryAfterSeconds).toBeGreaterThan(890);
      expect(res.body.details.retryAfterSeconds).toBeLessThanOrEqual(900);
      expect(res.headers['retry-after']).toBe(String(res.body.details.retryAfterSeconds));
      expect(await t.dataSource.getRepository(AuditLog).existsBy({ action: 'auth.account_locked', objectId: admin.id })).toBe(true);

      // Failures older than the window no longer count.
      await t.dataSource.getRepository(LoginAttempt).update({ email: admin.email }, { createdAt: new Date(Date.now() - 16 * 60_000) });
      await login(admin.email).expect(200);
    });
  });

  describe('POST /refresh', () => {
    it('rotates the refresh token and returns a new access token', async () => {
      const admin = await makeAdmin();
      const first = await login(admin.email).expect(200);
      const cookie1 = cookiePair(refreshCookie(first));

      const res = await request(t.http).post(`${BASE}/refresh`).set('Cookie', cookie1).expect(200);
      expect(res.body.data).toMatchObject({ accessToken: expect.any(String), expiresIn: 900, user: { id: admin.id } });
      const cookie2 = cookiePair(refreshCookie(res));
      expect(cookie2).not.toBe(cookie1);

      await request(t.http).post(`${BASE}/refresh`).set('Cookie', cookie2).expect(200);
    });

    it('revokes the session when a rotated token is replayed', async () => {
      const admin = await makeAdmin();
      const first = await login(admin.email).expect(200);
      const cookie1 = cookiePair(refreshCookie(first));
      const second = await request(t.http).post(`${BASE}/refresh`).set('Cookie', cookie1).expect(200);
      const cookie2 = cookiePair(refreshCookie(second));

      expectError(await request(t.http).post(`${BASE}/refresh`).set('Cookie', cookie1), 401, 'AUTH_REFRESH_INVALID');
      // The legitimate latest token is dead too, and so is the access token.
      expectError(await request(t.http).post(`${BASE}/refresh`).set('Cookie', cookie2), 401, 'AUTH_REFRESH_INVALID');
      expectError(
        await request(t.http).get('/api/v1/admin/me').set('Authorization', `Bearer ${second.body.data.accessToken}`),
        401,
        'AUTH_SESSION_REVOKED',
      );
      expect(await t.dataSource.getRepository(AuditLog).existsBy({ action: 'auth.refresh_reuse_detected', objectId: admin.id })).toBe(true);
    });

    it('401 AUTH_REFRESH_INVALID without or with a garbage cookie', async () => {
      expectError(await request(t.http).post(`${BASE}/refresh`), 401, 'AUTH_REFRESH_INVALID');
      expectError(await request(t.http).post(`${BASE}/refresh`).set('Cookie', 'eventor_admin_rt=nope'), 401, 'AUTH_REFRESH_INVALID');
    });

    it('401 ACCOUNT_BLOCKED when the admin was blocked', async () => {
      const admin = await makeAdmin();
      const first = await login(admin.email).expect(200);
      await t.dataSource.getRepository(User).update(admin.id, { status: UserStatus.Blocked });
      expectError(await request(t.http).post(`${BASE}/refresh`).set('Cookie', cookiePair(refreshCookie(first))), 401, 'ACCOUNT_BLOCKED');
    });
  });

  describe('POST /logout', () => {
    it('revokes the session and clears the cookie', async () => {
      const admin = await makeAdmin();
      const first = await login(admin.email).expect(200);
      const cookie = cookiePair(refreshCookie(first));

      const res = await request(t.http).post(`${BASE}/logout`).set('Cookie', cookie).expect(204);
      expect(refreshCookie(res)).toMatch(/eventor_admin_rt=;/);
      expectError(await request(t.http).post(`${BASE}/refresh`).set('Cookie', cookie), 401, 'AUTH_REFRESH_INVALID');
      expectError(
        await request(t.http).get('/api/v1/admin/me').set('Authorization', `Bearer ${first.body.data.accessToken}`),
        401,
        'AUTH_SESSION_REVOKED',
      );
    });

    it('works with only the bearer token, and is 204 with nothing at all', async () => {
      const admin = await makeAdmin();
      const first = await login(admin.email).expect(200);
      await request(t.http).post(`${BASE}/logout`).set('Authorization', `Bearer ${first.body.data.accessToken}`).expect(204);
      expect((await t.dataSource.getRepository(Session).findOneByOrFail({ userId: admin.id })).revokedAt).not.toBeNull();
      await request(t.http).post(`${BASE}/logout`).expect(204);
    });
  });

  describe('forgot + reset', () => {
    const lastMailTo = (email: string) => [...t.get(MailService).outbox].reverse().find((m) => m.to === email);
    const tokenFromMail = (text: string) => /reset-password\?token=([^\s]+)/.exec(text)?.[1];

    it('always answers 202 and emails an admin a reset link', async () => {
      const admin = await makeAdmin({ language: 'ar' as User['language'] });
      await request(t.http).post(`${BASE}/forgot`).send({ email: `ghost.${uid()}@eventor.dz` }).expect(202);
      await request(t.http).post(`${BASE}/forgot`).send({ email: admin.email }).expect(202);

      const mail = lastMailTo(admin.email);
      expect(mail?.subject).toBe('إعادة تعيين كلمة المرور');
      expect(mail?.text).toContain('http://localhost:3001/ar/reset-password?token=');
    });

    it('400 VALIDATION_FAILED without an email', async () => {
      expectError(await request(t.http).post(`${BASE}/forgot`).send({}), 400, 'VALIDATION_FAILED');
    });

    it('resets the password once, revokes every session and audits it', async () => {
      const admin = await makeAdmin();
      const signedIn = await login(admin.email).expect(200);
      await request(t.http).post(`${BASE}/forgot`).send({ email: admin.email }).expect(202);
      const token = decodeURIComponent(tokenFromMail(lastMailTo(admin.email)!.text)!);

      expectError(await request(t.http).post(`${BASE}/reset`).send({ token, password: 'short1' }), 422, 'PASSWORD_WEAK');
      await request(t.http).post(`${BASE}/reset`).send({ token, password: 'NewSecret2026x' }).expect(204);

      expectError(await request(t.http).post(`${BASE}/reset`).send({ token, password: 'NewSecret2026y' }), 400, 'RESET_TOKEN_INVALID');
      expectError(
        await request(t.http).get('/api/v1/admin/me').set('Authorization', `Bearer ${signedIn.body.data.accessToken}`),
        401,
        'AUTH_SESSION_REVOKED',
      );
      expectError(await login(admin.email), 401, 'INVALID_CREDENTIALS');
      await login(admin.email, 'NewSecret2026x').expect(200);
      expect(await t.dataSource.getRepository(AuditLog).existsBy({ action: 'auth.password_reset', objectId: admin.id })).toBe(true);
    });

    it('410 RESET_TOKEN_EXPIRED after an hour, 400 RESET_TOKEN_INVALID for garbage', async () => {
      const admin = await makeAdmin();
      await request(t.http).post(`${BASE}/forgot`).send({ email: admin.email }).expect(202);
      const token = decodeURIComponent(tokenFromMail(lastMailTo(admin.email)!.text)!);
      await t.dataSource.query('UPDATE `verification_codes` SET `expires_at` = ? WHERE `id` = ?', [
        new Date(Date.now() - 1000),
        token.split('.')[0],
      ]);
      expectError(await request(t.http).post(`${BASE}/reset`).send({ token, password: 'NewSecret2026x' }), 410, 'RESET_TOKEN_EXPIRED');
      expectError(await request(t.http).post(`${BASE}/reset`).send({ token: 'garbage', password: 'NewSecret2026x' }), 400, 'RESET_TOKEN_INVALID');
      expectError(await request(t.http).post(`${BASE}/reset`).send({ password: 'NewSecret2026x' }), 400, 'VALIDATION_FAILED');
    });
  });

  describe('invitations', () => {
    async function makeInvitation(overrides: Partial<AdminInvitation> = {}) {
      const inviter = await makeAdmin();
      const token = `tok-${uid(16)}`;
      const invitation = await t.dataSource.getRepository(AdminInvitation).save({
        email: `invitee.${uid()}@eventor.dz`,
        fullName: 'Karim Benali',
        tokenHash: hashToken(token),
        invitedById: inviter.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        ...overrides,
      });
      return { token, invitation };
    }

    it('GET shows the invitation', async () => {
      const { token, invitation } = await makeInvitation();
      const res = await request(t.http).get(`${BASE}/invitations/${token}`).expect(200);
      expect(res.body.data).toEqual({ fullName: 'Karim Benali', email: invitation.email, expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/) });
      // `expires_at` is datetime(0): MySQL rounds (not truncates) the milliseconds, so compare at second precision with a 1 s tolerance.
      expect(Math.abs(new Date(res.body.data.expiresAt).getTime() - invitation.expiresAt.getTime())).toBeLessThanOrEqual(1000);
    });

    it('404 INVITATION_INVALID for unknown, revoked or accepted; 410 INVITATION_EXPIRED', async () => {
      expectError(await request(t.http).get(`${BASE}/invitations/nope`), 404, 'INVITATION_INVALID');
      const revoked = await makeInvitation({ revokedAt: new Date() });
      expectError(await request(t.http).get(`${BASE}/invitations/${revoked.token}`), 404, 'INVITATION_INVALID');
      const expired = await makeInvitation({ expiresAt: new Date(Date.now() - 1000) });
      const res = await request(t.http).get(`${BASE}/invitations/${expired.token}`).set('Accept-Language', 'ar');
      expectError(res, 410, 'INVITATION_EXPIRED');
      expect(res.body.message).toBe('انتهت صلاحية هذه الدعوة.');
      expectError(await request(t.http).post(`${BASE}/invitations/${expired.token}/accept`).send({ password: PASSWORD }), 410, 'INVITATION_EXPIRED');
    });

    it('accepts: creates a verified admin, signs in, and the link is single-use', async () => {
      const { token, invitation } = await makeInvitation();
      expectError(await request(t.http).post(`${BASE}/invitations/${token}/accept`).send({}), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${BASE}/invitations/${token}/accept`).send({ password: 'weak' }), 422, 'PASSWORD_WEAK');

      const res = await request(t.http).post(`${BASE}/invitations/${token}/accept`).send({ password: PASSWORD }).expect(200);
      expect(res.body.data).toMatchObject({ accessToken: expect.any(String), expiresIn: 900, user: { email: invitation.email, fullName: 'Karim Benali' } });
      refreshCookie(res);

      const user = await t.dataSource.getRepository(User).findOneByOrFail({ email: invitation.email });
      expect(user.role).toBe(UserRole.Admin);
      expect(user.emailVerifiedAt).not.toBeNull();
      const row = await t.dataSource.getRepository(AdminInvitation).findOneByOrFail({ id: invitation.id });
      expect(row.acceptedAt).not.toBeNull();
      expect(row.userId).toBe(user.id);

      expectError(await request(t.http).post(`${BASE}/invitations/${token}/accept`).send({ password: PASSWORD }), 404, 'INVITATION_INVALID');
      await login(invitation.email).expect(200);
    });
  });
});
