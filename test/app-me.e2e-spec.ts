import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordService } from '../src/auth/password.service.js';
import { Session } from '../src/auth/entities/session.entity.js';
import { Budget } from '../src/bookings/entities/budget.entity.js';
import { BudgetItem } from '../src/bookings/entities/budget-item.entity.js';
import { BookingStatus } from '../src/common/enums/booking.enums.js';
import { DocumentStatus, DocumentType, DocumentRejectReason } from '../src/common/enums/file.enums.js';
import { DevicePlatform } from '../src/common/enums/messaging.enums.js';
import { Language, UserRole, VerificationStatus } from '../src/common/enums/user.enums.js';
import { DeviceToken } from '../src/notifications/entities/device-token.entity.js';
import { Favourite } from '../src/services/entities/favourite.entity.js';
import { User } from '../src/users/entities/user.entity.js';
import { UserDocument } from '../src/verification/entities/user-document.entity.js';
import {
  createApp,
  expectError,
  loginAs,
  makeBooking,
  makeCategory,
  makeNotification,
  makePack,
  makeService,
  makeUser,
  makeUserDocument,
  tokenFor,
  uid,
  type LoggedIn,
  type TestApp,
} from './utils/index.js';

const BASE = '/api/v1/app/me';

let t: TestApp;
let client: LoggedIn;
const db = () => t.dataSource;

/** A published service of a verified provider, covering an open wilaya: the visibility rule in full. */
async function visibleService(overrides: Record<string, unknown> = {}) {
  const service = await makeService(db(), overrides);
  await db().query('INSERT INTO service_wilayas (service_id, wilaya_code, created_at) VALUES (?, 16, NOW(6))', [service.id]);
  return service;
}

beforeAll(async () => {
  t = await createApp();
  client = await loginAs(t, UserRole.Client);
});

afterAll(async () => {
  await t.close();
});

