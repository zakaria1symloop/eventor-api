import { randomInt } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import request from 'supertest';
import sharp from 'sharp';
import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { VerificationCode } from '../src/auth/entities/verification-code.entity.js';
import { PasswordService } from '../src/auth/password.service.js';
import { Booking } from '../src/bookings/entities/booking.entity.js';
import { BookingStatus } from '../src/common/enums/booking.enums.js';
import { ServiceStatus } from '../src/common/enums/catalog.enums.js';
import { DocumentStatus, DocumentType } from '../src/common/enums/file.enums.js';
import { ParticipantRole } from '../src/common/enums/messaging.enums.js';
import { DisputeStatus, ReportTargetType } from '../src/common/enums/moderation.enums.js';
import { Language, UserRole, UserStatus, VerificationStatus } from '../src/common/enums/user.enums.js';
import { ExportRegistry } from '../src/exports/export-registry.js';
import { MailService } from '../src/mail/mail.service.js';
import { ConversationParticipant } from '../src/messaging/entities/conversation-participant.entity.js';
import { ProviderProfile } from '../src/users/entities/provider-profile.entity.js';
import { ProviderWilaya } from '../src/users/entities/provider-wilaya.entity.js';
import { User } from '../src/users/entities/user.entity.js';
import { UserAccountsService } from '../src/users/user-accounts.service.js';
import {
  createApp,
  expectError,
  loginAs,
  makeBooking,
  makeCategory,
  makeConversation,
  makeDispute,
  makeProvider,
  makeReport,
  makeReview,
  makeService,
  makeSession,
  makeUser,
  makeUserDocument,
  uid,
  type LoggedIn,
  type TestApp,
} from './utils/index.js';

const BASE = '/api/v1/admin/users';
const MISSING = '00000000-0000-4000-8000-000000000000';
const FUTURE = '2030-06-20';
const PAST = '2025-01-10';

