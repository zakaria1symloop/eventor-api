import request from 'supertest';
import sharp from 'sharp';
import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { AdminInvitation } from '../src/auth/entities/admin-invitation.entity.js';
import { Session } from '../src/auth/entities/session.entity.js';
import { PasswordService } from '../src/auth/password.service.js';
import { UserRole, UserStatus } from '../src/common/enums/user.enums.js';
import { MailService } from '../src/mail/mail.service.js';
import { User } from '../src/users/entities/user.entity.js';
import { createApp, expectError, loginAs, makeUser, tokenFor, uid, type LoggedIn, type TestApp } from './utils/index.js';

const PASSWORD = 'Sunflower42x';
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('Admin account & team (e2e)', () => {
  let t: TestApp;
  let hash: string;

  beforeAll(async () => {
    t = await createApp();
    hash = await t.get(PasswordService).hash(PASSWORD);
  });

  afterAll(async () => {
    await t?.close();
  });

  const admin = (overrides: Partial<User> = {}) => loginAs(t, UserRole.Admin, { passwordHash: hash, ...overrides });
  const audited = (action: string, objectId: string) => t.dataSource.getRepository(AuditLog).existsBy({ action, objectId });

  describe('guard', () => {
    it('401 ACCOUNT_BLOCKED for a blocked admin and revokes their sessions', async () => {
      const me = await admin();
      await t.dataSource.getRepository(User).update(me.user.id, { status: UserStatus.Blocked });
      expectError(await request(t.http).get('/api/v1/admin/me').set(me.headers), 401, 'ACCOUNT_BLOCKED');
      expect((await t.dataSource.getRepository(Session).findOneByOrFail({ id: me.session.id })).revokedAt).not.toBeNull();
    });

    it('401 AUTH_TOKEN_INVALID for a token without a session', async () => {
      const me = await admin();
      await t.dataSource.getRepository(Session).delete(me.session.id);
      expectError(await request(t.http).get('/api/v1/admin/me').set(me.headers), 401, 'AUTH_TOKEN_INVALID');
    });

    it('records last activity', async () => {
      const me = await admin();
      await request(t.http).get('/api/v1/admin/me').set(me.headers).expect(200);
      expect((await t.dataSource.getRepository(User).findOneByOrFail({ id: me.user.id })).lastActiveAt).not.toBeNull();
    });
  });

  describe('GET /admin/me', () => {
    it('returns my account', async () => {
      const me = await admin();
      const res = await request(t.http).get('/api/v1/admin/me').set(me.headers).expect(200);
      expect(Object.keys(res.body.data).sort()).toEqual(['avatarUrl', 'createdAt', 'email', 'fullName', 'id', 'language', 'lastActiveAt']);
      expect(res.body.data).toMatchObject({ id: me.user.id, email: me.user.email, avatarUrl: null });
    });

    it('401 without a token, 403 for a client', async () => {
      expectError(await request(t.http).get('/api/v1/admin/me'), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).get('/api/v1/admin/me').set(client.headers), 403, 'FORBIDDEN_ROLE');
    });
  });

  describe('PATCH /admin/me', () => {
    it('updates name and language and audits it', async () => {
      const me = await admin();
      const res = await request(t.http).patch('/api/v1/admin/me').set(me.headers).send({ fullName: '  Sara M.  ', language: 'ar' }).expect(200);
      expect(res.body.data).toMatchObject({ fullName: 'Sara M.', language: 'ar' });
      expect(await audited('account.updated', me.user.id)).toBe(true);
    });

    it('changes the email only with the current password', async () => {
      const me = await admin();
      const email = `new.${uid()}@eventor.dz`;
      const noPassword = await request(t.http).patch('/api/v1/admin/me').set(me.headers).send({ email });
      expectError(noPassword, 400, 'VALIDATION_FAILED');
      expect(noPassword.body.details[0].field).toBe('currentPassword');

      const wrong = await request(t.http).patch('/api/v1/admin/me').set(me.headers).set('Accept-Language', 'ar').send({ email, currentPassword: 'nope' });
      expectError(wrong, 422, 'CURRENT_PASSWORD_INVALID');
      expect(wrong.body.message).toBe('كلمة المرور الحالية غير صحيحة.');

      const taken = await makeUser(t.dataSource);
      expectError(await request(t.http).patch('/api/v1/admin/me').set(me.headers).send({ email: taken.email, currentPassword: PASSWORD }), 409, 'EMAIL_TAKEN');

      const res = await request(t.http).patch('/api/v1/admin/me').set(me.headers).send({ email: email.toUpperCase(), currentPassword: PASSWORD }).expect(200);
      expect(res.body.data.email).toBe(email);
      expect(await audited('account.email_changed', me.user.id)).toBe(true);
    });

    it('400 for wrong types and unknown fields; 401; 403', async () => {
      const me = await admin();
      const res = await request(t.http).patch('/api/v1/admin/me').set(me.headers).send({ language: 'fr', fullName: 5, role: 'admin' });
      expectError(res, 400, 'VALIDATION_FAILED');
      expect((res.body.details as { field: string }[]).map((d) => d.field)).toEqual(expect.arrayContaining(['language', 'fullName', 'role']));
      expectError(await request(t.http).patch('/api/v1/admin/me').send({}), 401, 'AUTH_TOKEN_MISSING');
      const provider = await loginAs(t, UserRole.Provider);
      expectError(await request(t.http).patch('/api/v1/admin/me').set(provider.headers).send({}), 403, 'FORBIDDEN_ROLE');
    });
  });

  describe('POST /admin/me/password', () => {
    it('changes the password and revokes the other sessions only', async () => {
      const me = await admin();
      const other = await tokenFor(t, me.user);
      await request(t.http).post('/api/v1/admin/me/password').set(me.headers).send({ currentPassword: PASSWORD, newPassword: 'Another2026pw' }).expect(204);

      await request(t.http).get('/api/v1/admin/me').set(me.headers).expect(200);
      expectError(await request(t.http).get('/api/v1/admin/me').set(other.headers), 401, 'AUTH_SESSION_REVOKED');
      const user = await t.dataSource.getRepository(User).findOneByOrFail({ id: me.user.id });
      expect(await t.get(PasswordService).verify(user.passwordHash, 'Another2026pw')).toBe(true);
      expect(await audited('account.password_changed', me.user.id)).toBe(true);
    });

    it('422 CURRENT_PASSWORD_INVALID, 422 PASSWORD_WEAK, 400, 401, 403', async () => {
      const me = await admin();
      expectError(await request(t.http).post('/api/v1/admin/me/password').set(me.headers).send({ currentPassword: 'bad', newPassword: 'Another2026pw' }), 422, 'CURRENT_PASSWORD_INVALID');
      expectError(await request(t.http).post('/api/v1/admin/me/password').set(me.headers).send({ currentPassword: PASSWORD, newPassword: 'abc' }), 422, 'PASSWORD_WEAK');
      expectError(await request(t.http).post('/api/v1/admin/me/password').set(me.headers).send({ currentPassword: PASSWORD }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post('/api/v1/admin/me/password').send({}), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).post('/api/v1/admin/me/password').set(client.headers).send({}), 403, 'FORBIDDEN_ROLE');
    });
  });

  describe('sessions', () => {
    it('lists my live sessions with the current one flagged, and revokes one', async () => {
      const me = await admin();
      const other = await tokenFor(t, me.user);
      const res = await request(t.http).get('/api/v1/admin/me/sessions').set(me.headers).expect(200);
      expect(res.body.data).toHaveLength(2);
      expect(Object.keys(res.body.data[0]).sort()).toEqual(['createdAt', 'current', 'deviceLabel', 'id', 'ip', 'lastUsedAt', 'userAgent']);
      expect(res.body.data.find((s: { id: string }) => s.id === me.session.id).current).toBe(true);
      expect(res.body.data.find((s: { id: string }) => s.id === other.session.id).current).toBe(false);

      await request(t.http).delete(`/api/v1/admin/me/sessions/${other.session.id}`).set(me.headers).expect(204);
      expectError(await request(t.http).get('/api/v1/admin/me').set(other.headers), 401, 'AUTH_SESSION_REVOKED');
      expect(await audited('account.session_revoked', other.session.id)).toBe(true);
      expectError(await request(t.http).delete(`/api/v1/admin/me/sessions/${other.session.id}`).set(me.headers), 404, 'SESSION_NOT_FOUND');
    });

    it('404 SESSION_NOT_FOUND for someone else\'s or a malformed id; 401; 403', async () => {
      const me = await admin();
      const stranger = await admin();
      expectError(await request(t.http).delete(`/api/v1/admin/me/sessions/${stranger.session.id}`).set(me.headers), 404, 'SESSION_NOT_FOUND');
      expectError(await request(t.http).delete('/api/v1/admin/me/sessions/abc').set(me.headers), 404, 'SESSION_NOT_FOUND');
      expectError(await request(t.http).get('/api/v1/admin/me/sessions'), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).get('/api/v1/admin/me/sessions').set(client.headers), 403, 'FORBIDDEN_ROLE');
    });
  });

  describe('GET /admin/admins', () => {
    it('lists admins and pending invitations with pagination, filters, search and sort', async () => {
      const me = await admin({ fullName: `Zz Lister ${uid()}` });
      const tag = uid();
      const invited = await t.dataSource.getRepository(AdminInvitation).save({
        email: `list.${tag}@eventor.dz`,
        fullName: `Invitee ${tag}`,
        tokenHash: uid(32),
        invitedById: me.user.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      const all = await request(t.http).get('/api/v1/admin/admins?limit=100').set(me.headers).expect(200);
      expect(all.body.meta).toMatchObject({ page: 1, limit: 100, total: expect.any(Number) });
      const mine = all.body.data.find((r: { id: string }) => r.id === me.user.id);
      expect(mine).toMatchObject({ status: 'active', isCurrentUser: true, invitationId: null, invitedAt: null, expiresAt: null });
      expect(Object.keys(mine).sort()).toEqual(['email', 'expiresAt', 'fullName', 'id', 'invitationId', 'invitedAt', 'isCurrentUser', 'lastActiveAt', 'status']);
      expect(all.body.data.find((r: { id: string }) => r.id === invited.id)).toMatchObject({ status: 'invited', invitationId: invited.id, isCurrentUser: false });

      const search = await request(t.http).get(`/api/v1/admin/admins?q=${tag}`).set(me.headers).expect(200);
      expect(search.body.data.map((r: { id: string }) => r.id)).toEqual([invited.id]);

      const invitedOnly = await request(t.http).get('/api/v1/admin/admins?status=invited&limit=100').set(me.headers).expect(200);
      expect(invitedOnly.body.data.every((r: { status: string }) => r.status === 'invited')).toBe(true);

      const page = await request(t.http).get('/api/v1/admin/admins?limit=1&page=2&sort=fullName:asc').set(me.headers).expect(200);
      expect(page.body.data).toHaveLength(1);
      expect(page.body.meta.totalPages).toBe(page.body.meta.total);

      const sorted = await request(t.http).get('/api/v1/admin/admins?limit=100&sort=fullName:asc').set(me.headers).expect(200);
      const names = sorted.body.data.map((r: { fullName: string }) => r.fullName);
      expect(names).toEqual([...names].sort((a: string, b: string) => a.localeCompare(b)));
    });

    it('400 for a bad filter or sort, 401, 403', async () => {
      const me = await admin();
      expectError(await request(t.http).get('/api/v1/admin/admins?status=blocked').set(me.headers), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).get('/api/v1/admin/admins?sort=passwordHash:asc').set(me.headers), 400, 'SORT_FIELD_NOT_ALLOWED');
      expectError(await request(t.http).get('/api/v1/admin/admins'), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).get('/api/v1/admin/admins').set(client.headers), 403, 'FORBIDDEN_ROLE');
    });
  });

  describe('invitations', () => {
    const invite = (me: LoggedIn, body: Record<string, unknown>) =>
      request(t.http).post('/api/v1/admin/admins/invitations').set(me.headers).send(body);

    it('creates an invitation (72 h), emails it and audits it', async () => {
      const me = await admin();
      const email = `karim.${uid()}@eventor.dz`;
      const res = await invite(me, { fullName: 'Karim Benali', email }).expect(201);
      expect(res.body.data).toMatchObject({ fullName: 'Karim Benali', email, status: 'invited', invitationId: res.body.data.id });
      const hours = (new Date(res.body.data.expiresAt).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(71.9);
      expect(hours).toBeLessThanOrEqual(72);

      const mail = [...t.get(MailService).outbox].reverse().find((m) => m.to === email);
      expect(mail?.text).toMatch(/http:\/\/localhost:3001\/en\/accept-invitation\?token=/);
      const token = /token=([^\s]+)/.exec(mail!.text)![1]!;
      await request(t.http).get(`/api/v1/admin/auth/invitations/${token}`).expect(200);
      expect(await audited('admin.invited', res.body.data.id)).toBe(true);
    });

    it('409 EMAIL_TAKEN, 409 INVITATION_EXISTS, 400, 401, 403', async () => {
      const me = await admin();
      expectError(await invite(me, { fullName: 'Taken', email: me.user.email }), 409, 'EMAIL_TAKEN');
      const email = `dup.${uid()}@eventor.dz`;
      await invite(me, { fullName: 'First', email }).expect(201);
      expectError(await invite(me, { fullName: 'Second', email }), 409, 'INVITATION_EXISTS');
      const bad = await invite(me, { email: 'not-an-email', extra: true });
      expectError(bad, 400, 'VALIDATION_FAILED');
      expect((bad.body.details as { field: string }[]).map((d) => d.field)).toEqual(expect.arrayContaining(['fullName', 'email', 'extra']));
      expectError(await request(t.http).post('/api/v1/admin/admins/invitations').send({}), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await invite(client, { fullName: 'X', email }), 403, 'FORBIDDEN_ROLE');
    });

    it('resends with a new token (old link dies) and revokes', async () => {
      const me = await admin();
      const email = `resend.${uid()}@eventor.dz`;
      const created = await invite(me, { fullName: 'Resend Me', email }).expect(201);
      const id = created.body.data.id as string;
      const oldToken = /token=([^\s]+)/.exec([...t.get(MailService).outbox].reverse().find((m) => m.to === email)!.text)![1]!;

      const res = await request(t.http).post(`/api/v1/admin/admins/invitations/${id}/resend`).set(me.headers).expect(200);
      expect(res.body.data).toMatchObject({ id, status: 'invited' });
      expectError(await request(t.http).get(`/api/v1/admin/auth/invitations/${oldToken}`), 404, 'INVITATION_INVALID');
      expect(await audited('admin.invitation_resent', id)).toBe(true);

      await request(t.http).post(`/api/v1/admin/admins/invitations/${id}/revoke`).set(me.headers).expect(204);
      expect(await audited('admin.invitation_revoked', id)).toBe(true);
      expectError(await request(t.http).post(`/api/v1/admin/admins/invitations/${id}/revoke`).set(me.headers), 404, 'INVITATION_NOT_FOUND');
      expectError(await request(t.http).post(`/api/v1/admin/admins/invitations/${id}/resend`).set(me.headers), 404, 'INVITATION_NOT_FOUND');
    });

    it('404 for unknown ids, 401, 403', async () => {
      const me = await admin();
      expectError(await request(t.http).post(`/api/v1/admin/admins/invitations/${MISSING}/resend`).set(me.headers), 404, 'INVITATION_NOT_FOUND');
      expectError(await request(t.http).post('/api/v1/admin/admins/invitations/xyz/revoke').set(me.headers), 404, 'INVITATION_NOT_FOUND');
      expectError(await request(t.http).post(`/api/v1/admin/admins/invitations/${MISSING}/resend`), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).post(`/api/v1/admin/admins/invitations/${MISSING}/revoke`).set(client.headers), 403, 'FORBIDDEN_ROLE');
    });
  });

  describe('my avatar (issues 3 #3)', () => {
    it('uploads my photo, shows it on /admin/me, and removes it', async () => {
      const me = await admin();
      const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#36c' } }).png().toBuffer();

      const up = await request(t.http).post('/api/v1/admin/me/avatar').set(me.headers).attach('file', png, 'me.png');
      expect(up.status).toBe(200);
      expect(up.body.data).toMatchObject({ id: me.user.id, avatarUrl: expect.any(String) });
      expect((await request(t.http).get('/api/v1/admin/me').set(me.headers)).body.data.avatarUrl).toEqual(expect.any(String));
      expect(await audited('admin.avatar_updated', me.user.id)).toBe(true);

      const down = await request(t.http).delete('/api/v1/admin/me/avatar').set(me.headers).expect(200);
      expect(down.body.data.avatarUrl).toBeNull();
      expectError(await request(t.http).post('/api/v1/admin/me/avatar').set(me.headers), 400, 'VALIDATION_FAILED');
    });
  });

  describe('DELETE /admin/admins/:id', () => {
    it('soft-deletes another admin, revokes their sessions and audits it', async () => {
      const me = await admin();
      const other = await admin();
      await request(t.http).delete(`/api/v1/admin/admins/${other.user.id}`).set(me.headers).expect(204);

      const row = await t.dataSource.getRepository(User).findOne({ where: { id: other.user.id }, withDeleted: true });
      expect(row?.deletedAt).not.toBeNull();
      expectError(await request(t.http).get('/api/v1/admin/me').set(other.headers), 401, 'AUTH_SESSION_REVOKED');
      expect(await audited('admin.removed', other.user.id)).toBe(true);
      expectError(await request(t.http).delete(`/api/v1/admin/admins/${other.user.id}`).set(me.headers), 404, 'ADMIN_NOT_FOUND');
    });

    it('lets a removed admin be invited again with the same email', async () => {
      const me = await admin();
      const other = await admin();
      const email = other.user.email;
      await request(t.http).delete(`/api/v1/admin/admins/${other.user.id}`).set(me.headers).expect(204);

      const row = await t.dataSource.getRepository(User).findOne({ where: { id: other.user.id }, withDeleted: true });
      expect(row?.email).toBe(`deleted-${other.user.id}@anonymised.eventor.invalid`);
      const res = await request(t.http).post('/api/v1/admin/admins/invitations').set(me.headers).send({ fullName: 'Back again', email });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ email, status: 'invited' });
    });

    it('409 CANNOT_REMOVE_SELF (Arabic too)', async () => {
      const me = await admin();
      const res = await request(t.http).delete(`/api/v1/admin/admins/${me.user.id}`).set(me.headers).set('Accept-Language', 'ar');
      expectError(res, 409, 'CANNOT_REMOVE_SELF');
      expect(res.body.message).toBe('لا يمكنك حذف حسابك الخاص.');
    });

    it('removes a blocked admin while the actor remains active (LAST_ADMIN counts active admins; policy unit-tested)', async () => {
      const me = await admin();
      const blocked = await makeUser(t.dataSource, { role: UserRole.Admin, status: UserStatus.Blocked });
      await request(t.http).delete(`/api/v1/admin/admins/${blocked.id}`).set(me.headers).expect(204);
    });

    it('404 for a non-admin or unknown id, 401, 403', async () => {
      const me = await admin();
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).delete(`/api/v1/admin/admins/${client.user.id}`).set(me.headers), 404, 'ADMIN_NOT_FOUND');
      expectError(await request(t.http).delete(`/api/v1/admin/admins/${MISSING}`).set(me.headers), 404, 'ADMIN_NOT_FOUND');
      expectError(await request(t.http).delete(`/api/v1/admin/admins/${MISSING}`), 401, 'AUTH_TOKEN_MISSING');
      expectError(await request(t.http).delete(`/api/v1/admin/admins/${MISSING}`).set(client.headers), 403, 'FORBIDDEN_ROLE');
    });
  });
});