describe('App me (e2e)', () => {
  describe('GET /app/me', () => {
    it('returns the account without any secret', async () => {
      const res = await request(t.http).get(BASE).set(client.headers);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: client.user.id,
        role: UserRole.Client,
        email: client.user.email,
        emailVerified: true,
        provider: null,
      });
      expect(res.body.data.unreadNotifications).toEqual(expect.any(Number));
      expect(res.body.data).not.toHaveProperty('passwordHash');
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
      // Fields are present even when empty (api-standards §4).
      expect(res.body.data).toHaveProperty('wilaya');
      expect(res.body.data).toHaveProperty('avatarUrl');
    });

    it('carries the provider profile for a provider', async () => {
      const provider = await loginAs(t, UserRole.Provider);

      const res = await request(t.http).get(BASE).set(provider.headers);

      expect(res.status).toBe(200);
      expect(res.body.data.provider).toMatchObject({ acceptingBookings: true, ratingCount: 0 });
      expect(res.body.data.provider.businessName).toEqual(expect.any(String));
      expect(res.body.data.provider.category).toMatchObject({ id: expect.any(String) });
    });

    it('localises the category name with Accept-Language', async () => {
      const category = await makeCategory(db(), { nameEn: 'Photography', nameAr: 'التصوير' });
      const provider = await loginAs(t, UserRole.Provider);
      await db().query('UPDATE provider_profiles SET category_id = ? WHERE user_id = ?', [category.id, provider.user.id]);

      const en = await request(t.http).get(BASE).set(provider.headers).set('Accept-Language', 'en');
      const ar = await request(t.http).get(BASE).set(provider.headers).set('Accept-Language', 'ar');

      expect(en.body.data.provider.category.name).toBe('Photography');
      expect(ar.body.data.provider.category.name).toBe('التصوير');
      // Both languages are always available for screens that print the pair.
      expect(ar.body.data.provider.category.nameEn).toBe('Photography');
    });

    it('401 without a token', async () => {
      expectError(await request(t.http).get(BASE), 401, 'AUTH_TOKEN_MISSING');
    });
  });

  describe('PATCH /app/me', () => {
    it('updates the fields it is given and leaves the rest alone', async () => {
      const me = await loginAs(t, UserRole.Client, { fullName: 'Before', language: Language.En });

      const res = await request(t.http).patch(BASE).set(me.headers).send({ fullName: 'Amina Benali', language: 'ar', wilayaCode: 9 });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ fullName: 'Amina Benali', language: 'ar' });
      expect(res.body.data.wilaya).toMatchObject({ code: 9 });
      const saved = await db().getRepository(User).findOneByOrFail({ id: me.user.id });
      expect(saved.email).toBe(me.user.email);
    });

    it('normalises the phone and refuses one already used', async () => {
      const me = await loginAs(t, UserRole.Client);
      const taken = `+2135${String(Date.now()).slice(-8)}`;
      await db().getRepository(User).update((await makeUser(db())).id, { phone: taken });

      const ok = await request(t.http).patch(BASE).set(me.headers).send({ phone: '0551234567' });
      expect(ok.body.data.phone).toBe('+213551234567');

      expectError(await request(t.http).patch(BASE).set(me.headers).send({ phone: taken }), 409, 'PHONE_TAKEN');
    });

    it('400 VALIDATION_FAILED for an out-of-range wilaya, an immutable field or an unknown one', async () => {
      // All 58 official codes are seeded, so an unknown one cannot pass the DTO's range check.
      expectError(await request(t.http).patch(BASE).set(client.headers).send({ wilayaCode: 59 }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).patch(BASE).set(client.headers).send({ role: 'provider' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).patch(BASE).set(client.headers).send({ email: 'new@test.dz' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).patch(BASE).set(client.headers).send({ fullName: '' }), 400, 'VALIDATION_FAILED');
    });

    it('404 FILE_NOT_FOUND for an avatar file that is not mine', async () => {
      expectError(
        await request(t.http).patch(BASE).set(client.headers).send({ avatarFileId: '11111111-1111-4111-8111-111111111111' }),
        404,
        'FILE_NOT_FOUND',
      );
    });
  });

  describe('POST /app/me/password', () => {
    it('changes the password and revokes the other sessions, keeping this one', async () => {
      const passwords = t.get(PasswordService);
      const user = await makeUser(db(), { passwordHash: await passwords.hash('Sunflower42x') });
      const first = await tokenFor(t, user);
      const second = await tokenFor(t, user);

      const res = await request(t.http)
        .post(`${BASE}/password`)
        .set(second.headers)
        .send({ currentPassword: 'Sunflower42x', newPassword: 'Bluebird99z' });

      expect(res.status).toBe(204);
      expect((await db().getRepository(Session).findOneByOrFail({ id: first.session.id })).revokedAt).not.toBeNull();
      expect((await db().getRepository(Session).findOneByOrFail({ id: second.session.id })).revokedAt).toBeNull();
      expect(await passwords.verify((await db().getRepository(User).findOneByOrFail({ id: user.id })).passwordHash, 'Bluebird99z')).toBe(true);
    });

    it('422 CURRENT_PASSWORD_INVALID and 422 PASSWORD_WEAK', async () => {
      const user = await makeUser(db(), { passwordHash: await t.get(PasswordService).hash('Sunflower42x') });
      const me = await tokenFor(t, user);

      expectError(
        await request(t.http).post(`${BASE}/password`).set(me.headers).send({ currentPassword: 'nope', newPassword: 'Bluebird99z' }),
        422,
        'CURRENT_PASSWORD_INVALID',
      );
      expectError(
        await request(t.http).post(`${BASE}/password`).set(me.headers).send({ currentPassword: 'Sunflower42x', newPassword: 'weak' }),
        422,
        'PASSWORD_WEAK',
      );
    });
  });

  describe('DELETE /app/me', () => {
    it('closes the account, revokes the sessions and keeps the row soft-deleted', async () => {
      const user = await makeUser(db(), { passwordHash: await t.get(PasswordService).hash('Sunflower42x') });
      const me = await tokenFor(t, user);

      const res = await request(t.http).delete(BASE).set(me.headers).send({ password: 'Sunflower42x' });

      expect(res.status).toBe(204);
      const row = await db().getRepository(User).findOne({ where: { id: user.id }, withDeleted: true });
      expect(row?.deletedAt).not.toBeNull();
      expect((await db().getRepository(Session).findOneByOrFail({ id: me.session.id })).revokedAt).not.toBeNull();
    });

    it('409 ACCOUNT_HAS_ACTIVE_ITEMS with an upcoming booking, like the admin route', async () => {
      const user = await makeUser(db(), { passwordHash: await t.get(PasswordService).hash('Sunflower42x') });
      const me = await tokenFor(t, user);
      const future = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
      await makeBooking(db(), { clientId: user.id, status: BookingStatus.Accepted, eventDate: future });

      const res = await request(t.http).delete(BASE).set(me.headers).send({ password: 'Sunflower42x' });

      expectError(res, 409, 'ACCOUNT_HAS_ACTIVE_ITEMS');
      expect(res.body.details.upcomingBookings).toBeGreaterThan(0);
      expect((await db().getRepository(User).findOneBy({ id: user.id }))?.deletedAt ?? null).toBeNull();
    });

    it('422 CURRENT_PASSWORD_INVALID without the right password', async () => {
      const user = await makeUser(db(), { passwordHash: await t.get(PasswordService).hash('Sunflower42x') });
      const me = await tokenFor(t, user);

      expectError(await request(t.http).delete(BASE).set(me.headers).send({ password: 'wrong' }), 422, 'CURRENT_PASSWORD_INVALID');
    });
  });

  describe('sessions', () => {
    it('lists my app sessions, flagging the current one, and revokes one', async () => {
      const user = await makeUser(db());
      const a = await tokenFor(t, user);
      const b = await tokenFor(t, user);

      const list = await request(t.http).get(`${BASE}/sessions`).set(b.headers);
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(2);
      expect(list.body.data.find((s: { id: string }) => s.id === b.session.id).current).toBe(true);
      expect(list.body.data.find((s: { id: string }) => s.id === a.session.id).current).toBe(false);

      expect((await request(t.http).delete(`${BASE}/sessions/${a.session.id}`).set(b.headers)).status).toBe(204);
      expect((await db().getRepository(Session).findOneByOrFail({ id: a.session.id })).revokedAt).not.toBeNull();
    });

    it('404 SESSION_NOT_FOUND for somebody else’s session', async () => {
      const other = await loginAs(t, UserRole.Client);

      expectError(await request(t.http).delete(`${BASE}/sessions/${other.session.id}`).set(client.headers), 404, 'SESSION_NOT_FOUND');
      expect((await db().getRepository(Session).findOneByOrFail({ id: other.session.id })).revokedAt).toBeNull();
    });

    it('signs out every other device at once', async () => {
      const user = await makeUser(db());
      await tokenFor(t, user);
      await tokenFor(t, user);
      const current = await tokenFor(t, user);

      const res = await request(t.http).delete(`${BASE}/sessions`).set(current.headers);

      expect(res.body.data.revoked).toBe(2);
      expect((await db().getRepository(Session).findOneByOrFail({ id: current.session.id })).revokedAt).toBeNull();
    });
  });

  describe('provider documents (screens 08a / 08d)', () => {
    it('lists the three required types with their status and reject reason', async () => {
      const provider = await loginAs(t, UserRole.Provider, { verificationStatus: VerificationStatus.Rejected });
      await makeUserDocument(db(), { userId: provider.user.id, type: DocumentType.NationalId, status: DocumentStatus.Approved });
      await makeUserDocument(db(), {
        userId: provider.user.id,
        type: DocumentType.TaxCard,
        status: DocumentStatus.Rejected,
        rejectReason: DocumentRejectReason.NameMismatch,
        rejectNote: 'The name on the NIF card does not match your account name.',
        reviewedAt: new Date(),
      });

      const res = await request(t.http).get(`${BASE}/documents`).set(provider.headers);

      expect(res.status).toBe(200);
      expect(res.body.data.actionNeeded).toBe(true);
      expect(res.body.data.documents).toHaveLength(3);
      const byType = Object.fromEntries(res.body.data.documents.map((d: { type: string }) => [d.type, d]));
      expect(byType.national_id).toMatchObject({ status: 'approved', label: 'National ID card' });
      expect(byType.tax_card).toMatchObject({
        status: 'rejected',
        rejectReason: 'name_mismatch',
        rejectReasonLabel: 'Details do not match the account',
      });
      expect(byType.commercial_register_or_artisan_card).toMatchObject({ status: 'missing', id: null, fileUrl: null });
      expect(res.body.data.progress).toEqual({ approved: 1, rejected: 1, waiting: 0, missing: 1 });
      expect(res.body.data.maxFileSizeMb).toBeGreaterThan(0);
    });

    it('translates the labels with Accept-Language: ar', async () => {
      const provider = await loginAs(t, UserRole.Provider);

      const res = await request(t.http).get(`${BASE}/documents`).set(provider.headers).set('Accept-Language', 'ar');

      expect(res.body.data.documents[0].label).toMatch(/[؀-ۿ]/);
    });

    it('a resubmission becomes the current pending version and moves the account back to pending', async () => {
      const provider = await loginAs(t, UserRole.Provider, { verificationStatus: VerificationStatus.Rejected });
      const rejected = await makeUserDocument(db(), {
        userId: provider.user.id,
        type: DocumentType.TaxCard,
        status: DocumentStatus.Rejected,
        rejectReason: DocumentRejectReason.Unreadable,
      });

      const res = await request(t.http)
        .post(`${BASE}/documents`)
        .set(provider.headers)
        .field('type', DocumentType.TaxCard)
        // A real PDF header, since the type is sniffed from the bytes.
        .attach('file', Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj\n<<>>\nendobj\n', 'binary'), 'nif.pdf');

      expect(res.status).toBe(201);
      const taxCard = res.body.data.documents.find((d: { type: string }) => d.type === DocumentType.TaxCard);
      expect(taxCard).toMatchObject({ status: 'pending', resubmitted: true, rejectReason: null });
      expect(taxCard.fileUrl).toContain('/api/v1/files/');

      const documents = await db().getRepository(UserDocument).findBy({ userId: provider.user.id, type: DocumentType.TaxCard });
      expect(documents).toHaveLength(2);
      expect(documents.find((d) => d.id === rejected.id)!.isCurrent).toBe(false);
      // status-rules §2: the account follows its current documents.
      expect((await db().getRepository(User).findOneByOrFail({ id: provider.user.id })).verificationStatus).toBe(VerificationStatus.Pending);
    });

    it('415 FILE_TYPE_NOT_ALLOWED for an executable pretending to be a PDF', async () => {
      const provider = await loginAs(t, UserRole.Provider);

      const res = await request(t.http)
        .post(`${BASE}/documents`)
        .set(provider.headers)
        .field('type', DocumentType.NationalId)
        .attach('file', Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'binary'), 'id.pdf');

      expectError(res, 415, 'FILE_TYPE_NOT_ALLOWED');
    });

    it('400 VALIDATION_FAILED without a file or with an unknown type', async () => {
      const provider = await loginAs(t, UserRole.Provider);

      expectError(await request(t.http).post(`${BASE}/documents`).set(provider.headers).field('type', DocumentType.NationalId), 400, 'VALIDATION_FAILED');
      expectError(
        await request(t.http).post(`${BASE}/documents`).set(provider.headers).field('type', 'passport').attach('file', Buffer.from('%PDF-1.4\n'), 'a.pdf'),
        400,
        'VALIDATION_FAILED',
      );
    });

    it('422 NOT_A_PROVIDER for a client', async () => {
      expectError(await request(t.http).get(`${BASE}/documents`).set(client.headers), 422, 'NOT_A_PROVIDER');
    });
  });

  describe('device tokens', () => {
    it('registers a token, is idempotent, and moves it between accounts', async () => {
      const token = `fcm-${uid(8)}`;
      const first = await request(t.http).post(`${BASE}/device-tokens`).set(client.headers).send({ token, platform: DevicePlatform.Android });
      expect(first.status).toBe(201);
      expect(first.body.data).toMatchObject({ token, platform: 'android' });

      const again = await request(t.http).post(`${BASE}/device-tokens`).set(client.headers).send({ token, platform: DevicePlatform.Android });
      expect(again.body.data.id).toBe(first.body.data.id);
      expect(await db().getRepository(DeviceToken).countBy({ token })).toBe(1);

      // A shared phone: the same device now belongs to somebody else.
      const other = await loginAs(t, UserRole.Client);
      await request(t.http).post(`${BASE}/device-tokens`).set(other.headers).send({ token, platform: DevicePlatform.Ios });
      expect((await db().getRepository(DeviceToken).findOneByOrFail({ token })).userId).toBe(other.user.id);
    });

    it('removes my token and 404s on one I do not own', async () => {
      const token = `fcm-${uid(8)}`;
      await request(t.http).post(`${BASE}/device-tokens`).set(client.headers).send({ token, platform: DevicePlatform.Web });

      expect((await request(t.http).delete(`${BASE}/device-tokens/${token}`).set(client.headers)).status).toBe(204);
      expectError(await request(t.http).delete(`${BASE}/device-tokens/${token}`).set(client.headers), 404, 'DEVICE_TOKEN_NOT_FOUND');
    });

    it('400 VALIDATION_FAILED for an unknown platform', async () => {
      expectError(
        await request(t.http).post(`${BASE}/device-tokens`).set(client.headers).send({ token: `fcm-${uid(8)}`, platform: 'blackberry' }),
        400,
        'VALIDATION_FAILED',
      );
    });
  });

  describe('notification preferences', () => {
    it('defaults to everything on, then stores what changes', async () => {
      const me = await loginAs(t, UserRole.Client);

      const initial = await request(t.http).get(`${BASE}/notification-preferences`).set(me.headers);
      expect(initial.body.data).toMatchObject({ pushBookings: true, pushMessages: true, pushReviews: true, emailBookings: true });

      const patched = await request(t.http).patch(`${BASE}/notification-preferences`).set(me.headers).send({ pushMessages: false });
      expect(patched.body.data).toMatchObject({ pushMessages: false, pushBookings: true });

      const reread = await request(t.http).get(`${BASE}/notification-preferences`).set(me.headers);
      expect(reread.body.data.pushMessages).toBe(false);
    });

    it('400 VALIDATION_FAILED for a non-boolean or unknown switch', async () => {
      expectError(await request(t.http).patch(`${BASE}/notification-preferences`).set(client.headers).send({ pushMessages: 'no' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).patch(`${BASE}/notification-preferences`).set(client.headers).send({ pushSms: true }), 400, 'VALIDATION_FAILED');
    });
  });

  describe('notifications (screen 16)', () => {
    it('lists mine only, newest first, grouped, with pagination meta', async () => {
      const me = await loginAs(t, UserRole.Client);
      const stranger = await makeUser(db());
      await makeNotification(db(), { userId: stranger.id, title: 'Not yours' });
      for (let i = 0; i < 3; i++) {
        await makeNotification(db(), { userId: me.user.id, type: 'booking.accepted', title: `Booking ${i}` });
      }

      const res = await request(t.http).get(`${BASE}/notifications?page=1&limit=2`).set(me.headers);

      expect(res.status).toBe(200);
      expect(res.body.meta).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data.every((n: { group: string }) => n.group === 'today')).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain('Not yours');
    });

    it('filters unread, counts them and marks them read', async () => {
      const me = await loginAs(t, UserRole.Client);
      const read = await makeNotification(db(), { userId: me.user.id, readAt: new Date() });
      const unread = await makeNotification(db(), { userId: me.user.id, readAt: null });

      const onlyUnread = await request(t.http).get(`${BASE}/notifications?unread=true`).set(me.headers);
      expect(onlyUnread.body.data.map((n: { id: string }) => n.id)).toEqual([unread.id]);

      expect((await request(t.http).get(`${BASE}/notifications/unread-count`).set(me.headers)).body.data).toEqual({ unread: 1 });

      const marked = await request(t.http).post(`${BASE}/notifications/read`).set(me.headers).send({ ids: [unread.id] });
      expect(marked.body.data).toEqual({ marked: 1, unread: 0 });
      // Already-read rows are not touched again.
      expect((await request(t.http).post(`${BASE}/notifications/read`).set(me.headers).send({ ids: [read.id] })).body.data.marked).toBe(0);
    });

    it('marks all read, and never touches another user’s rows', async () => {
      const me = await loginAs(t, UserRole.Client);
      const stranger = await makeUser(db());
      const theirs = await makeNotification(db(), { userId: stranger.id, readAt: null });
      await makeNotification(db(), { userId: me.user.id, readAt: null });
      await makeNotification(db(), { userId: me.user.id, readAt: null });

      const res = await request(t.http).post(`${BASE}/notifications/read`).set(me.headers).send({ all: true });

      expect(res.body.data).toEqual({ marked: 2, unread: 0 });
      const { Notification } = await import('../src/notifications/entities/notification.entity.js');
      expect((await db().getRepository(Notification).findOneByOrFail({ id: theirs.id })).readAt).toBeNull();
    });

    it('cannot mark somebody else’s notification read', async () => {
      const stranger = await makeUser(db());
      const theirs = await makeNotification(db(), { userId: stranger.id, readAt: null });

      const res = await request(t.http).post(`${BASE}/notifications/read`).set(client.headers).send({ ids: [theirs.id] });

      expect(res.body.data.marked).toBe(0);
    });

    it('400 VALIDATION_FAILED without ids or all', async () => {
      expectError(await request(t.http).post(`${BASE}/notifications/read`).set(client.headers).send({}), 400, 'VALIDATION_FAILED');
    });
  });

  describe('favourites (screen 17)', () => {
    it('adds a service, is idempotent, lists it and removes it', async () => {
      const me = await loginAs(t, UserRole.Client);
      const service = await visibleService({ titleEn: 'Wedding photo', titleAr: 'تصوير الزفاف', basePrice: '45000.00' });

      const added = await request(t.http).post(`${BASE}/favourites`).set(me.headers).send({ serviceId: service.id });
      expect(added.status).toBe(201);
      expect(added.body.data).toMatchObject({ kind: 'service', targetId: service.id, title: 'Wedding photo', fromPrice: '45000.00', available: true });

      // Tapping ♥ twice must not blow up.
      const again = await request(t.http).post(`${BASE}/favourites`).set(me.headers).send({ serviceId: service.id });
      expect(again.body.data.id).toBe(added.body.data.id);
      expect(await db().getRepository(Favourite).countBy({ userId: me.user.id, serviceId: service.id })).toBe(1);

      const list = await request(t.http).get(`${BASE}/favourites`).set(me.headers);
      expect(list.body.meta.total).toBe(1);
      expect(list.body.data[0].providerName).toEqual(expect.any(String));

      expect((await request(t.http).delete(`${BASE}/favourites/${added.body.data.id}`).set(me.headers)).status).toBe(204);
      expect((await request(t.http).get(`${BASE}/favourites`).set(me.headers)).body.meta.total).toBe(0);
    });

    it('keeps a favourite whose service stopped being visible, flagged unavailable', async () => {
      const me = await loginAs(t, UserRole.Client);
      const service = await visibleService();
      await request(t.http).post(`${BASE}/favourites`).set(me.headers).send({ serviceId: service.id });
      await db().query("UPDATE services SET status = 'hidden' WHERE id = ?", [service.id]);

      const list = await request(t.http).get(`${BASE}/favourites`).set(me.headers);

      expect(list.body.meta.total).toBe(1);
      expect(list.body.data[0].available).toBe(false);
    });

    it('filters by category and by kind', async () => {
      const me = await loginAs(t, UserRole.Client);
      const category = await makeCategory(db());
      const inCategory = await visibleService({ categoryId: category.id });
      await request(t.http).post(`${BASE}/favourites`).set(me.headers).send({ serviceId: inCategory.id });
      await request(t.http).post(`${BASE}/favourites`).set(me.headers).send({ serviceId: (await visibleService()).id });
      const pack = await makePack(db());
      await request(t.http).post(`${BASE}/favourites`).set(me.headers).send({ packId: pack.id });

      expect((await request(t.http).get(`${BASE}/favourites?categoryId=${category.id}`).set(me.headers)).body.meta.total).toBe(1);
      expect((await request(t.http).get(`${BASE}/favourites?kind=pack`).set(me.headers)).body.meta.total).toBe(1);
      expect((await request(t.http).get(`${BASE}/favourites?kind=service`).set(me.headers)).body.meta.total).toBe(2);
    });

    it('422 FAVOURITE_TARGET_INVALID with both or neither target', async () => {
      const service = await visibleService();
      const pack = await makePack(db());

      expectError(await request(t.http).post(`${BASE}/favourites`).set(client.headers).send({}), 422, 'FAVOURITE_TARGET_INVALID');
      expectError(
        await request(t.http).post(`${BASE}/favourites`).set(client.headers).send({ serviceId: service.id, packId: pack.id }),
        422,
        'FAVOURITE_TARGET_INVALID',
      );
    });

    it('404 for an unknown service, pack or favourite id', async () => {
      const unknown = '11111111-1111-4111-8111-111111111111';
      expectError(await request(t.http).post(`${BASE}/favourites`).set(client.headers).send({ serviceId: unknown }), 404, 'SERVICE_NOT_FOUND');
      expectError(await request(t.http).post(`${BASE}/favourites`).set(client.headers).send({ packId: unknown }), 404, 'PACK_NOT_FOUND');
      expectError(await request(t.http).delete(`${BASE}/favourites/${unknown}`).set(client.headers), 404, 'FAVOURITE_NOT_FOUND');
      expectError(await request(t.http).delete(`${BASE}/favourites/not-a-uuid`).set(client.headers), 404, 'FAVOURITE_NOT_FOUND');
    });

    it('cannot remove somebody else’s favourite', async () => {
      const owner = await loginAs(t, UserRole.Client);
      const service = await visibleService();
      const added = await request(t.http).post(`${BASE}/favourites`).set(owner.headers).send({ serviceId: service.id });

      expectError(await request(t.http).delete(`${BASE}/favourites/${added.body.data.id}`).set(client.headers), 404, 'FAVOURITE_NOT_FOUND');
      expect(await db().getRepository(Favourite).countBy({ id: added.body.data.id })).toBe(1);
    });
  });

  describe('budget (screen 18)', () => {
    it('404 BUDGET_NOT_FOUND before one exists, then PUT creates it', async () => {
      const me = await loginAs(t, UserRole.Client);

      expectError(await request(t.http).get(`${BASE}/budget`).set(me.headers), 404, 'BUDGET_NOT_FOUND');

      const created = await request(t.http)
        .put(`${BASE}/budget`)
        .set(me.headers)
        .send({ title: 'Our wedding', eventDate: '2026-03-14', totalAmount: '400000.00' });

      expect(created.status).toBe(200);
      expect(created.body.data).toMatchObject({
        title: 'Our wedding',
        eventDate: '2026-03-14',
        totalAmount: '400000.00',
        spentTotal: '0.00',
        remaining: '400000.00',
        itemsCount: 0,
        bookedCount: 0,
        items: [],
      });
      // A second PUT updates rather than creating a second budget.
      const updated = await request(t.http).put(`${BASE}/budget`).set(me.headers).send({ title: 'Our big day', totalAmount: '450000.00' });
      expect(updated.body.data.id).toBe(created.body.data.id);
      expect(await db().getRepository(Budget).countBy({ clientId: me.user.id })).toBe(1);
    });

    it('adds, edits and deletes lines, recomputing the header each time', async () => {
      const me = await loginAs(t, UserRole.Client);
      await request(t.http).put(`${BASE}/budget`).set(me.headers).send({ title: 'Wedding', totalAmount: '400000.00' });
      const category = await makeCategory(db(), { nameEn: 'Venue', nameAr: 'القاعة' });
      const booking = await makeBooking(db(), { clientId: me.user.id, status: BookingStatus.Accepted });

      const added = await request(t.http)
        .post(`${BASE}/budget/items`)
        .set(me.headers)
        .send({ categoryId: category.id, label: 'Venue', plannedAmount: '120000.00', spentAmount: '110000.00', bookingId: booking.id });

      expect(added.status).toBe(201);
      expect(added.body.data).toMatchObject({ plannedTotal: '120000.00', spentTotal: '110000.00', remaining: '290000.00', itemsCount: 1, bookedCount: 1 });
      const item = added.body.data.items[0];
      expect(item).toMatchObject({ label: 'Venue', bookingId: booking.id, bookingReference: booking.reference });
      expect(item.providerName).toEqual(expect.any(String));
      expect(item.category.name).toBe('Venue');

      const edited = await request(t.http).patch(`${BASE}/budget/items/${item.id}`).set(me.headers).send({ spentAmount: '130000.00' });
      expect(edited.body.data.spentTotal).toBe('130000.00');
      expect(edited.body.data.remaining).toBe('270000.00');

      const removed = await request(t.http).delete(`${BASE}/budget/items/${item.id}`).set(me.headers);
      expect(removed.body.data).toMatchObject({ itemsCount: 0, spentTotal: '0.00' });
      expect(await db().getRepository(BudgetItem).countBy({ id: item.id })).toBe(0);
    });

    it('localises the line’s category with Accept-Language', async () => {
      const me = await loginAs(t, UserRole.Client);
      await request(t.http).put(`${BASE}/budget`).set(me.headers).send({ title: 'Wedding', totalAmount: '100000.00' });
      const category = await makeCategory(db(), { nameEn: 'Venue', nameAr: 'القاعة' });
      await request(t.http).post(`${BASE}/budget/items`).set(me.headers).send({ categoryId: category.id, label: 'Venue' });

      const ar = await request(t.http).get(`${BASE}/budget`).set(me.headers).set('Accept-Language', 'ar');

      expect(ar.body.data.items[0].category.name).toBe('القاعة');
      expect(ar.body.data.items[0].category.nameEn).toBe('Venue');
    });

    it('404 BOOKING_NOT_FOUND when linking a booking that is not mine', async () => {
      const me = await loginAs(t, UserRole.Client);
      await request(t.http).put(`${BASE}/budget`).set(me.headers).send({ title: 'Wedding', totalAmount: '100000.00' });
      const strangersBooking = await makeBooking(db(), { status: BookingStatus.Accepted });

      expectError(
        await request(t.http).post(`${BASE}/budget/items`).set(me.headers).send({ label: 'Venue', bookingId: strangersBooking.id }),
        404,
        'BOOKING_NOT_FOUND',
      );
    });

    it('404 BUDGET_ITEM_NOT_FOUND for a line of another client’s budget', async () => {
      const owner = await loginAs(t, UserRole.Client);
      await request(t.http).put(`${BASE}/budget`).set(owner.headers).send({ title: 'Wedding', totalAmount: '100000.00' });
      const added = await request(t.http).post(`${BASE}/budget/items`).set(owner.headers).send({ label: 'Venue' });

      const intruder = await loginAs(t, UserRole.Client);
      await request(t.http).put(`${BASE}/budget`).set(intruder.headers).send({ title: 'Other', totalAmount: '1000.00' });

      expectError(await request(t.http).patch(`${BASE}/budget/items/${added.body.data.items[0].id}`).set(intruder.headers).send({ label: 'Hacked' }), 404, 'BUDGET_ITEM_NOT_FOUND');
      expectError(await request(t.http).delete(`${BASE}/budget/items/${added.body.data.items[0].id}`).set(intruder.headers), 404, 'BUDGET_ITEM_NOT_FOUND');
      // Untouched.
      expect((await db().getRepository(BudgetItem).findOneByOrFail({ id: added.body.data.items[0].id })).label).toBe('Venue');
    });

    it('is private: another client sees their own budget, never the owner’s', async () => {
      const owner = await loginAs(t, UserRole.Client);
      await request(t.http).put(`${BASE}/budget`).set(owner.headers).send({ title: 'Secret wedding', totalAmount: '999999.00' });

      const other = await loginAs(t, UserRole.Client);
      const res = await request(t.http).get(`${BASE}/budget`).set(other.headers);

      expectError(res, 404, 'BUDGET_NOT_FOUND');
      expect(JSON.stringify(res.body)).not.toContain('Secret wedding');
    });

    it('is private from admins too: the dashboard has no budget route at all', async () => {
      const owner = await loginAs(t, UserRole.Client);
      await request(t.http).put(`${BASE}/budget`).set(owner.headers).send({ title: 'Secret wedding', totalAmount: '999999.00' });
      const admin = await loginAs(t, UserRole.Admin);

      // The admin's dashboard token cannot even reach the route family.
      expectError(await request(t.http).get(`${BASE}/budget`).set(admin.headers), 403, 'FORBIDDEN_ROLE');
      // ...and no admin endpoint exposes budgets.
      for (const path of ['/api/v1/admin/budgets', `/api/v1/admin/users/${owner.user.id}/budget`]) {
        expect((await request(t.http).get(path).set(admin.headers)).status).toBe(404);
      }
    });

    it('400 VALIDATION_FAILED for a bad amount or date', async () => {
      const me = await loginAs(t, UserRole.Client);

      expectError(await request(t.http).put(`${BASE}/budget`).set(me.headers).send({ title: 'W', totalAmount: 'lots' }), 400, 'VALIDATION_FAILED');
      expectError(
        await request(t.http).put(`${BASE}/budget`).set(me.headers).send({ title: 'W', totalAmount: '100.00', eventDate: '14/03/2026' }),
        400,
        'VALIDATION_FAILED',
      );
      expectError(await request(t.http).put(`${BASE}/budget`).set(me.headers).send({ totalAmount: '100.00' }), 400, 'VALIDATION_FAILED');
    });
  });
});
