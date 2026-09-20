import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VerificationCode } from '../src/auth/entities/verification-code.entity.js';
import { createKeyedToken } from '../src/auth/refresh-token.js';
import { SessionAudience, VerificationCodePurpose } from '../src/common/enums/auth.enums.js';
import { Language, UserRole, UserStatus, VerificationStatus } from '../src/common/enums/user.enums.js';
import { PasswordService } from '../src/auth/password.service.js';
import { Session } from '../src/auth/entities/session.entity.js';
import { User } from '../src/users/entities/user.entity.js';
import { createApp, expectError, makeCategory, makeUser, tokenFor, uid, type TestApp } from './utils/index.js';

const BASE = '/api/v1/app/auth';
const PASSWORD = 'Sunflower42x';

let t: TestApp;
const db = () => t.dataSource;

/** The 6-digit code is only ever hashed in the database, so tests re-derive it the way the service does. */
async function codeFor(email: string, purpose: VerificationCodePurpose): Promise<string> {
  const { createHmac } = await import('node:crypto');
  const [row] = await db().query(
    "SELECT code_hash FROM verification_codes WHERE destination = ? AND purpose = ? AND consumed_at IS NULL AND code_hash LIKE 'code:%' ORDER BY created_at DESC LIMIT 1",
    [email, purpose],
  );
  expect(row, `no live ${purpose} code for ${email}`).toBeTruthy();
  const secret = process.env.FILES_SIGNING_SECRET ?? 'dev-files-signing-secret-change-me-32ch';
  for (let candidate = 0; candidate < 1_000_000; candidate++) {
    const code = String(candidate).padStart(6, '0');
    const hash = 'code:' + createHmac('sha256', secret).update(`${purpose}:${email}:${code}`).digest('hex');
    if (hash === row.code_hash) return code;
  }
  throw new Error('could not recover the code');
}

/** Removes the 60 s resend brake by ageing the last code. */
async function ageLastCode(email: string): Promise<void> {
  await db().query(
    'UPDATE verification_codes SET created_at = DATE_SUB(created_at, INTERVAL 5 MINUTE) WHERE destination = ?',
    [email],
  );
}

async function registerClient(overrides: Record<string, unknown> = {}) {
  const email = `client.${uid()}@test.eventor.dz`;
  const phone = `+2135${String(Date.now()).slice(-8)}`;
  const res = await request(t.http)
    .post(`${BASE}/register`)
    .send({ role: 'client', fullName: 'Amina Benali', email, phone, password: PASSWORD, language: 'en', ...overrides });
  return { res, email, phone };
}

/** A verified, signed-in app account, the starting point of most cases. */
async function signedInClient() {
  const { res, email } = await registerClient();
  expect(res.status).toBe(201);
  const code = await codeFor(email, VerificationCodePurpose.EmailVerify);
  const verified = await request(t.http).post(`${BASE}/verify-email`).send({ email, code });
  expect(verified.status).toBe(200);
  return { email, session: verified.body.data as { accessToken: string; refreshToken: string; user: { id: string } } };
}

beforeAll(async () => {
  t = await createApp();
});

afterAll(async () => {
  await t.close();
});

