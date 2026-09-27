import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { VerificationCode } from '../src/auth/entities/verification-code.entity.js';
import { Session } from '../src/auth/entities/session.entity.js';
import { PasswordService } from '../src/auth/password.service.js';
import { UserRole } from '../src/common/enums/user.enums.js';
import { envConfig, type Env } from '../src/config/env.js';
import { User } from '../src/users/entities/user.entity.js';
import { createApp, expectError, makeUser, uid, type TestApp } from './utils/index.js';

/**
 * AUTH_SKIP_EMAIL_VERIFICATION is the temporary switch for servers without
 * SMTP: sign-up must sign the user in straight away, and nothing may ask for a
 * verified email. With the switch off, the normal rules must come back.
 */
const PASSWORD = 'Sunflower42x';

let t: TestApp;
let env: Env;
const db = () => t.dataSource;

function newClient() {
  return {
    role: 'client',
    fullName: 'Amina Benali',
    email: `skip.${uid()}@test.eventor.dz`,
    phone: `+2135${String(Date.now()).slice(-8)}`,
    password: PASSWORD,
    language: 'en',
  };
}

beforeAll(async () => {
  t = await createApp();
  // The app and its services share this object, so flipping it here changes their behaviour.
  env = t.app.get<Env>(envConfig.KEY);
});

afterEach(() => {
  env.AUTH_SKIP_EMAIL_VERIFICATION = false;
});

afterAll(async () => {
  await t.close();
});

describe('AUTH_SKIP_EMAIL_VERIFICATION = true', () => {
  it('register returns tokens, marks the email verified and sends no code', async () => {
    env.AUTH_SKIP_EMAIL_VERIFICATION = true;
    const body = newClient();

    const res = await request(t.http).post('/api/v1/app/auth/register').send(body);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      emailVerificationRequired: false,
      emailSentTo: null,
      expiresAt: null,
      resendAfterSeconds: null,
    });
    expect(res.body.data.session.accessToken).toEqual(expect.any(String));
    expect(res.body.data.session.refreshToken).toEqual(expect.any(String));

    const user = await db().getRepository(User).findOneByOrFail({ email: body.email });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(await db().getRepository(VerificationCode).countBy({ destination: body.email })).toBe(0);
    expect(await db().getRepository(Session).countBy({ userId: user.id })).toBe(1);

    // The returned token works on a private route.
    const me = await request(t.http).get('/api/v1/app/me').set('Authorization', `Bearer ${res.body.data.session.accessToken}`);
    expect(me.status).toBe(200);
  });

  it('login accepts an account whose email was never verified', async () => {
    const user = await makeUser(db(), { role: UserRole.Client, passwordHash: await t.app.get(PasswordService).hash(PASSWORD), emailVerifiedAt: null });
    env.AUTH_SKIP_EMAIL_VERIFICATION = true;

    const res = await request(t.http).post('/api/v1/app/auth/login').send({ email: user.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
  });

  it('/app/config tells the app to skip the code screen', async () => {
    env.AUTH_SKIP_EMAIL_VERIFICATION = true;
    const res = await request(t.http).get('/api/v1/app/config');
    expect(res.status).toBe(200);
    expect(res.body.data.emailVerificationRequired).toBe(false);
  });
});

describe('AUTH_SKIP_EMAIL_VERIFICATION = false (default)', () => {
  it('register sends a code and returns no session', async () => {
    const body = newClient();
    const res = await request(t.http).post('/api/v1/app/auth/register').send(body);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ emailVerificationRequired: true, emailSentTo: body.email, session: null });
    expect(await db().getRepository(VerificationCode).countBy({ destination: body.email })).toBe(1);
  });

  it('login still refuses an unverified email', async () => {
    const user = await makeUser(db(), { role: UserRole.Client, passwordHash: await t.app.get(PasswordService).hash(PASSWORD), emailVerifiedAt: null });
    const res = await request(t.http).post('/api/v1/app/auth/login').send({ email: user.email, password: PASSWORD });
    expectError(res, 403, 'EMAIL_NOT_VERIFIED');
  });

  it('/app/config says verification is required', async () => {
    const res = await request(t.http).get('/api/v1/app/config');
    expect(res.body.data.emailVerificationRequired).toBe(true);
  });
});