const localPhone = () => `05${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
const e164 = (local: string) => `+213${local.slice(1)}`;

describe('Admin users (e2e)', () => {
  let t: TestApp;
  let admin: LoggedIn;

  beforeAll(async () => {
    t = await createApp();
    admin = await loginAs(t, UserRole.Admin);
  });

  afterAll(async () => {
    await t?.close();
  });

  const db = () => t.dataSource;
  const audited = (action: string, objectId: string) => db().getRepository(AuditLog).findOneBy({ action, objectId });
  const lastMailTo = (email: string) => [...t.get(MailService).outbox].reverse().find((m) => m.to === email);
  const reload = (id: string) => db().getRepository(User).findOne({ where: { id }, withDeleted: true });
  const recordEvents = (name: string) => {
    const seen: any[] = [];
    const listener = (payload: unknown) => seen.push(payload);
    t.get(EventEmitter2).on(name, listener);
    return { seen, stop: () => t.get(EventEmitter2).off(name, listener) };
  };

  describe('GET /admin/users', () => {
    let tag: string;
    let amel: User;
    let karim: User;
    let walid: User;
    let mehdi: User;
    let category: string;

    beforeAll(async () => {
      tag = uid();
      category = (await makeCategory(db())).id;
      amel = await makeUser(db(), {
        fullName: `Amel ${tag}`,
        wilayaCode: 31,
        language: Language.Ar,
        phone: e164(localPhone()),
        lastActiveAt: new Date(Date.now() - 2 * 86_400_000),
      });
      karim = (
        await makeProvider(db(), {
          user: { fullName: `Karim ${tag}`, wilayaCode: 16, lastActiveAt: new Date(Date.now() - 40 * 86_400_000) },
          profile: { categoryId: category, avgRating: '4.50', ratingCount: 10, businessName: `Studio Lumiere ${tag}` },
        })
      ).user;
      walid = (await makeProvider(db(), { user: { fullName: `Walid ${tag}`, wilayaCode: 25, verificationStatus: VerificationStatus.Pending } })).user;
      mehdi = await makeUser(db(), { fullName: `Mehdi ${tag}`, status: UserStatus.Blocked, wilayaCode: 16 });
      await makeUser(db(), { fullName: `Admin ${tag}`, role: UserRole.Admin });
      const gone = await makeUser(db(), { fullName: `Gone ${tag}` });
      await db().getRepository(User).softDelete(gone.id);
      await db().query('UPDATE users SET created_at = ? WHERE id = ?', [new Date('2026-01-10T12:00:00Z'), amel.id]);

      const service = await makeService(db(), { providerId: karim.id, categoryId: category });
      await makeBooking(db(), { serviceId: service.id, providerId: karim.id, clientId: amel.id, status: BookingStatus.Completed });
      await makeBooking(db(), { serviceId: service.id, providerId: karim.id, clientId: mehdi.id });
    });

    const list = (query: Record<string, unknown>) => request(t.http).get(BASE).query({ q: tag, ...query }).set(admin.headers);
    const ids = (res: request.Response) => res.body.data.map((u: any) => u.id);

    it('lists clients and providers (no admins, no deleted) with tab counters and the row shape', async () => {
      const res = await list({ sort: 'fullName:asc' }).expect(200);
      expect(res.body.meta).toEqual({
        page: 1,
        limit: 20,
        total: 4,
        totalPages: 1,
        counts: { all: 4, clients: 2, providers: 2, blocked: 1, awaiting_verification: 1 },
      });
      expect(ids(res)).toEqual([amel.id, karim.id, mehdi.id, walid.id]);
      const row = res.body.data[1];
      expect(Object.keys(row).sort()).toEqual(
        [
          'id', 'role', 'fullName', 'email', 'phone', 'avatarUrl', 'status', 'verificationStatus', 'wilaya', 'businessName', 'category',
          'rating', 'ratingCount', 'bookingsCount', 'servicesCount', 'lastActiveAt', 'createdAt',
        ].sort(),
      );
      expect(row).toMatchObject({
        role: 'provider',
        wilaya: { code: 16, name: 'Alger', nameAr: 'الجزائر' },
        businessName: `Studio Lumiere ${tag}`,
        category: { id: category },
        rating: 4.5,
        ratingCount: 10,
        bookingsCount: 2,
        servicesCount: 1,
      });
      expect(res.body.data[0]).toMatchObject({ role: 'client', businessName: null, category: null, rating: null, servicesCount: null, bookingsCount: 1 });
    });

    it('filters by tab; counters ignore the tab', async () => {
      expect(ids(await list({ tab: 'clients' }).expect(200)).sort()).toEqual([amel.id, mehdi.id].sort());
      expect(ids(await list({ tab: 'providers' }).expect(200)).sort()).toEqual([karim.id, walid.id].sort());
      expect(ids(await list({ tab: 'blocked' }).expect(200))).toEqual([mehdi.id]);
      const awaiting = await list({ tab: 'awaiting_verification' }).expect(200);
      expect(ids(awaiting)).toEqual([walid.id]);
      expect(awaiting.body.meta.counts.all).toBe(4);
    });

    it('applies each filter', async () => {
      expect(ids(await list({ role: 'client', status: 'active' }).expect(200))).toEqual([amel.id]);
      expect(ids(await list({ verificationStatus: 'pending' }).expect(200))).toEqual([walid.id]);
      expect(ids(await list({ wilaya: 31 }).expect(200))).toEqual([amel.id]);
      expect(ids(await list({ wilaya: [31, 25] }).expect(200)).sort()).toEqual([amel.id, walid.id].sort());
      expect(ids(await list({ categoryId: category }).expect(200))).toEqual([karim.id]);
      expect(ids(await list({ minRating: 4, maxRating: 5 }).expect(200))).toEqual([karim.id]);
      expect(ids(await list({ joinedFrom: '2026-01-10', joinedTo: '2026-01-10' }).expect(200))).toEqual([amel.id]);
      expect(ids(await list({ minCompletedBookings: 1 }).expect(200)).sort()).toEqual([amel.id, karim.id].sort());
      expect(ids(await list({ maxCompletedBookings: 0, role: 'provider' }).expect(200))).toEqual([walid.id]);
      expect(ids(await list({ lastActive: '7d' }).expect(200))).toEqual([amel.id]);
      expect(ids(await list({ lastActive: '90d' }).expect(200)).sort()).toEqual([amel.id, karim.id].sort());
      expect(ids(await list({ lastActive: 'never' }).expect(200)).sort()).toEqual([walid.id, mehdi.id].sort());
      expect(ids(await list({ language: 'ar' }).expect(200))).toEqual([amel.id]);
    });

    it('sorts, paginates and searches by exact phone, email and business name', async () => {
      expect(ids(await list({ sort: 'bookingsCount:desc', limit: 1 }).expect(200))).toEqual([karim.id]);
      expect(ids(await list({ sort: 'rating:desc', limit: 1 }).expect(200))).toEqual([karim.id]);
      const page2 = await list({ sort: 'fullName:asc', limit: 3, page: 2 }).expect(200);
      expect(ids(page2)).toEqual([walid.id]);
      expect(page2.body.meta).toMatchObject({ total: 4, totalPages: 2, page: 2 });
      expect(ids(await list({ sort: 'lastActiveAt:desc', limit: 1 }).expect(200))).toEqual([amel.id]);

      const localForm = `0${amel.phone!.slice(4)}`;
      expect(ids(await request(t.http).get(BASE).query({ q: localForm }).set(admin.headers).expect(200))).toEqual([amel.id]);
      expect(ids(await request(t.http).get(BASE).query({ q: karim.email.toUpperCase() }).set(admin.headers).expect(200))).toEqual([karim.id]);
      expect(ids(await request(t.http).get(BASE).query({ q: `Lumiere ${tag}` }).set(admin.headers).expect(200))).toEqual([karim.id]);
    });

    it('400 for bad filters, sort and unknown parameters; Arabic message; 401; 403', async () => {
      const bad = await list({ tab: 'admins', wilaya: 99, lastActive: '1y', foo: 1 });
      expectError(bad, 400, 'VALIDATION_FAILED');
      expect(bad.body.details.map((d: any) => d.field)).toEqual(expect.arrayContaining(['tab', 'wilaya', 'lastActive', 'foo']));
      const sort = await list({ sort: 'email:asc' }).set('Accept-Language', 'ar');
      expectError(sort, 400, 'SORT_FIELD_NOT_ALLOWED');
      expect(sort.body.message).toBe('لا يمكن الترتيب حسب "email".');
      expectError(await request(t.http).get(BASE), 401, 'AUTH_TOKEN_MISSING');
      const provider = await loginAs(t, UserRole.Provider);
      expectError(await request(t.http).get(BASE).set(provider.headers), 403, 'FORBIDDEN_ROLE');
    });

    it('registers the users export with the list filters', async () => {
      const definition = t.get(ExportRegistry).get('users')!;
      expect(definition).toBeDefined();
      expect(await definition.count({ q: tag, tab: 'clients' })).toBe(2);
      const rows = await definition.fetch({ q: tag, tab: 'blocked' }, { offset: 0, limit: 10 });
      expect(rows.map((r: any) => r.id)).toEqual([mehdi.id]);
    });
  });

  describe('POST /admin/users', () => {
    it('creates a provider with profile, wilayas, pending verification, audit and a set-password email', async () => {
      const tag = uid();
      const category = await makeCategory(db());
      const phone = localPhone();
      const email = `farid.${tag}@test.eventor.dz`;
      const res = await request(t.http)
        .post(BASE)
        .set(admin.headers)
        .send({
          role: 'provider',
          fullName: ` Farid Ouali ${tag} `,
          email: ` Farid.${tag}@Test.Eventor.dz `,
          phone,
          language: 'ar',
          wilayaCode: 9,
          businessName: 'Salle Yasmine',
          categoryId: category.id,
          wilayaCodes: [9, 16],
        })
        .expect(201);
      expect(res.body.data).toMatchObject({
        role: 'provider',
        fullName: `Farid Ouali ${tag}`,
        email,
        phone: e164(phone),
        status: 'active',
        verificationStatus: 'pending',
        language: 'ar',
        businessName: 'Salle Yasmine',
        provider: { businessName: 'Salle Yasmine', wilayas: [{ code: 9 }, { code: 16 }], acceptingBookings: true },
        documents: { verificationStatus: 'pending', progress: { missing: 3 } },
        stats: { bookings: { total: 0 }, services: { total: 0 } },
      });
      const user = (await reload(res.body.data.id))!;
      expect(user.passwordHash).toBeNull();
      expect(await db().getRepository(ProviderWilaya).count({ where: { providerProfileId: (await db().getRepository(ProviderProfile).findOneByOrFail({ userId: user.id })).id } })).toBe(2);
      expect(await audited('user.created', user.id)).not.toBeNull();
      expect(await db().getRepository(VerificationCode).countBy({ userId: user.id })).toBe(1);
      const mail = lastMailTo(email)!;
      expect(mail.subject).toBe('مرحبًا بك في Eventor');
      expect(mail.text).toMatch(/http:\/\/localhost:3001\/set-password\?token=[0-9a-f-]{36}\./);
    });

    it('creates a verified provider with skipVerification and a client with +213 phone', async () => {
      const category = await makeCategory(db());
      const provider = await request(t.http)
        .post(BASE)
        .set(admin.headers)
        .send({ role: 'provider', fullName: 'Samira Belaid', email: `samira.${uid()}@test.eventor.dz`, phone: localPhone(), language: 'en', businessName: "Douceurs d'Oran", categoryId: category.id, skipVerification: true })
        .expect(201);
      expect(provider.body.data.verificationStatus).toBe('verified');

      const phone = e164(localPhone());
      const client = await request(t.http)
        .post(BASE)
        .set(admin.headers)
        .send({ role: 'client', fullName: 'Amel Benamar', email: `amel.${uid()}@test.eventor.dz`, phone, language: 'en' })
        .expect(201);
      expect(client.body.data).toMatchObject({ role: 'client', verificationStatus: 'not_required', phone, provider: null, documents: null, stats: { services: null } });
    });

    it('409 EMAIL_TAKEN (Arabic) and PHONE_TAKEN in another format; 422 for provider fields on a client and an unknown category', async () => {
      const existing = await makeUser(db(), { phone: e164(localPhone()) });
      const body = { role: 'client', fullName: 'Someone', phone: localPhone(), language: 'en' };
      const taken = await request(t.http).post(BASE).set(admin.headers).set('Accept-Language', 'ar').send({ ...body, email: existing.email });
      expectError(taken, 409, 'EMAIL_TAKEN');
      expect(taken.body.message).toBe('هذا البريد الإلكتروني مستخدم في حساب آخر.');
      expectError(
        await request(t.http).post(BASE).set(admin.headers).send({ ...body, email: `x.${uid()}@test.dz`, phone: `0${existing.phone!.slice(4)}` }),
        409,
        'PHONE_TAKEN',
      );
      expectError(
        await request(t.http).post(BASE).set(admin.headers).send({ ...body, email: `y.${uid()}@test.dz`, businessName: 'Nope' }),
        422,
        'NOT_A_PROVIDER',
      );
      expectError(
        await request(t.http).post(BASE).set(admin.headers).send({ ...body, role: 'provider', email: `z.${uid()}@test.dz`, businessName: 'Biz', categoryId: MISSING }),
        422,
        'CATEGORY_NOT_FOUND',
      );
    });

    it('400 for missing fields, bad phone, admin role, provider without business fields and unknown fields; 401/403', async () => {
      const res = await request(t.http).post(BASE).set(admin.headers).send({ role: 'admin', phone: '12345', color: 'red' });
      expectError(res, 400, 'VALIDATION_FAILED');
      expect(res.body.details.map((d: any) => d.field)).toEqual(expect.arrayContaining(['role', 'fullName', 'email', 'phone', 'language', 'color']));
      const provider = await request(t.http).post(BASE).set(admin.headers).send({ role: 'provider', fullName: 'P P', email: `p.${uid()}@t.dz`, phone: localPhone(), language: 'en' });
      expectError(provider, 400, 'VALIDATION_FAILED');
      expect(provider.body.details.map((d: any) => d.field)).toEqual(expect.arrayContaining(['businessName', 'categoryId']));
      expectError(await request(t.http).post(BASE).send({}), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).post(BASE).set(client.headers).send({}), 403, 'FORBIDDEN_ROLE');
    });
  });

  describe('GET /admin/users/:id', () => {
    it('returns the provider profile with stats, documents summary and recent items', async () => {
      const { user: provider } = await makeProvider(db(), { profile: { replyRate: 96, bioEn: 'Photos' } });
      await db().getRepository(ProviderWilaya).insert({ providerProfileId: (await db().getRepository(ProviderProfile).findOneByOrFail({ userId: provider.id })).id, wilayaCode: 16, createdAt: new Date() });
      const service = await makeService(db(), { providerId: provider.id });
      await makeService(db(), { providerId: provider.id, status: ServiceStatus.Hidden });
      const client = await makeUser(db(), { fullName: 'Client Amel' });
      await makeBooking(db(), { serviceId: service.id, providerId: provider.id, clientId: client.id });
      await makeBooking(db(), { serviceId: service.id, providerId: provider.id, clientId: client.id, status: BookingStatus.Accepted, eventDate: FUTURE });
      const done = await makeBooking(db(), { serviceId: service.id, providerId: provider.id, clientId: client.id, status: BookingStatus.Completed, eventDate: PAST, total: '30000.00' });
      await makeBooking(db(), { serviceId: service.id, providerId: provider.id, clientId: client.id, status: BookingStatus.Cancelled });
      const review = await makeReview(db(), { bookingId: done.id, rating: 4 });
      await makeReport(db(), { targetType: ReportTargetType.Review, targetId: review.id });
      const disputed = await makeBooking(db(), { serviceId: service.id, providerId: provider.id, clientId: client.id, status: BookingStatus.Accepted, eventDate: PAST });
      await makeDispute(db(), { bookingId: disputed.id });
      await makeUserDocument(db(), { userId: provider.id, type: DocumentType.NationalId, status: DocumentStatus.Approved });
      await request(t.http).post(`${BASE}/${provider.id}/notes`).set(admin.headers).send({ body: 'First note' }).expect(201);

      const res = await request(t.http).get(`${BASE}/${provider.id}`).set(admin.headers).expect(200);
      const data = res.body.data;
      expect(data.stats).toEqual({
        bookings: { total: 5, pending: 1, upcoming: 1, completed: 1, cancelled: 1 },
        services: { total: 2, published: 1, hidden: 1 },
        packs: { total: 0, published: 0 },
        reviews: { avg: 4, count: 1, reported: 1 },
        disputes: { open: 1, total: 1 },
        earnings: '30000.00',
        replyRate: 96,
      });
      expect(data.provider).toMatchObject({ bioEn: 'Photos', wilayas: [{ code: 16, name: 'Alger' }] });
      expect(data.documents.items).toEqual([
        { type: 'national_id', status: 'approved' },
        { type: 'commercial_register_or_artisan_card', status: 'missing' },
        { type: 'tax_card', status: 'missing' },
      ]);
      expect(data.recent.bookings).toHaveLength(4);
      expect(data.recent.bookings[0]).toMatchObject({ counterpart: { id: client.id, fullName: 'Client Amel' }, title: service.titleEn });
      expect(data.recent.services).toHaveLength(2);
      expect(data.recent.reviews[0]).toMatchObject({ rating: 4, author: { id: client.id } });
      expect(data.recent.notes[0]).toMatchObject({ body: 'First note', author: { id: admin.user.id }, canDelete: true });
      expect(data.block).toBeNull();
    });

    it('404 for unknown, malformed, deleted and admin ids', async () => {
      expectError(await request(t.http).get(`${BASE}/${MISSING}`).set(admin.headers), 404, 'USER_NOT_FOUND');
      expectError(await request(t.http).get(`${BASE}/nope`).set(admin.headers), 404, 'USER_NOT_FOUND');
      const gone = await makeUser(db());
      await db().getRepository(User).softDelete(gone.id);
      expectError(await request(t.http).get(`${BASE}/${gone.id}`).set(admin.headers), 404, 'USER_NOT_FOUND');
      expectError(await request(t.http).get(`${BASE}/${admin.user.id}`).set(admin.headers), 404, 'USER_NOT_FOUND');
    });
  });

  describe('PATCH /admin/users/:id', () => {
    it('updates user and provider fields and audits the diff', async () => {
      const { user } = await makeProvider(db());
      const category = await makeCategory(db());
      const res = await request(t.http)
        .patch(`${BASE}/${user.id}`)
        .set(admin.headers)
        .send({ fullName: 'Karim Belkacem', businessName: 'Studio Lumière', categoryId: category.id, bioAr: 'مصور', wilayaCodes: [31, 16], acceptingBookings: false, languagesSpoken: ['ar', 'fr'], yearsActive: 8 })
        .expect(200);
      expect(res.body.data).toMatchObject({
        fullName: 'Karim Belkacem',
        businessName: 'Studio Lumière',
        category: { id: category.id },
        provider: { bioAr: 'مصور', acceptingBookings: false, languagesSpoken: ['ar', 'fr'], yearsActive: 8, wilayas: [{ code: 16 }, { code: 31 }] },
      });
      const entry = (await audited('user.updated', user.id))!;
      expect(entry.changes).toMatchObject({ fullName: { to: 'Karim Belkacem' }, wilayaCodes: { from: [], to: [16, 31] } });
    });

    it('requires a reason to change email or phone; checks uniqueness; audits as security', async () => {
      const user = await makeUser(db());
      const other = await makeUser(db(), { phone: e164(localPhone()) });
      const noReason = await request(t.http).patch(`${BASE}/${user.id}`).set(admin.headers).send({ email: `new.${uid()}@test.dz` });
      expectError(noReason, 400, 'VALIDATION_FAILED');
      expect(noReason.body.details[0].field).toBe('reason');
      expectError(await request(t.http).patch(`${BASE}/${user.id}`).set(admin.headers).send({ phone: other.phone, reason: 'asked' }), 409, 'PHONE_TAKEN');
      expectError(await request(t.http).patch(`${BASE}/${user.id}`).set(admin.headers).send({ email: other.email, reason: 'asked' }), 409, 'EMAIL_TAKEN');
      const phone = localPhone();
      const ok = await request(t.http).patch(`${BASE}/${user.id}`).set(admin.headers).send({ phone, reason: 'Asked by phone' }).expect(200);
      expect(ok.body.data.phone).toBe(e164(phone));
      const entry = (await audited('user.contact_changed', user.id))!;
      expect(entry).toMatchObject({ level: 'security', note: 'Asked by phone' });
    });

    it('400 ROLE_IMMUTABLE, 422 NOT_A_PROVIDER, 400 validation, 404', async () => {
      const client = await makeUser(db());
      expectError(await request(t.http).patch(`${BASE}/${client.id}`).set(admin.headers).send({ role: 'provider' }), 400, 'ROLE_IMMUTABLE');
      expectError(await request(t.http).patch(`${BASE}/${client.id}`).set(admin.headers).send({ businessName: 'Biz' }), 422, 'NOT_A_PROVIDER');
      expectError(await request(t.http).patch(`${BASE}/${client.id}`).set(admin.headers).send({ phone: '123', wilayaCode: 70, x: 1 }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).patch(`${BASE}/${MISSING}`).set(admin.headers).send({ fullName: 'Xx' }), 404, 'USER_NOT_FOUND');
    });
  });

  describe('block / unblock', () => {
    async function providerWithActivity() {
      const { user: provider } = await makeProvider(db());
      const service = await makeService(db(), { providerId: provider.id });
      await makeService(db(), { providerId: provider.id, status: ServiceStatus.Draft });
      const client = await makeUser(db());
      const pending1 = await makeBooking(db(), { serviceId: service.id, providerId: provider.id, clientId: client.id });
      const pending2 = await makeBooking(db(), { serviceId: service.id, providerId: provider.id, clientId: client.id });
      const accepted = await makeBooking(db(), { serviceId: service.id, providerId: provider.id, clientId: client.id, status: BookingStatus.Accepted, eventDate: FUTURE });
      const conversation = await makeConversation(db());
      await db().getRepository(ConversationParticipant).save({ conversationId: conversation.id, userId: provider.id, role: ParticipantRole.Provider, canWrite: true });
      await makeSession(db(), { userId: provider.id });
      return { provider, pending: [pending1, pending2], accepted };
    }

    it('previews the impact', async () => {
      const { provider } = await providerWithActivity();
      const res = await request(t.http).get(`${BASE}/${provider.id}/block-impact`).set(admin.headers).expect(200);
      expect(res.body.data).toEqual({ servicesCount: 1, packsCount: 0, pendingBookings: 2, upcomingBookings: 1, conversations: 1 });
      expectError(await request(t.http).get(`${BASE}/${MISSING}/block-impact`).set(admin.headers), 404, 'USER_NOT_FOUND');
    });

    it('blocks: sessions revoked, pending bookings cancelled with status rows and events, chats read-only, audit, email', async () => {
      const { provider, pending, accepted } = await providerWithActivity();
      const cancelled = recordEvents('booking.cancelled');
      const until = new Date(Math.floor((Date.now() + 7 * 86_400_000) / 1000) * 1000).toISOString();
      const res = await request(t.http)
        .post(`${BASE}/${provider.id}/block`)
        .set(admin.headers)
        .send({ reason: 'fraud', until, message: 'Blocked after reports.', bookings: 'cancel' })
        .expect(200);
      cancelled.stop();
      expect(res.body.data).toMatchObject({
        user: { id: provider.id, status: 'blocked' },
        impact: { servicesCount: 1, pendingBookings: 2, upcomingBookings: 1, conversations: 1 },
        cancelledBookings: 2,
        sessionsRevoked: 1,
      });
      const bookings = await db().getRepository(Booking).findBy({ providerId: provider.id });
      expect(bookings.filter((b) => b.status === BookingStatus.Cancelled).map((b) => b.id).sort()).toEqual(pending.map((b) => b.id).sort());
      expect(bookings.find((b) => b.id === accepted.id)!.status).toBe(BookingStatus.Accepted);
      const [{ n }] = await db().query("SELECT COUNT(*) AS n FROM booking_status_changes WHERE booking_id IN (?) AND to_status = 'cancelled'", [pending.map((b) => b.id)]);
      expect(Number(n)).toBe(2);
      expect(cancelled.seen.map((e) => e.bookingId).sort()).toEqual(pending.map((b) => b.id).sort());
      expect(Number((await db().query('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL', [provider.id]))[0].n)).toBe(0);
      expect((await db().getRepository(ConversationParticipant).findOneByOrFail({ userId: provider.id })).canWrite).toBe(false);
      expect(await reload(provider.id)).toMatchObject({ status: 'blocked', blockedReason: 'fraud', blockedById: admin.user.id });
      expect((await audited('user.blocked', provider.id))!.level).toBe('sensitive');
      expect(lastMailTo(provider.email)!.subject).toBe('Your account has been blocked');

      const profile = await request(t.http).get(`${BASE}/${provider.id}`).set(admin.headers).expect(200);
      expect(profile.body.data.block).toMatchObject({ reason: 'fraud', message: 'Blocked after reports.', blockedBy: { id: admin.user.id }, until });

      expectError(await request(t.http).post(`${BASE}/${provider.id}/block`).set(admin.headers).send({ reason: 'again', bookings: 'keep' }), 409, 'USER_ALREADY_BLOCKED');

      const unblocked = await request(t.http).post(`${BASE}/${provider.id}/unblock`).set(admin.headers).expect(200);
      expect(unblocked.body.data).toMatchObject({ status: 'active', block: null });
      expect((await db().getRepository(ConversationParticipant).findOneByOrFail({ userId: provider.id })).canWrite).toBe(true);
      expect((await reload(provider.id))!.status).toBe(UserStatus.Active);
      expect(await audited('user.unblocked', provider.id)).not.toBeNull();
      const again = await request(t.http).post(`${BASE}/${provider.id}/unblock`).set(admin.headers).set('Accept-Language', 'ar');
      expectError(again, 409, 'USER_NOT_BLOCKED');
      expect(again.body.message).toBe('هذا الحساب غير محظور.');
    });

    it('keeps pending bookings when asked', async () => {
      const { provider } = await providerWithActivity();
      const res = await request(t.http).post(`${BASE}/${provider.id}/block`).set(admin.headers).send({ reason: 'spam', bookings: 'keep' }).expect(200);
      expect(res.body.data.cancelledBookings).toBe(0);
      expect(await db().getRepository(Booking).countBy({ providerId: provider.id, status: BookingStatus.Pending })).toBe(2);
    });

    it('400 for missing fields and a past until; 404; 401/403', async () => {
      const user = await makeUser(db());
      const res = await request(t.http).post(`${BASE}/${user.id}/block`).set(admin.headers).send({ until: 'tomorrow' });
      expectError(res, 400, 'VALIDATION_FAILED');
      expect(res.body.details.map((d: any) => d.field)).toEqual(expect.arrayContaining(['reason', 'bookings', 'until']));
      const past = await request(t.http).post(`${BASE}/${user.id}/block`).set(admin.headers).send({ reason: 'spam', bookings: 'keep', until: '2020-01-01T00:00:00Z' });
      expectError(past, 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${BASE}/${MISSING}/block`).set(admin.headers).send({ reason: 'spam', bookings: 'keep' }), 404, 'USER_NOT_FOUND');
      expectError(await request(t.http).post(`${BASE}/${MISSING}/unblock`).set(admin.headers), 404, 'USER_NOT_FOUND');
      expectError(await request(t.http).post(`${BASE}/${user.id}/block`), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).post(`${BASE}/${user.id}/block`).set(client.headers), 403, 'FORBIDDEN_ROLE');
    });

    it('the hourly job unblocks accounts whose block period ended', async () => {
      const due = await makeUser(db(), { status: UserStatus.Blocked, blockedAt: new Date(Date.now() - 86_400_000), blockedUntil: new Date(Date.now() - 60_000), blockedReason: 'spam' });
      const later = await makeUser(db(), { status: UserStatus.Blocked, blockedAt: new Date(), blockedUntil: new Date(Date.now() + 86_400_000), blockedReason: 'spam' });
      expect(await t.get(UserAccountsService).autoUnblockExpired()).toBeGreaterThanOrEqual(1);
      expect((await reload(due.id))!.status).toBe(UserStatus.Active);
      expect((await reload(later.id))!.status).toBe(UserStatus.Blocked);
      expect((await audited('user.unblocked', due.id))!).toMatchObject({ actorId: null, source: 'system' });
    });
  });

  describe('avatar (issues 3 #3)', () => {
    const png = () => sharp({ create: { width: 64, height: 48, channels: 3, background: '#c96' } }).png().toBuffer();

    it('replaces a user’s photo, then removes it with a note in the activity log', async () => {
      const user = await makeUser(db());

      const replaced = await request(t.http).post(`${BASE}/${user.id}/avatar`).set(admin.headers).attach('file', await png(), 'me.png');
      expect(replaced.status).toBe(200);
      expect(replaced.body.data.avatarUrl).toEqual(expect.any(String));
      const first = (await reload(user.id))!.avatarFileId;
      expect(first).not.toBeNull();
      expect(await audited('user.avatar_replaced', user.id)).not.toBeNull();

      // A second upload replaces and deletes the previous file.
      await request(t.http).post(`${BASE}/${user.id}/avatar`).set(admin.headers).attach('file', await png(), 'again.png').expect(200);
      const [old] = await db().query('SELECT deleted_at FROM files WHERE id = ?', [first]);
      expect(old.deleted_at).not.toBeNull();

      const removed = await request(t.http).delete(`${BASE}/${user.id}/avatar`).set(admin.headers).send({ note: 'Not a photo of the person' });
      expect(removed.status).toBe(200);
      expect(removed.body.data.avatarUrl).toBeNull();
      expect((await reload(user.id))!.avatarFileId).toBeNull();
      expect(await audited('user.avatar_removed', user.id)).toMatchObject({ note: 'Not a photo of the person' });
    });

    it('400 without a file, 415 for a non-image, 404 for an unknown user or an admin', async () => {
      const user = await makeUser(db());
      expectError(await request(t.http).post(`${BASE}/${user.id}/avatar`).set(admin.headers), 400, 'VALIDATION_FAILED');
      const text = await request(t.http).post(`${BASE}/${user.id}/avatar`).set(admin.headers).attach('file', Buffer.from('not an image'), 'x.png');
      expect(text.status).toBe(415);
      expectError(await request(t.http).post(`${BASE}/${MISSING}/avatar`).set(admin.headers).attach('file', await png(), 'a.png'), 404, 'USER_NOT_FOUND');
      expectError(await request(t.http).delete(`${BASE}/${admin.user.id}/avatar`).set(admin.headers).send({}), 404, 'USER_NOT_FOUND');
    });
  });

  describe('DELETE /admin/users/:id', () => {
    it('422 TYPED_NAME_MISMATCH and 409 ACCOUNT_HAS_ACTIVE_ITEMS for an upcoming booking or an open dispute', async () => {
      const { user: provider } = await makeProvider(db(), { user: { fullName: 'Yacine Meddour' } });
      const service = await makeService(db(), { providerId: provider.id });
      await makeBooking(db(), { serviceId: service.id, providerId: provider.id, status: BookingStatus.Accepted, eventDate: FUTURE });
      expectError(await request(t.http).delete(`${BASE}/${provider.id}`).set(admin.headers).send({ typedName: 'Yacine' }), 422, 'TYPED_NAME_MISMATCH');
      const refused = await request(t.http).delete(`${BASE}/${provider.id}`).set(admin.headers).send({ typedName: 'yacine meddour' });
      expectError(refused, 409, 'ACCOUNT_HAS_ACTIVE_ITEMS');
      expect(refused.body.details).toEqual({ upcomingBookings: 1, openDisputes: 0 });

      const client = await makeUser(db());
      const booking = await makeBooking(db(), { clientId: client.id, status: BookingStatus.Completed, eventDate: PAST });
      await makeDispute(db(), { bookingId: booking.id, status: DisputeStatus.InReview });
      const disputed = await request(t.http).delete(`${BASE}/${client.id}`).set(admin.headers).set('Accept-Language', 'ar').send({ typedName: client.fullName });
      expectError(disputed, 409, 'ACCOUNT_HAS_ACTIVE_ITEMS');
      expect(disputed.body.details).toEqual({ upcomingBookings: 0, openDisputes: 1 });
      expect(disputed.body.message).toContain('نزاع مفتوح');
      expect((await reload(client.id))!.deletedAt).toBeNull();
    });

    it('soft-deletes, cancels pending bookings, revokes sessions; the job anonymises after 30 days', async () => {
      const client = await makeUser(db(), { phone: e164(localPhone()) });
      const pending = await makeBooking(db(), { clientId: client.id });
      await makeSession(db(), { userId: client.id });
      await request(t.http).delete(`${BASE}/${client.id}`).set(admin.headers).send({ typedName: client.fullName }).expect(204);
      expect((await reload(client.id))!.deletedAt).not.toBeNull();
      expect((await db().getRepository(Booking).findOneByOrFail({ id: pending.id })).status).toBe(BookingStatus.Cancelled);
      expect(Number((await db().query('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL', [client.id]))[0].n)).toBe(0);
      expect(await audited('user.deleted', client.id)).not.toBeNull();
      expectError(await request(t.http).get(`${BASE}/${client.id}`).set(admin.headers), 404, 'USER_NOT_FOUND');

      await t.get(UserAccountsService).anonymiseDeleted();
      expect((await reload(client.id))!.anonymisedAt).toBeNull();
      await db().query('UPDATE users SET deleted_at = ? WHERE id = ?', [new Date(Date.now() - 31 * 86_400_000), client.id]);
      expect(await t.get(UserAccountsService).anonymiseDeleted()).toBeGreaterThanOrEqual(1);
      expect(await reload(client.id)).toMatchObject({ fullName: 'Deleted user', phone: null, email: `deleted-${client.id}@anonymised.eventor.invalid` });
      expect((await reload(client.id))!.anonymisedAt).not.toBeNull();
    });

    it('frees the email and phone at once, so the person can be invited as an admin or sign up again', async () => {
      const phone = e164(localPhone());
      const client = await makeUser(db(), { phone });
      await request(t.http).delete(`${BASE}/${client.id}`).set(admin.headers).send({ typedName: client.fullName }).expect(204);

      // Released now, not after the 30-day anonymisation (which still clears the rest).
      expect(await reload(client.id)).toMatchObject({ email: `deleted-${client.id}@anonymised.eventor.invalid`, phone: null, fullName: client.fullName });

      const invited = await request(t.http).post('/api/v1/admin/admins/invitations').set(admin.headers).send({ fullName: 'Back as admin', email: client.email });
      expect(invited.status).toBe(201);
      await request(t.http).post(`/api/v1/admin/admins/invitations/${invited.body.data.invitationId}/revoke`).set(admin.headers).expect(204);

      const again = await request(t.http)
        .post('/api/v1/app/auth/register')
        .send({ role: 'client', fullName: 'Signed up again', email: client.email, phone, password: 'Str0ng-Passw0rd!', language: 'en' });
      expect(again.status).toBe(201);
    });

    it('400 without typedName, 404', async () => {
      const user = await makeUser(db());
      expectError(await request(t.http).delete(`${BASE}/${user.id}`).set(admin.headers).send({}), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).delete(`${BASE}/${MISSING}`).set(admin.headers).send({ typedName: 'x' }), 404, 'USER_NOT_FOUND');
    });
  });

  describe('password reset and sessions', () => {
    it('emails a reset link to the app', async () => {
      const user = await makeUser(db(), { language: Language.En });
      await makeSession(db(), { userId: user.id });
      const res = await request(t.http).post(`${BASE}/${user.id}/password-reset`).set(admin.headers).send({ mode: 'link' }).expect(200);
      expect(res.body.data).toEqual({ mode: 'link', temporaryPassword: null, sessionsRevoked: 0 });
      expect(lastMailTo(user.email)!.text).toMatch(/http:\/\/localhost:3001\/reset-password\?token=/);
      expect(await audited('user.password_reset_link_sent', user.id)).not.toBeNull();
    });

    it('sets a temporary password shown once and signs out everywhere', async () => {
      const user = await makeUser(db());
      await makeSession(db(), { userId: user.id });
      await makeSession(db(), { userId: user.id });
      const res = await request(t.http).post(`${BASE}/${user.id}/password-reset`).set(admin.headers).send({ mode: 'temporary', signOutEverywhere: true }).expect(200);
      expect(res.body.data).toMatchObject({ mode: 'temporary', sessionsRevoked: 2 });
      const stored = (await reload(user.id))!;
      expect(await t.get(PasswordService).verify(stored.passwordHash, res.body.data.temporaryPassword)).toBe(true);
      expect((await audited('user.temporary_password_set', user.id))!.changes).not.toHaveProperty('temporaryPassword');
      expectError(await request(t.http).post(`${BASE}/${user.id}/password-reset`).set(admin.headers).send({ mode: 'sms' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${BASE}/${MISSING}/password-reset`).set(admin.headers).send({ mode: 'link' }), 404, 'USER_NOT_FOUND');
    });

    it('revokes every session', async () => {
      const user = await makeUser(db());
      await makeSession(db(), { userId: user.id });
      const res = await request(t.http).post(`${BASE}/${user.id}/sessions/revoke`).set(admin.headers).expect(200);
      expect(res.body.data).toEqual({ sessionsRevoked: 1 });
      expect(await audited('user.sessions_revoked', user.id)).not.toBeNull();
      expectError(await request(t.http).post(`${BASE}/${MISSING}/sessions/revoke`).set(admin.headers), 404, 'USER_NOT_FOUND');
    });
  });

  describe('POST /admin/users/bulk', () => {
    it('blocks several users and returns per-id results', async () => {
      const a = await makeUser(db());
      const b = await makeUser(db());
      await makeBooking(db(), { clientId: b.id });
      const res = await request(t.http).post(`${BASE}/bulk`).set(admin.headers).send({ action: 'block', ids: [a.id, b.id], reason: 'spam', bookings: 'cancel' }).expect(200);
      expect(res.body.data).toEqual([
        { id: a.id, result: 'ok', cancelledBookings: 0, sessionsRevoked: 0 },
        { id: b.id, result: 'ok', cancelledBookings: 1, sessionsRevoked: 0 },
      ]);
      expect((await reload(a.id))!.status).toBe(UserStatus.Blocked);
      const unblock = await request(t.http).post(`${BASE}/bulk`).set(admin.headers).send({ action: 'unblock', ids: [a.id, b.id] }).expect(200);
      expect(unblock.body.data).toHaveLength(2);
      expect((await reload(b.id))!.status).toBe(UserStatus.Active);
    });

    it('is all-or-nothing: one refusal changes nothing', async () => {
      const active = await makeUser(db());
      const blocked = await makeUser(db(), { status: UserStatus.Blocked });
      const res = await request(t.http).post(`${BASE}/bulk`).set(admin.headers).send({ action: 'block', ids: [active.id, blocked.id, MISSING], reason: 'spam', bookings: 'keep' });
      expectError(res, 409, 'BULK_ACTION_REFUSED');
      expect(res.body.details).toEqual({
        refusedCount: 2,
        refused: [
          { id: blocked.id, code: 'USER_ALREADY_BLOCKED' },
          { id: MISSING, code: 'USER_NOT_FOUND' },
        ],
      });
      expect((await reload(active.id))!.status).toBe(UserStatus.Active);

      const client = await makeUser(db());
      await makeBooking(db(), { clientId: client.id, status: BookingStatus.Accepted, eventDate: FUTURE });
      const other = await makeUser(db());
      const del = await request(t.http).post(`${BASE}/bulk`).set(admin.headers).send({ action: 'delete', ids: [other.id, client.id] });
      expectError(del, 409, 'BULK_ACTION_REFUSED');
      expect(del.body.details.refused).toEqual([{ id: client.id, code: 'ACCOUNT_HAS_ACTIVE_ITEMS', details: { upcomingBookings: 1, openDisputes: 0 } }]);
      expect((await reload(other.id))!.deletedAt).toBeNull();
    });

    it('400 for a block without reason, empty ids or an unknown action', async () => {
      const res = await request(t.http).post(`${BASE}/bulk`).set(admin.headers).send({ action: 'block', ids: [] });
      expectError(res, 400, 'VALIDATION_FAILED');
      expect(res.body.details.map((d: any) => d.field)).toEqual(expect.arrayContaining(['ids', 'reason', 'bookings']));
      expectError(await request(t.http).post(`${BASE}/bulk`).set(admin.headers).send({ action: 'promote', ids: [MISSING] }), 400, 'VALIDATION_FAILED');
    });
  });

  describe('notes', () => {
    it('adds, lists, and deletes notes (author only)', async () => {
      const user = await makeUser(db());
      const first = await request(t.http).post(`${BASE}/${user.id}/notes`).set(admin.headers).send({ body: '  Called the client. ' }).expect(201);
      expect(first.body.data).toMatchObject({ body: 'Called the client.', author: { id: admin.user.id, fullName: admin.user.fullName }, canDelete: true });
      await request(t.http).post(`${BASE}/${user.id}/notes`).set(admin.headers).send({ body: 'Second' }).expect(201);
      const list = await request(t.http).get(`${BASE}/${user.id}/notes`).query({ limit: 1 }).set(admin.headers).expect(200);
      expect(list.body.meta).toMatchObject({ total: 2, totalPages: 2 });

      const otherAdmin = await loginAs(t, UserRole.Admin);
      const other = await request(t.http).get(`${BASE}/${user.id}/notes`).set(otherAdmin.headers).expect(200);
      expect(other.body.data.every((n: any) => n.canDelete === false)).toBe(true);
      expectError(await request(t.http).delete(`${BASE}/${user.id}/notes/${first.body.data.id}`).set(otherAdmin.headers), 403, 'NOT_OWNER');
      await request(t.http).delete(`${BASE}/${user.id}/notes/${first.body.data.id}`).set(admin.headers).expect(204);
      expectError(await request(t.http).delete(`${BASE}/${user.id}/notes/${first.body.data.id}`).set(admin.headers), 404, 'NOTE_NOT_FOUND');
      expect(await audited('user.note_deleted', user.id)).not.toBeNull();
    });

    it('400 for an empty body, 404 for an unknown user', async () => {
      const user = await makeUser(db());
      expectError(await request(t.http).post(`${BASE}/${user.id}/notes`).set(admin.headers).send({ body: '   ' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${BASE}/${MISSING}/notes`).set(admin.headers).send({ body: 'x' }), 404, 'USER_NOT_FOUND');
      expectError(await request(t.http).get(`${BASE}/${MISSING}/notes`).set(admin.headers), 404, 'USER_NOT_FOUND');
    });
  });
});