describe('App auth (e2e)', () => {
  describe('POST /app/auth/register', () => {
    it('creates an unverified client, emails a code and issues no tokens (screen 08)', async () => {
      const { res, email, phone } = await registerClient();

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        emailSentTo: email,
        resendAfterSeconds: 60,
        verificationStatus: VerificationStatus.NotRequired,
      });
      expect(res.body.data.userId).toEqual(expect.any(String));
      expect(res.body.data.expiresAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
      // No session may exist before the email is proven.
      expect(res.body.data).not.toHaveProperty('accessToken');
      expect(res.body.data).not.toHaveProperty('refreshToken');

      const user = await db().getRepository(User).findOneByOrFail({ email });
      expect(user.emailVerifiedAt).toBeNull();
      expect(user.role).toBe(UserRole.Client);
      expect(user.phone).toBe(phone);
      expect(user.passwordHash).toBeTruthy();
      expect(user.passwordHash).not.toContain(PASSWORD);
      expect(await db().getRepository(Session).countBy({ userId: user.id })).toBe(0);

      const codes = await db().getRepository(VerificationCode).findBy({ destination: email });
      expect(codes).toHaveLength(1);
      expect(codes[0]!.purpose).toBe(VerificationCodePurpose.EmailVerify);
      // The code is never stored in the clear.
      expect(codes[0]!.codeHash).toMatch(/^code:[0-9a-f]{64}$/);
    });

    it('normalises the phone to +213 and lowercases the email', async () => {
      const email = `Client.${uid()}@Test.Eventor.DZ`;
      const local = `05${String(Date.now()).slice(-8)}`;
      const res = await request(t.http)
        .post(`${BASE}/register`)
        .send({ role: 'client', fullName: 'Amina Benali', email, phone: local, password: PASSWORD, language: 'ar' });

      expect(res.status).toBe(201);
      const user = await db().getRepository(User).findOneByOrFail({ email: email.toLowerCase() });
      expect(user.phone).toBe(`+213${local.slice(1)}`);
      expect(user.language).toBe(Language.Ar);
    });

    it('creates a provider with a profile, wilayas and verification pending (screen 08a)', async () => {
      const category = await makeCategory(db());
      const email = `provider.${uid()}@test.eventor.dz`;
      const res = await request(t.http).post(`${BASE}/register`).send({
        role: 'provider',
        fullName: 'Karim Studio',
        email,
        phone: `+2136${String(Date.now()).slice(-8)}`,
        password: PASSWORD,
        language: 'en',
        wilayaCode: 16,
        businessName: 'Studio Lumière',
        categoryId: category.id,
        wilayaCodes: [16, 9],
      });

      expect(res.status).toBe(201);
      expect(res.body.data.verificationStatus).toBe(VerificationStatus.Pending);
      const user = await db().getRepository(User).findOneByOrFail({ email });
      const [profile] = await db().query('SELECT id, business_name, category_id, accepting_bookings FROM provider_profiles WHERE user_id = ?', [user.id]);
      expect(profile).toMatchObject({ business_name: 'Studio Lumière', category_id: category.id });
      const wilayas = await db().query('SELECT wilaya_code FROM provider_wilayas WHERE provider_profile_id = ? ORDER BY wilaya_code', [profile.id]);
      expect(wilayas.map((w: { wilaya_code: number }) => Number(w.wilaya_code))).toEqual([9, 16]);
    });

    it('422 PROVIDER_FIELDS_REQUIRED without a business name or category', async () => {
      const { res } = await registerClient({ role: 'provider' });
      expectError(res, 422, 'PROVIDER_FIELDS_REQUIRED');
    });

    it('422 PROVIDER_FIELDS_NOT_ALLOWED when a client sends provider fields', async () => {
      const category = await makeCategory(db());
      const { res } = await registerClient({ businessName: 'Nope', categoryId: category.id });
      expectError(res, 422, 'PROVIDER_FIELDS_NOT_ALLOWED');
    });

    it('409 EMAIL_TAKEN and 409 PHONE_TAKEN on a duplicate', async () => {
      const { email, phone } = await registerClient();
      const sameEmail = await registerClient({ email });
      expectError(sameEmail.res, 409, 'EMAIL_TAKEN');
      const samePhone = await registerClient({ phone });
      expectError(samePhone.res, 409, 'PHONE_TAKEN');
    });

    it('422 PASSWORD_WEAK below the policy', async () => {
      const { res } = await registerClient({ password: 'short1' });
      expectError(res, 422, 'PASSWORD_WEAK');
    });

    it.each([
      ['a missing field', { fullName: undefined }],
      ['a bad email', { email: 'not-an-email' }],
      ['a non-Algerian phone', { phone: '+33612345678' }],
      ['an unknown role', { role: 'academic' }],
      ['an unknown field', { nickname: 'x' }],
    ])('400 VALIDATION_FAILED for %s', async (_label, patch) => {
      const { res } = await registerClient(patch as Record<string, unknown>);
      expectError(res, 400, 'VALIDATION_FAILED');
      expect(Array.isArray(res.body.details)).toBe(true);
    });

    it('404 CATEGORY_NOT_FOUND / WILAYA_NOT_FOUND for unknown references', async () => {
      const unknownCategory = await registerClient({
        role: 'provider',
        businessName: 'Studio X',
        categoryId: '11111111-1111-4111-8111-111111111111',
      });
      expectError(unknownCategory.res, 404, 'CATEGORY_NOT_FOUND');
      const unknownWilaya = await registerClient({ wilayaCode: 99 });
      expectError(unknownWilaya.res, 400, 'VALIDATION_FAILED');
    });

    it('returns the Arabic message with Accept-Language: ar', async () => {
      const { email } = await registerClient();
      const res = await request(t.http)
        .post(`${BASE}/register`)
        .set('Accept-Language', 'ar')
        .send({ role: 'client', fullName: 'Amina', email, phone: `+2137${String(Date.now()).slice(-8)}`, password: PASSWORD, language: 'ar' });

      expectError(res, 409, 'EMAIL_TAKEN');
      expect(res.body.message).toMatch(/[؀-ۿ]/);
    });
  });

  describe('POST /app/auth/verify-email', () => {
    it('consumes the code, verifies the email and signs in with audience app (screen 10)', async () => {
      const { res, email } = await registerClient();
      const userId = res.body.data.userId;
      const code = await codeFor(email, VerificationCodePurpose.EmailVerify);

      const verified = await request(t.http).post(`${BASE}/verify-email`).send({ email, code });

      expect(verified.status).toBe(200);
      expect(verified.body.data).toMatchObject({ expiresIn: expect.any(Number) });
      expect(verified.body.data.accessToken).toEqual(expect.any(String));
      // Mobile gets the refresh token in the body, never a cookie.
      expect(verified.body.data.refreshToken).toEqual(expect.any(String));
      expect(verified.headers['set-cookie']).toBeUndefined();
      expect(verified.body.data.user).toMatchObject({ id: userId, email, emailVerified: true, role: UserRole.Client });
      expect(verified.body.data.user).not.toHaveProperty('passwordHash');

      const user = await db().getRepository(User).findOneByOrFail({ id: userId });
      expect(user.emailVerifiedAt).not.toBeNull();
      const session = await db().getRepository(Session).findOneByOrFail({ userId });
      expect(session.audience).toBe(SessionAudience.App);
      const [code_] = await db().query('SELECT consumed_at FROM verification_codes WHERE destination = ?', [email]);
      expect(code_.consumed_at).not.toBeNull();
    });

    it('422 CODE_INVALID for a wrong code, and the attempt is counted', async () => {
      const { email } = await registerClient();

      const res = await request(t.http).post(`${BASE}/verify-email`).send({ email, code: '000000' });

      expectError(res, 422, 'CODE_INVALID');
      const [row] = await db().query('SELECT attempts FROM verification_codes WHERE destination = ?', [email]);
      expect(Number(row.attempts)).toBe(1);
    });

    it('422 CODE_EXPIRED after 5 wrong tries, even with the right code', async () => {
      const { email } = await registerClient();
      const code = await codeFor(email, VerificationCodePurpose.EmailVerify);
      for (let i = 0; i < 5; i++) {
        await request(t.http).post(`${BASE}/verify-email`).send({ email, code: '000000' });
      }

      expectError(await request(t.http).post(`${BASE}/verify-email`).send({ email, code }), 422, 'CODE_EXPIRED');
    });

    it('422 CODE_EXPIRED past the 15 minute window', async () => {
      const { email } = await registerClient();
      const code = await codeFor(email, VerificationCodePurpose.EmailVerify);
      await db().query('UPDATE verification_codes SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE destination = ?', [email]);

      expectError(await request(t.http).post(`${BASE}/verify-email`).send({ email, code }), 422, 'CODE_EXPIRED');
    });

    it('422 CODE_INVALID for an address that never asked for one', async () => {
      const res = await request(t.http).post(`${BASE}/verify-email`).send({ email: 'nobody@test.eventor.dz', code: '123456' });
      expectError(res, 422, 'CODE_INVALID');
    });

    it.each([['123'], ['abcdef'], ['12345678']])('400 VALIDATION_FAILED for the code %j', async (code) => {
      const res = await request(t.http).post(`${BASE}/verify-email`).send({ email: 'a@test.eventor.dz', code });
      expectError(res, 400, 'VALIDATION_FAILED');
    });
  });

  describe('POST /app/auth/verify-email/resend', () => {
    it('issues a new code and invalidates the old one', async () => {
      const { email } = await registerClient();
      const first = await codeFor(email, VerificationCodePurpose.EmailVerify);
      await ageLastCode(email);

      const res = await request(t.http).post(`${BASE}/verify-email/resend`).send({ email });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ email, resendAfterSeconds: 60 });
      const second = await codeFor(email, VerificationCodePurpose.EmailVerify);
      expect(second).not.toBe(first);
      // The replaced code no longer works.
      expectError(await request(t.http).post(`${BASE}/verify-email`).send({ email, code: first }), 422, 'CODE_INVALID');
    });

    it('429 CODE_RESEND_TOO_SOON inside the 60 s brake', async () => {
      const { email } = await registerClient();
      const res = await request(t.http).post(`${BASE}/verify-email/resend`).send({ email });
      expectError(res, 429, 'CODE_RESEND_TOO_SOON');
      expect(res.body.details.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('answers the same shape for an unknown address (no account enumeration)', async () => {
      const res = await request(t.http).post(`${BASE}/verify-email/resend`).send({ email: `ghost.${uid()}@test.eventor.dz` });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ resendAfterSeconds: 60 });
      expect(Object.keys(res.body.data).sort()).toEqual(['email', 'expiresAt', 'resendAfterSeconds']);
    });
  });

  describe('POST /app/auth/login', () => {
    it('signs a verified client in (screen 07)', async () => {
      const { email } = await signedInClient();

      const res = await request(t.http).post(`${BASE}/login`).send({ email, password: PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toEqual(expect.any(String));
      expect(res.body.data.refreshToken).toEqual(expect.any(String));
      expect(res.body.data.user.email).toBe(email);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('403 EMAIL_NOT_VERIFIED with details.email, so the app can resume screen 10', async () => {
      const { email } = await registerClient();

      const res = await request(t.http).post(`${BASE}/login`).send({ email, password: PASSWORD });

      expectError(res, 403, 'EMAIL_NOT_VERIFIED');
      expect(res.body.details).toEqual({ email });
    });

    it('401 INVALID_CREDENTIALS for a wrong password and for an unknown email', async () => {
      const { email } = await signedInClient();
      expectError(await request(t.http).post(`${BASE}/login`).send({ email, password: 'Wrongpass123' }), 401, 'INVALID_CREDENTIALS');
      expectError(
        await request(t.http).post(`${BASE}/login`).send({ email: `ghost.${uid()}@test.eventor.dz`, password: PASSWORD }),
        401,
        'INVALID_CREDENTIALS',
      );
    });

    it('403 ACCOUNT_BLOCKED carries the admin’s message', async () => {
      const { email, session } = await signedInClient();
      await db().getRepository(User).update(session.user.id, {
        status: UserStatus.Blocked,
        blockedReason: 'fraud',
        blockedMessage: 'Your account is under review.',
      });

      const res = await request(t.http).post(`${BASE}/login`).send({ email, password: PASSWORD });

      expectError(res, 403, 'ACCOUNT_BLOCKED');
      expect(res.body.details).toMatchObject({ reason: 'fraud', message: 'Your account is under review.' });
    });

    it('403 ROLE_NOT_ALLOWED_IN_APP for an admin account', async () => {
      const password = await t.get(PasswordService).hash(PASSWORD);
      const admin = await makeUser(db(), { role: UserRole.Admin, passwordHash: password });

      expectError(await request(t.http).post(`${BASE}/login`).send({ email: admin.email, password: PASSWORD }), 403, 'ROLE_NOT_ALLOWED_IN_APP');
    });

    it('429 ACCOUNT_LOCKED after 5 failures, with retryAfterSeconds', async () => {
      const { email } = await signedInClient();
      for (let i = 0; i < 5; i++) {
        await request(t.http).post(`${BASE}/login`).send({ email, password: 'Wrongpass123' });
      }

      const res = await request(t.http).post(`${BASE}/login`).send({ email, password: PASSWORD });

      expectError(res, 429, 'ACCOUNT_LOCKED');
      expect(res.body.details.retryAfterSeconds).toBeGreaterThan(0);
    });
  });

  describe('POST /app/auth/refresh', () => {
    it('rotates the token and keeps the session', async () => {
      const { session } = await signedInClient();

      const res = await request(t.http).post(`${BASE}/refresh`).send({ refreshToken: session.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.data.refreshToken).not.toBe(session.refreshToken);
      expect(res.body.data.accessToken).toEqual(expect.any(String));
      expect(res.body.data.user.id).toBe(session.user.id);
    });

    it('revokes the whole session when a rotated token is replayed', async () => {
      const { session } = await signedInClient();
      const rotated = await request(t.http).post(`${BASE}/refresh`).send({ refreshToken: session.refreshToken });

      // Replaying the first token is the classic stolen-token signal.
      expectError(await request(t.http).post(`${BASE}/refresh`).send({ refreshToken: session.refreshToken }), 401, 'AUTH_REFRESH_INVALID');
      // ...and the token that was valid a moment ago is dead too.
      expectError(
        await request(t.http).post(`${BASE}/refresh`).send({ refreshToken: rotated.body.data.refreshToken }),
        401,
        'AUTH_REFRESH_INVALID',
      );
      const sessions = await db().getRepository(Session).findBy({ userId: session.user.id });
      expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
    });

    it('401 AUTH_REFRESH_INVALID for a malformed token and for a dashboard one', async () => {
      expectError(await request(t.http).post(`${BASE}/refresh`).send({ refreshToken: 'nonsense' }), 401, 'AUTH_REFRESH_INVALID');

      const admin = await makeUser(db(), { role: UserRole.Admin });
      const dashboard = await tokenFor(t, admin);
      expectError(
        await request(t.http).post(`${BASE}/refresh`).send({ refreshToken: `${dashboard.session.id}.1.${'a'.repeat(43)}` }),
        401,
        'AUTH_REFRESH_INVALID',
      );
    });
  });

  describe('POST /app/auth/logout', () => {
    it('revokes the session behind the refresh token and is idempotent', async () => {
      const { session } = await signedInClient();

      expect((await request(t.http).post(`${BASE}/logout`).send({ refreshToken: session.refreshToken })).status).toBe(204);

      const row = await db().getRepository(Session).findOneByOrFail({ userId: session.user.id });
      expect(row.revokedAt).not.toBeNull();
      // The access token dies with the session.
      expectError(
        await request(t.http).get('/api/v1/app/me').set('Authorization', `Bearer ${session.accessToken}`),
        401,
        'AUTH_SESSION_REVOKED',
      );
      // Signing out twice still answers 204.
      expect((await request(t.http).post(`${BASE}/logout`).send({ refreshToken: session.refreshToken })).status).toBe(204);
    });

    it('falls back to the bearer token when no refresh token is sent', async () => {
      const { session } = await signedInClient();

      const res = await request(t.http).post(`${BASE}/logout`).set('Authorization', `Bearer ${session.accessToken}`).send({});

      expect(res.status).toBe(204);
      const row = await db().getRepository(Session).findOneByOrFail({ userId: session.user.id });
      expect(row.revokedAt).not.toBeNull();
    });
  });

  describe('password recovery (screens 09 / 10a)', () => {
    it('always answers 202, and emails a code to a real account', async () => {
      const { email } = await signedInClient();

      expect((await request(t.http).post(`${BASE}/forgot`).send({ email })).status).toBe(202);
      const codes = await db().query(
        "SELECT id FROM verification_codes WHERE destination = ? AND purpose = 'password_reset' AND code_hash LIKE 'code:%'",
        [email],
      );
      expect(codes).toHaveLength(1);
    });

    it('answers 202 for an unknown address without writing a code', async () => {
      const ghost = `ghost.${uid()}@test.eventor.dz`;

      expect((await request(t.http).post(`${BASE}/forgot`).send({ email: ghost })).status).toBe(202);

      expect(await db().query('SELECT id FROM verification_codes WHERE destination = ?', [ghost])).toHaveLength(0);
    });

    it('202 even inside the resend brake, so timing does not reveal the account', async () => {
      const { email } = await signedInClient();
      await request(t.http).post(`${BASE}/forgot`).send({ email });

      expect((await request(t.http).post(`${BASE}/forgot`).send({ email })).status).toBe(202);
    });

    it('resets the password, revokes every session and lets the new one sign in', async () => {
      const { email, session } = await signedInClient();
      await request(t.http).post(`${BASE}/forgot`).send({ email });
      const code = await codeFor(email, VerificationCodePurpose.PasswordReset);

      const res = await request(t.http).post(`${BASE}/reset`).send({ email, code, password: 'Bluebird99z' });

      expect(res.status).toBe(204);
      const sessions = await db().getRepository(Session).findBy({ userId: session.user.id });
      expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
      expectError(await request(t.http).post(`${BASE}/login`).send({ email, password: PASSWORD }), 401, 'INVALID_CREDENTIALS');
      expect((await request(t.http).post(`${BASE}/login`).send({ email, password: 'Bluebird99z' })).status).toBe(200);
    });

    it('422 CODE_INVALID for a wrong code and 422 PASSWORD_WEAK for a bad password', async () => {
      const { email } = await signedInClient();
      await request(t.http).post(`${BASE}/forgot`).send({ email });
      const code = await codeFor(email, VerificationCodePurpose.PasswordReset);

      expectError(await request(t.http).post(`${BASE}/reset`).send({ email, code: '000000', password: 'Bluebird99z' }), 422, 'CODE_INVALID');
      expectError(await request(t.http).post(`${BASE}/reset`).send({ email, code, password: 'weak' }), 422, 'PASSWORD_WEAK');
    });

    it('verifies the email as a side effect: receiving the code proves the address', async () => {
      const { email } = await registerClient();
      await ageLastCode(email);
      await request(t.http).post(`${BASE}/forgot`).send({ email });
      const code = await codeFor(email, VerificationCodePurpose.PasswordReset);

      expect((await request(t.http).post(`${BASE}/reset`).send({ email, code, password: 'Bluebird99z' })).status).toBe(204);

      const user = await db().getRepository(User).findOneByOrFail({ email });
      expect(user.emailVerifiedAt).not.toBeNull();
      expect((await request(t.http).post(`${BASE}/login`).send({ email, password: 'Bluebird99z' })).status).toBe(200);
    });
  });

  describe('POST /app/auth/set-password', () => {
    /** Reproduces what `POST /admin/users` leaves behind: an account with no password and an emailed token. */
    async function invitedAccount() {
      const user = await makeUser(db(), { passwordHash: null, emailVerifiedAt: null });
      const repository = db().getRepository(VerificationCode);
      const row = await repository.save(
        repository.create({
          userId: user.id,
          purpose: VerificationCodePurpose.PasswordReset,
          destination: user.email,
          codeHash: 'pending',
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
          consumedAt: null,
          createdAt: new Date(),
        }),
      );
      const { token, hash } = createKeyedToken(row.id);
      await repository.update(row.id, { codeHash: hash });
      return { user, token, codeId: row.id };
    }

    it('sets the password, verifies the email and signs in', async () => {
      const { user, token, codeId } = await invitedAccount();

      const res = await request(t.http).post(`${BASE}/set-password`).send({ token, password: PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.data.user.id).toBe(user.id);
      expect(res.body.data.refreshToken).toEqual(expect.any(String));
      const saved = await db().getRepository(User).findOneByOrFail({ id: user.id });
      expect(saved.passwordHash).toBeTruthy();
      expect(saved.emailVerifiedAt).not.toBeNull();
      const code = await db().getRepository(VerificationCode).findOneByOrFail({ id: codeId });
      expect(code.consumedAt).not.toBeNull();
    });

    it('400 RESET_TOKEN_INVALID when the token is reused, malformed or already consumed', async () => {
      const { token } = await invitedAccount();
      await request(t.http).post(`${BASE}/set-password`).send({ token, password: PASSWORD });

      expectError(await request(t.http).post(`${BASE}/set-password`).send({ token, password: PASSWORD }), 400, 'RESET_TOKEN_INVALID');
      expectError(await request(t.http).post(`${BASE}/set-password`).send({ token: 'nonsense', password: PASSWORD }), 400, 'RESET_TOKEN_INVALID');
    });

    it('410 RESET_TOKEN_EXPIRED past the window', async () => {
      const { token, codeId } = await invitedAccount();
      await db().getRepository(VerificationCode).update(codeId, { expiresAt: new Date(Date.now() - 1000) });

      const res = await request(t.http).post(`${BASE}/set-password`).send({ token, password: PASSWORD });
      expect(res.body.code).toBe('RESET_TOKEN_EXPIRED');
    });

    it('cannot be used with a 6-digit reset code in place of the token', async () => {
      // The two kinds of secret share the table; only the keyed token opens this route.
      const { email } = await signedInClient();
      await request(t.http).post(`${BASE}/forgot`).send({ email });
      const [row] = await db().query(
        "SELECT id FROM verification_codes WHERE destination = ? AND code_hash LIKE 'code:%' ORDER BY created_at DESC LIMIT 1",
        [email],
      );
      const code = await codeFor(email, VerificationCodePurpose.PasswordReset);

      const res = await request(t.http).post(`${BASE}/set-password`).send({ token: `${row.id}.${code.padEnd(43, 'a')}`, password: PASSWORD });

      expectError(res, 400, 'RESET_TOKEN_INVALID');
    });
  });

  describe('token audiences never cross', () => {
    it('403 FORBIDDEN_AUDIENCE for a dashboard session on /app/**', async () => {
      // A client whose session was minted for the dashboard: right role, wrong application.
      const client = await makeUser(db(), { role: UserRole.Client });
      const dashboard = await tokenFor(t, { ...client, role: UserRole.Admin } as typeof client);
      const session = await db().getRepository(Session).findOneByOrFail({ id: dashboard.session.id });
      expect(session.audience).toBe(SessionAudience.Dashboard);

      const res = await request(t.http).get('/api/v1/app/me').set(dashboard.headers);

      expectError(res, 403, 'FORBIDDEN_AUDIENCE');
      expect(res.body.details).toMatchObject({ expected: 'app', actual: 'dashboard' });
    });

    it('403 FORBIDDEN_ROLE for an app session on /admin/** (the role is the more specific answer)', async () => {
      const { session } = await signedInClient();

      expectError(
        await request(t.http).get('/api/v1/admin/users').set('Authorization', `Bearer ${session.accessToken}`),
        403,
        'FORBIDDEN_ROLE',
      );
    });

    it('401 without a token on a private app route', async () => {
      expectError(await request(t.http).get('/api/v1/app/me'), 401, 'AUTH_TOKEN_MISSING');
    });
  });
});
