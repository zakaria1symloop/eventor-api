import sharp from 'sharp';
import request from 'supertest';
import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { Setting } from '../src/admin/entities/setting.entity.js';
import { Booking } from '../src/bookings/entities/booking.entity.js';
import { Wilaya } from '../src/catalog/entities/wilaya.entity.js';
import { BookingStatus } from '../src/common/enums/booking.enums.js';
import { AvailabilityKind, PackStatus, PriceType, ServiceStatus } from '../src/common/enums/catalog.enums.js';
import { ReportTargetType } from '../src/common/enums/moderation.enums.js';
import { Language, UserRole, UserStatus, VerificationStatus } from '../src/common/enums/user.enums.js';
import { ExportRegistry } from '../src/exports/export-registry.js';
import { MailService } from '../src/mail/mail.service.js';
import { Pack } from '../src/packs/entities/pack.entity.js';
import { PackItem } from '../src/packs/entities/pack-item.entity.js';
import { AvailabilityBlock } from '../src/services/entities/availability-block.entity.js';
import { ServiceExtra } from '../src/services/entities/service-extra.entity.js';
import { Service } from '../src/services/entities/service.entity.js';
import { MAX_FEATURED_SERVICES } from '../src/services/services.policy.js';
import { SettingsService } from '../src/settings/settings.service.js';
import { algiersToday } from '../src/users/users.service.js';
import {
  createApp,
  expectError,
  loginAs,
  makeBooking,
  makeCategory,
  makeFile,
  makePack,
  makeProvider,
  makeReport,
  makeReview,
  makeService,
  makeUser,
  uid,
  type LoggedIn,
  type TestApp,
} from './utils/index.js';

const BASE = '/api/v1/admin/services';
const MISSING = '00000000-0000-4000-8000-000000000000';
const FUTURE = '2030-06-20';

const png = (color = '#c96') => sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).png().toBuffer();

describe('Admin services & availability (e2e)', () => {
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
  const reload = (id: string) => db().getRepository(Service).findOne({ where: { id }, withDeleted: true });

  /** A publishable service: wilayas and one photo row. */
  async function publishable(overrides: Partial<Service> = {}, options: { wilayas?: number[]; photos?: number } = {}) {
    const service = await makeService(db(), overrides as never);
    for (const code of options.wilayas ?? [16]) {
      await db().query('INSERT INTO service_wilayas (service_id, wilaya_code, created_at) VALUES (?, ?, NOW(6))', [service.id, code]);
    }
    for (let i = 0; i < (options.photos ?? 1); i++) {
      const file = await makeFile(db(), { purpose: 'service_photo' as never, isPrivate: false, mimeType: 'image/webp', storagePath: `public/service_photo/test/${uid()}.webp` });
      await db().query('INSERT INTO service_photos (id, created_at, service_id, file_id, position) VALUES (UUID(), NOW(6), ?, ?, ?)', [service.id, file.id, i]);
    }
    return service;
  }

  async function setSetting(key: string, value: unknown) {
    await db().getRepository(Setting).save({ key, value });
    t.get(SettingsService).invalidate();
  }

  // ── list ────────────────────────────────────────────────────

  describe('GET /admin/services', () => {
    let tag: string;
    let categoryId: string;
    let photographer: Awaited<ReturnType<typeof makeProvider>>;
    let pendingProvider: Awaited<ReturnType<typeof makeProvider>>;
    let blockedProvider: Awaited<ReturnType<typeof makeProvider>>;
    let coverage: Service;
    let album: Service;
    let draft: Service;
    let hidden: Service;
    let waiting: Service;
    let blockedOne: Service;

    beforeAll(async () => {
      tag = uid();
      categoryId = (await makeCategory(db(), { nameEn: `Photography ${tag}`, nameAr: 'التصوير' })).id;
      photographer = await makeProvider(db(), { user: { fullName: `Karim ${tag}` }, profile: { businessName: `Studio Lumière ${tag}` } });
      pendingProvider = await makeProvider(db(), { user: { verificationStatus: VerificationStatus.Pending } });
      blockedProvider = await makeProvider(db(), { user: { status: UserStatus.Blocked } });
      const p = photographer.user.id;
      coverage = await publishable({ providerId: p, categoryId, titleEn: `Wedding coverage ${tag}`, titleAr: 'تغطية زفاف', basePrice: '45000.00', avgRating: '4.80', bookingsCount: 142, createdAt: new Date('2026-03-01T10:00:00Z') } as never, { wilayas: [16, 9], photos: 2 });
      album = await publishable({ providerId: p, categoryId, titleEn: `Album ${tag}`, basePrice: '12000.00', priceType: PriceType.PerDay, avgRating: '4.10', bookingsCount: 12, isFeatured: false, createdAt: new Date('2026-05-01T10:00:00Z') } as never, { wilayas: [31] });
      draft = await makeService(db(), { providerId: p, categoryId, titleEn: `Draft ${tag}`, status: ServiceStatus.Draft, basePrice: '30000.00', createdAt: new Date('2026-06-01T10:00:00Z') } as never);
      hidden = await publishable({ providerId: p, categoryId, titleEn: `Hidden ${tag}`, status: ServiceStatus.Hidden, basePrice: '99000.00', createdAt: new Date('2026-07-01T10:00:00Z') } as never);
      waiting = await publishable({ providerId: pendingProvider.user.id, categoryId, titleEn: `Waiting ${tag}`, basePrice: '20000.00', createdAt: new Date('2026-08-01T10:00:00Z') } as never);
      blockedOne = await publishable({ providerId: blockedProvider.user.id, categoryId, titleEn: `Blocked ${tag}`, basePrice: '25000.00', createdAt: new Date('2026-09-01T10:00:00Z') } as never);
      await makeReport(db(), { targetType: ReportTargetType.Service, targetId: album.id });
    });

    const list = (query: Record<string, unknown> = {}) => request(t.http).get(BASE).query({ categoryId, ...query }).set(admin.headers);
    const ids = (res: request.Response) => res.body.data.map((r: any) => r.id);

    it('lists with tab counters, pagination meta and the row shape', async () => {
      const res = await list({ sort: 'createdAt:asc' }).expect(200);
      expect(res.body.meta).toEqual({
        page: 1,
        limit: 20,
        total: 6,
        totalPages: 1,
        counts: { all: 6, published: 4, draft: 1, hidden: 1, waiting_approval: 1, reported: 1 },
      });
      expect(ids(res)).toEqual([coverage.id, album.id, draft.id, hidden.id, waiting.id, blockedOne.id]);
      expect(res.body.data[0]).toEqual({
        id: coverage.id,
        titleEn: `Wedding coverage ${tag}`,
        titleAr: 'تغطية زفاف',
        coverUrl: expect.stringContaining('variant=thumb'),
        category: { id: categoryId, nameEn: `Photography ${tag}`, nameAr: 'التصوير' },
        provider: { id: photographer.user.id, fullName: `Karim ${tag}`, businessName: `Studio Lumière ${tag}`, status: 'active', verificationStatus: 'verified' },
        basePrice: '45000.00',
        priceType: 'per_event',
        rating: 4.8,
        ratingCount: 0,
        bookingsCount: 142,
        status: 'published',
        isFeatured: false,
        visibleInApp: true,
        wilayas: [
          { code: 9, name: expect.any(String), nameAr: expect.any(String) },
          { code: 16, name: 'Alger', nameAr: 'الجزائر' },
        ],
        createdAt: '2026-03-01T10:00:00.000Z',
        updatedAt: expect.any(String),
      });
      const visibility = Object.fromEntries(res.body.data.map((r: any) => [r.id, r.visibleInApp]));
      expect(visibility).toMatchObject({ [draft.id]: false, [hidden.id]: false, [waiting.id]: false, [blockedOne.id]: false });
    });

    it('filters by tab', async () => {
      expect(ids(await list({ tab: 'published', sort: 'createdAt:asc' }))).toEqual([coverage.id, album.id, waiting.id, blockedOne.id]);
      expect(ids(await list({ tab: 'draft' }))).toEqual([draft.id]);
      expect(ids(await list({ tab: 'hidden' }))).toEqual([hidden.id]);
      expect(ids(await list({ tab: 'waiting_approval' }))).toEqual([waiting.id]);
      expect(ids(await list({ tab: 'reported' }))).toEqual([album.id]);
    });

    it('applies each filter', async () => {
      expect(ids(await list({ providerId: pendingProvider.user.id }))).toEqual([waiting.id]);
      expect(ids(await list({ wilaya: [9, 31], sort: 'createdAt:asc' }))).toEqual([coverage.id, album.id]);
      expect(ids(await list({ priceMin: 40000, priceMax: 50000 }))).toEqual([coverage.id]);
      expect(ids(await list({ priceType: 'per_day' }))).toEqual([album.id]);
      expect(ids(await list({ ratingMin: 4.5 }))).toEqual([coverage.id]);
      expect(ids(await list({ ratingMin: 4, ratingMax: 4.5 }))).toEqual([album.id]);
      expect(ids(await list({ status: 'hidden' }))).toEqual([hidden.id]);
      expect(ids(await list({ providerStatus: 'blocked' }))).toEqual([blockedOne.id]);
      expect(ids(await list({ createdFrom: '2026-08-01', createdTo: '2026-08-31' }))).toEqual([waiting.id]);
      await db().getRepository(Service).update(album.id, { isFeatured: true, featuredPosition: 99 });
      try {
        expect(ids(await list({ featured: 'true' }))).toEqual([album.id]);
      } finally {
        await db().getRepository(Service).update(album.id, { isFeatured: false, featuredPosition: null });
      }
    });

    it('searches titles and provider names', async () => {
      expect(ids(await request(t.http).get(BASE).query({ q: `coverage ${tag}` }).set(admin.headers))).toEqual([coverage.id]);
      expect(ids(await list({ q: `Lumière ${tag}`, sort: 'title:asc' }))).toEqual([album.id, draft.id, hidden.id, coverage.id]);
    });

    it('sorts and paginates', async () => {
      expect(ids(await list({ sort: 'price:desc' }))).toEqual([hidden.id, coverage.id, draft.id, blockedOne.id, waiting.id, album.id]);
      expect(ids(await list({ sort: 'bookingsCount:desc' })).slice(0, 2)).toEqual([coverage.id, album.id]);
      expect(ids(await list({ sort: 'rating:desc' }))[0]).toBe(coverage.id);
      const page = await list({ sort: 'createdAt:desc', page: 2, limit: 4 }).expect(200);
      expect(page.body.meta).toMatchObject({ page: 2, limit: 4, total: 6, totalPages: 2 });
      expect(ids(page)).toEqual([album.id, coverage.id]);
    });

    it('400 for a bad filter, sort or unknown parameter; 401 without a token; 403 for a provider', async () => {
      expectError(await list({ tab: 'nope' }), 400, 'VALIDATION_FAILED');
      expectError(await list({ priceMin: 'cheap' }), 400, 'VALIDATION_FAILED');
      expectError(await list({ sort: 'provider:asc' }), 400, 'SORT_FIELD_NOT_ALLOWED');
      expectError(await list({ color: 'red' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).get(BASE), 401, 'AUTH_TOKEN_MISSING');
      const provider = await loginAs(t, UserRole.Provider);
      expectError(await request(t.http).get(BASE).set(provider.headers), 403, 'FORBIDDEN_ROLE');
    });

    it('is registered for exports', () => {
      const definition = t.get(ExportRegistry).get('services');
      expect(definition?.columns.map((c) => c.key)).toContain('visibleInApp');
    });
  });

  // ── detail ──────────────────────────────────────────────────

  describe('GET /admin/services/:id', () => {
    it('returns content, photos, stats, provider card and visibility reasons', async () => {
      const { user } = await makeProvider(db(), { user: { verificationStatus: VerificationStatus.Pending } });
      const service = await publishable({ providerId: user.id, facts: [{ label_en: 'Duration', label_ar: 'المدة', value_en: '10 hours', value_ar: '10 ساعات' }], cancellationPolicyEn: 'Free cancellation up to 30 days.' } as never, { photos: 2 });
      await db().getRepository(ServiceExtra).save({ serviceId: service.id, nameEn: 'Drone', nameAr: 'درون', price: '15000.00', position: 0 });
      await makeBooking(db(), { serviceId: service.id, providerId: user.id, status: BookingStatus.Completed, total: '50000.00' });
      await makeBooking(db(), { serviceId: service.id, providerId: user.id, status: BookingStatus.Pending });
      const reviewed = await makeBooking(db(), { serviceId: service.id, providerId: user.id, status: BookingStatus.Completed, total: '40000.00' });
      await makeReview(db(), { bookingId: reviewed.id, rating: 4 });
      const pack = await makePack(db(), { providerId: user.id, nameEn: 'Pack using it' });
      await db().getRepository(PackItem).insert({ packId: pack.id, serviceId: service.id, position: 0 });

      const res = await request(t.http).get(`${BASE}/${service.id}`).set(admin.headers).expect(200);
      const data = res.body.data;
      expect(data).toMatchObject({
        id: service.id,
        descriptionEn: 'A test service.',
        cancellationPolicyEn: 'Free cancellation up to 30 days.',
        cancellationPolicyAr: null,
        facts: [{ label_en: 'Duration', label_ar: 'المدة', value_en: '10 hours', value_ar: '10 ساعات' }],
        maxEventsPerDay: 1,
        extras: [{ id: expect.any(String), nameEn: 'Drone', nameAr: 'درون', price: '15000.00', position: 0 }],
        wilayaDetails: [{ code: 16, name: 'Alger', nameAr: 'الجزائر', isOpen: true }],
        hidden: null,
        visibleInApp: false,
        visibilityReasons: ['provider_not_verified'],
        publishMissing: [],
        stats: {
          bookings: { pending: 1, accepted: 0, declined: 0, cancelled: 0, completed: 2, total: 3 },
          revenue: '90000.00',
          ratingBreakdown: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 0 },
          favourites: 0,
          packsCount: 1,
          packs: [{ id: pack.id, nameEn: 'Pack using it', nameAr: expect.any(String), status: 'draft', needsAttention: false }],
        },
        providerCard: { id: user.id, status: 'active', verificationStatus: 'pending', servicesCount: 1, packsCount: 1, bookingsCount: 3, completedBookingsCount: 2 },
      });
      expect(data.photos).toHaveLength(2);
      expect(data.photos[0]).toEqual({
        id: expect.any(String),
        fileId: expect.any(String),
        position: 0,
        isCover: true,
        url: expect.stringMatching(/\/files\/.+sig=/),
        thumbUrl: expect.stringContaining('variant=thumb'),
        mediumUrl: expect.stringContaining('variant=medium'),
        width: null,
        height: null,
        processingStatus: 'ready',
        createdAt: expect.any(String),
      });
    });

    it('404 SERVICE_NOT_FOUND for unknown, malformed or deleted ids (Arabic message)', async () => {
      expectError(await request(t.http).get(`${BASE}/${MISSING}`).set(admin.headers), 404, 'SERVICE_NOT_FOUND');
      expectError(await request(t.http).get(`${BASE}/nope`).set(admin.headers), 404, 'SERVICE_NOT_FOUND');
      const deleted = await makeService(db());
      await db().getRepository(Service).softDelete(deleted.id);
      const res = await request(t.http).get(`${BASE}/${deleted.id}`).set(admin.headers).set('Accept-Language', 'ar');
      expectError(res, 404, 'SERVICE_NOT_FOUND');
      expect(res.body.message).toBe('الخدمة غير موجودة.');
    });
  });

  // ── create / update ─────────────────────────────────────────

  describe('POST /admin/services', () => {
    let providerId: string;
    let categoryId: string;
    const body = () => ({
      providerId,
      categoryId,
      titleEn: 'DJ set · 5 hours',
      titleAr: '',
      descriptionEn: 'Sound system and lights included.',
      basePrice: 35000,
      priceType: 'per_event',
      maxEventsPerDay: 2,
      wilayaCodes: [16, 9],
      extras: [{ nameEn: 'Extra hour', nameAr: 'ساعة إضافية', price: '8000' }],
      facts: [{ label_en: 'Duration', label_ar: 'المدة', value_en: '5 hours', value_ar: '5 ساعات' }],
    });

    beforeAll(async () => {
      providerId = (await makeProvider(db())).user.id;
      categoryId = (await makeCategory(db())).id;
    });

    it('creates a draft with wilayas, extras and facts, and audits it', async () => {
      const res = await request(t.http).post(BASE).set(admin.headers).send(body()).expect(201);
      expect(res.body.data).toMatchObject({
        titleEn: 'DJ set · 5 hours',
        titleAr: '',
        basePrice: '35000.00',
        status: 'draft',
        maxEventsPerDay: 2,
        extras: [{ nameEn: 'Extra hour', nameAr: 'ساعة إضافية', price: '8000.00', position: 0 }],
        wilayas: [{ code: 9 }, { code: 16 }],
        visibleInApp: false,
        publishMissing: ['titleAr', 'descriptionAr', 'photos'],
      });
      expect((await reload(res.body.data.id))!.providerId).toBe(providerId);
      expect(await audited('service.created', res.body.data.id)).not.toBeNull();
    });

    it('400 VALIDATION_FAILED for each missing required field, a wrong type and an unknown field', async () => {
      for (const field of ['providerId', 'categoryId', 'titleEn', 'basePrice', 'priceType']) {
        const payload: Record<string, unknown> = body();
        delete payload[field];
        const res = await request(t.http).post(BASE).set(admin.headers).send(payload);
        expectError(res, 400, 'VALIDATION_FAILED');
        expect(res.body.details.map((d: any) => d.field)).toContain(field);
      }
      expectError(await request(t.http).post(BASE).set(admin.headers).send({ ...body(), basePrice: 'cheap' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(BASE).set(admin.headers).send({ ...body(), isFeatured: true }), 400, 'VALIDATION_FAILED');
    });

    it('422 for a non-provider, a hidden category, a closed or unknown wilaya; publish guard on create', async () => {
      const client = await makeUser(db());
      expectError(await request(t.http).post(BASE).set(admin.headers).send({ ...body(), providerId: client.id }), 422, 'NOT_A_PROVIDER');
      const hiddenCategory = await makeCategory(db(), { isVisible: false });
      expectError(await request(t.http).post(BASE).set(admin.headers).send({ ...body(), categoryId: hiddenCategory.id }), 422, 'CATEGORY_HIDDEN');
      expectError(await request(t.http).post(BASE).set(admin.headers).send({ ...body(), categoryId: MISSING }), 422, 'CATEGORY_NOT_FOUND');
      await db().getRepository(Wilaya).update(55, { isOpen: false });
      try {
        const res = await request(t.http).post(BASE).set(admin.headers).send({ ...body(), wilayaCodes: [16, 55] });
        expectError(res, 422, 'WILAYA_CLOSED');
        expect(res.body.details).toEqual({ closed: [55] });
      } finally {
        await db().getRepository(Wilaya).update(55, { isOpen: true });
      }
      const title = `Should not exist ${uid()}`;
      const published = await request(t.http).post(BASE).set(admin.headers).send({ ...body(), titleEn: title, status: 'published' });
      expectError(published, 422, 'SERVICE_PUBLISH_INVALID');
      expect(published.body.details.missing).toEqual(['titleAr', 'descriptionAr', 'photos']);
      expect(await db().getRepository(Service).countBy({ titleEn: title })).toBe(0);
    });

    it('401 without a token', async () => {
      expectError(await request(t.http).post(BASE).send(body()), 401, 'AUTH_TOKEN_MISSING');
    });
  });

  describe('PATCH /admin/services/:id', () => {
    it('saves "Allow several clients at the same time" (allowSimultaneous)', async () => {
      const service = await publishable({ status: ServiceStatus.Draft } as never);
      const fresh = await request(t.http).get(`${BASE}/${service.id}`).set(admin.headers).expect(200);
      expect(fresh.body.data).toMatchObject({ allowSimultaneous: false, concurrentClients: 1 });

      const on = await request(t.http).patch(`${BASE}/${service.id}`).set(admin.headers).send({ allowSimultaneous: true }).expect(200);
      expect(on.body.data).toMatchObject({ allowSimultaneous: true, concurrentClients: null });
      const off = await request(t.http).patch(`${BASE}/${service.id}`).set(admin.headers).send({ allowSimultaneous: false }).expect(200);
      expect(off.body.data).toMatchObject({ allowSimultaneous: false, concurrentClients: 1 });
      // Deprecated number still accepted; the checkbox wins when both are sent.
      const both = await request(t.http).patch(`${BASE}/${service.id}`).set(admin.headers).send({ concurrentClients: 4, allowSimultaneous: true }).expect(200);
      expect(both.body.data).toMatchObject({ allowSimultaneous: true, concurrentClients: null });
    });

    it('saves "Only one booking per day" (onePerDay) and keeps the old number field working', async () => {
      const service = await publishable({ status: ServiceStatus.Draft } as never);
      const off = await request(t.http).patch(`${BASE}/${service.id}`).set(admin.headers).send({ onePerDay: false }).expect(200);
      expect(off.body.data).toMatchObject({ onePerDay: false, maxEventsPerDay: null });
      const on = await request(t.http).patch(`${BASE}/${service.id}`).set(admin.headers).send({ onePerDay: true }).expect(200);
      expect(on.body.data).toMatchObject({ onePerDay: true, maxEventsPerDay: 1 });
      // Deprecated number still accepted; onePerDay wins when both are sent.
      const legacy = await request(t.http).patch(`${BASE}/${service.id}`).set(admin.headers).send({ maxEventsPerDay: 3 }).expect(200);
      expect(legacy.body.data).toMatchObject({ onePerDay: false, maxEventsPerDay: 3 });
      const both = await request(t.http).patch(`${BASE}/${service.id}`).set(admin.headers).send({ maxEventsPerDay: 3, onePerDay: true }).expect(200);
      expect(both.body.data).toMatchObject({ onePerDay: true, maxEventsPerDay: 1 });
    });

    it('saves weekly hours, clients at the same time and the period, and validates them (issues 3 #6–#8)', async () => {
      const service = await publishable({ status: ServiceStatus.Draft } as never);
      const hours = [
        { weekday: 5, startTime: '20:00', endTime: '00:00' },
        { weekday: 6, startTime: '10:00', endTime: '13:00' },
        { weekday: 6, startTime: '18:00', endTime: '02:00' },
      ];
      const res = await request(t.http)
        .patch(`${BASE}/${service.id}`)
        .set(admin.headers)
        .send({ hours, concurrentClients: 3, availableFrom: '2027-03-01', availableUntil: '2027-03-31' })
        .expect(200);
      expect(res.body.data).toMatchObject({ hours, concurrentClients: 3, availableFrom: '2027-03-01', availableUntil: '2027-03-31' });
      expect((await audited('service.updated', service.id))?.changes).toMatchObject({ concurrentClients: { from: 1, to: 3 }, hours: { from: [], to: hours } });

      const overlap = await request(t.http)
        .patch(`${BASE}/${service.id}`)
        .set(admin.headers)
        .send({ hours: [{ weekday: 1, startTime: '10:00', endTime: '14:00' }, { weekday: 1, startTime: '13:00', endTime: '16:00' }] });
      expectError(overlap, 400, 'VALIDATION_FAILED');
      expect(overlap.body.details[0]).toMatchObject({ code: 'OVERLAP' });
      expectError(await request(t.http).patch(`${BASE}/${service.id}`).set(admin.headers).send({ hours: [{ weekday: 8, startTime: '10:00', endTime: '11:00' }] }), 400, 'VALIDATION_FAILED');
      const backwards = await request(t.http).patch(`${BASE}/${service.id}`).set(admin.headers).send({ availableUntil: '2027-02-01' });
      expectError(backwards, 400, 'VALIDATION_FAILED');
      expect(backwards.body.details[0]).toMatchObject({ field: 'availableUntil', code: 'BEFORE_FROM' });

      // An empty set and nulls clear them.
      const cleared = await request(t.http).patch(`${BASE}/${service.id}`).set(admin.headers).send({ hours: [], availableFrom: null, availableUntil: null }).expect(200);
      expect(cleared.body.data).toMatchObject({ hours: [], availableFrom: null, availableUntil: null, concurrentClients: 3 });
    });

    it('updates fields, replaces extras and wilayas, and audits the diff', async () => {
      const service = await publishable({ status: ServiceStatus.Draft } as never);
      await db().getRepository(ServiceExtra).save({ serviceId: service.id, nameEn: 'Old', nameAr: 'قديم', price: '1000.00', position: 0 });
      const res = await request(t.http)
        .patch(`${BASE}/${service.id}`)
        .set(admin.headers)
        .send({ titleEn: 'Menu mariage traditionnel', basePrice: '2500', priceType: 'per_person', wilayaCodes: [31], extras: [{ nameEn: 'Dessert', nameAr: 'تحلية', price: 300 }], maxGuests: 400 })
        .expect(200);
      expect(res.body.data).toMatchObject({ titleEn: 'Menu mariage traditionnel', basePrice: '2500.00', priceType: 'per_person', maxGuests: 400, wilayas: [{ code: 31 }] });
      expect(res.body.data.extras.map((e: any) => e.nameEn)).toEqual(['Dessert']);
      const log = await audited('service.updated', service.id);
      expect(log?.changes).toMatchObject({ titleEn: { to: 'Menu mariage traditionnel' }, basePrice: { from: '45000.00', to: '2500.00' }, wilayaCodes: { from: [16], to: [31] } });
    });

    it('publishes through status with the guard, and refuses moving a service used in packs', async () => {
      const incomplete = await makeService(db(), { status: ServiceStatus.Draft });
      const refused = await request(t.http).patch(`${BASE}/${incomplete.id}`).set(admin.headers).send({ status: 'published' });
      expectError(refused, 422, 'SERVICE_PUBLISH_INVALID');
      expect(refused.body.details.missing).toEqual(['photos', 'wilayas']);

      const ready = await publishable({ status: ServiceStatus.Draft } as never);
      await request(t.http).patch(`${BASE}/${ready.id}`).set(admin.headers).send({ status: 'published' }).expect(200);
      expect((await reload(ready.id))!.status).toBe(ServiceStatus.Published);

      expectError(await request(t.http).patch(`${BASE}/${ready.id}`).set(admin.headers).send({ titleAr: '' }), 422, 'SERVICE_PUBLISH_INVALID');

      const hidden = await publishable({ status: ServiceStatus.Hidden } as never);
      expectError(await request(t.http).patch(`${BASE}/${hidden.id}`).set(admin.headers).send({ status: 'published' }), 409, 'SERVICE_INVALID_TRANSITION');

      const pack = await makePack(db(), { providerId: ready.providerId });
      await db().getRepository(PackItem).insert({ packId: pack.id, serviceId: ready.id, position: 0 });
      const other = await makeProvider(db());
      expectError(await request(t.http).patch(`${BASE}/${ready.id}`).set(admin.headers).send({ providerId: other.user.id }), 409, 'SERVICE_IN_PACKS');
    });

    it('404 and 400', async () => {
      expectError(await request(t.http).patch(`${BASE}/${MISSING}`).set(admin.headers).send({ titleEn: 'x' }), 404, 'SERVICE_NOT_FOUND');
      const service = await makeService(db());
      expectError(await request(t.http).patch(`${BASE}/${service.id}`).set(admin.headers).send({ status: 'hidden' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).patch(`${BASE}/${service.id}`).set(admin.headers).send({ maxEventsPerDay: 'two' }), 400, 'VALIDATION_FAILED');
    });
  });

  // ── photos ──────────────────────────────────────────────────

  describe('photos', () => {
    it('uploads through the pipeline, reorders and removes', async () => {
      const service = await makeService(db(), { status: ServiceStatus.Draft });
      const first = await request(t.http).post(`${BASE}/${service.id}/photos`).set(admin.headers).attach('file', await png('#a33'), 'one.png').expect(201);
      expect(first.body.data).toHaveLength(1);
      const second = await request(t.http).post(`${BASE}/${service.id}/photos`).set(admin.headers).attach('file', await png('#3a3'), 'two.png').expect(201);
      expect(second.body.data.map((p: any) => p.position)).toEqual([0, 1]);
      const [a, b] = second.body.data;
      const [row] = await db().query('SELECT processing_status, mime_type FROM files WHERE id = ?', [a.fileId]);
      expect(row).toEqual({ processing_status: 'ready', mime_type: 'image/webp' });
      expect(await audited('service.photo_added', service.id)).not.toBeNull();

      const ordered = await request(t.http).patch(`${BASE}/${service.id}/photos/order`).set(admin.headers).send({ ids: [b.id, a.id] }).expect(200);
      expect(ordered.body.data.map((p: any) => [p.id, p.isCover])).toEqual([
        [b.id, true],
        [a.id, false],
      ]);
      expectError(await request(t.http).patch(`${BASE}/${service.id}/photos/order`).set(admin.headers).send({ ids: [b.id] }), 422, 'PHOTO_ORDER_INVALID');
      expectError(await request(t.http).patch(`${BASE}/${service.id}/photos/order`).set(admin.headers).send({ ids: ['x'] }), 400, 'VALIDATION_FAILED');

      const removed = await request(t.http).delete(`${BASE}/${service.id}/photos/${b.id}`).set(admin.headers).expect(200);
      expect(removed.body.data.map((p: any) => [p.id, p.position])).toEqual([[a.id, 0]]);
      expectError(await request(t.http).delete(`${BASE}/${service.id}/photos/${b.id}`).set(admin.headers), 404, 'PHOTO_NOT_FOUND');
    });

    it('422 PHOTO_LIMIT_REACHED at max_photos_per_service; 415 for a non-image; 400 without a file', async () => {
      const service = await makeService(db(), { status: ServiceStatus.Draft });
      await setSetting('max_photos_per_service', 1);
      try {
        await request(t.http).post(`${BASE}/${service.id}/photos`).set(admin.headers).attach('file', await png(), 'one.png').expect(201);
        const res = await request(t.http).post(`${BASE}/${service.id}/photos`).set(admin.headers).attach('file', await png(), 'two.png').set('Accept-Language', 'ar');
        expectError(res, 422, 'PHOTO_LIMIT_REACHED');
        expect(res.body.details).toMatchObject({ max: 1 });
        expect(res.body.message).toBe('تم بلوغ الحد الأقصى للصور (1).');
      } finally {
        await setSetting('max_photos_per_service', 12);
      }
      expectError(await request(t.http).post(`${BASE}/${service.id}/photos`).set(admin.headers).attach('file', Buffer.from('hello'), 'x.png'), 415, 'FILE_TYPE_NOT_ALLOWED');
      expectError(await request(t.http).post(`${BASE}/${service.id}/photos`).set(admin.headers), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${BASE}/${MISSING}/photos`).set(admin.headers).attach('file', await png(), 'x.png'), 404, 'SERVICE_NOT_FOUND');
    });

    it('keeps the last photo of a published service', async () => {
      const service = await publishable();
      const photos = await request(t.http).get(`${BASE}/${service.id}`).set(admin.headers);
      const res = await request(t.http).delete(`${BASE}/${service.id}/photos/${photos.body.data.photos[0].id}`).set(admin.headers);
      expectError(res, 422, 'SERVICE_PUBLISH_INVALID');
      expect(res.body.details).toEqual({ missing: ['photos'] });
    });
  });

  // ── actions ─────────────────────────────────────────────────

  describe('status actions', () => {
    it('publish runs the guard and lists what is missing', async () => {
      const draft = await makeService(db(), { status: ServiceStatus.Draft, titleAr: '', descriptionAr: '' });
      const res = await request(t.http).post(`${BASE}/${draft.id}/publish`).set(admin.headers);
      expectError(res, 422, 'SERVICE_PUBLISH_INVALID');
      expect(res.body.details.missing).toEqual(['titleAr', 'descriptionAr', 'photos', 'wilayas']);

      const ready = await publishable({ status: ServiceStatus.Draft } as never);
      const ok = await request(t.http).post(`${BASE}/${ready.id}/publish`).set(admin.headers).expect(200);
      expect(ok.body.data).toMatchObject({ status: 'published', visibleInApp: true, visibilityReasons: [] });
      expect(await audited('service.published', ready.id)).not.toBeNull();
      expectError(await request(t.http).post(`${BASE}/${ready.id}/publish`).set(admin.headers), 409, 'SERVICE_INVALID_TRANSITION');
    });

    it('hide emails the provider, flags packs; show resolves them', async () => {
      const { user } = await makeProvider(db(), { user: { language: Language.Ar } });
      const venue = await publishable({ providerId: user.id, titleEn: 'Grande salle · 150 seats', titleAr: 'القاعة الكبرى' } as never);
      const menu = await publishable({ providerId: user.id } as never);
      const pack = await makePack(db(), { providerId: user.id, status: PackStatus.Published, nameAr: 'باقة' });
      await db().getRepository(PackItem).insert([
        { packId: pack.id, serviceId: venue.id, position: 0 },
        { packId: pack.id, serviceId: menu.id, position: 1 },
      ]);
      await db().getRepository(Service).update(venue.id, { isFeatured: true, featuredPosition: 50 });

      expectError(await request(t.http).post(`${BASE}/${venue.id}/hide`).set(admin.headers).send({ reason: 'misleading_content' }), 400, 'VALIDATION_FAILED');
      const hidden = await request(t.http)
        .post(`${BASE}/${venue.id}/hide`)
        .set(admin.headers)
        .send({ reason: 'misleading_content', message: 'Please use your own photos.', allowResubmit: true })
        .expect(200);
      expect(hidden.body.data).toMatchObject({
        status: 'hidden',
        isFeatured: false,
        visibleInApp: false,
        visibilityReasons: ['not_published'],
        hidden: { reason: 'misleading_content', message: 'Please use your own photos.', allowResubmit: true, hiddenBy: { id: admin.user.id } },
      });
      expect((await db().getRepository(Pack).findOneByOrFail({ id: pack.id })).needsAttention).toBe(true);
      const subjects = t.get(MailService).outbox.filter((m) => m.to === user.email).map((m) => m.subject);
      expect(subjects).toEqual(expect.arrayContaining(['تم إخفاء إحدى خدماتك', 'باقتك تحتاج إلى مراجعة']));
      const log = await audited('service.hidden', venue.id);
      expect(log).toMatchObject({ level: 'sensitive', changes: { packsNeedingAttention: [pack.id] } });
      expectError(await request(t.http).post(`${BASE}/${venue.id}/hide`).set(admin.headers).send({ reason: 'other', allowResubmit: false }), 409, 'SERVICE_INVALID_TRANSITION');

      const shown = await request(t.http).post(`${BASE}/${venue.id}/show`).set(admin.headers).expect(200);
      expect(shown.body.data).toMatchObject({ status: 'published', hidden: null, visibleInApp: true });
      expect((await db().getRepository(Pack).findOneByOrFail({ id: pack.id })).needsAttention).toBe(false);
      expect(lastMailTo(user.email)?.subject).toBe('خدمتك ظاهرة من جديد');
    });

    it('unpublish flags packs; 404 for unknown ids', async () => {
      const { user } = await makeProvider(db());
      const a = await publishable({ providerId: user.id } as never);
      const b = await publishable({ providerId: user.id } as never);
      const pack = await makePack(db(), { providerId: user.id });
      await db().getRepository(PackItem).insert([
        { packId: pack.id, serviceId: a.id, position: 0 },
        { packId: pack.id, serviceId: b.id, position: 1 },
      ]);
      const res = await request(t.http).post(`${BASE}/${a.id}/unpublish`).set(admin.headers).expect(200);
      expect(res.body.data.status).toBe('draft');
      expect((await db().getRepository(Pack).findOneByOrFail({ id: pack.id })).needsAttention).toBe(true);
      expectError(await request(t.http).post(`${BASE}/${a.id}/unpublish`).set(admin.headers), 409, 'SERVICE_INVALID_TRANSITION');
      expectError(await request(t.http).post(`${BASE}/${a.id}/show`).set(admin.headers), 409, 'SERVICE_INVALID_TRANSITION');
      expectError(await request(t.http).post(`${BASE}/${MISSING}/publish`).set(admin.headers), 404, 'SERVICE_NOT_FOUND');
    });

    it(`features published services up to ${MAX_FEATURED_SERVICES} (409 FEATURED_LIMIT), unfeatures and renumbers`, async () => {
      const [{ n }] = await db().query('SELECT COUNT(*) AS n FROM services WHERE is_featured = 1 AND deleted_at IS NULL');
      const created: Service[] = [];
      for (let i = Number(n); i < MAX_FEATURED_SERVICES; i++) created.push(await publishable());
      try {
        for (const service of created) await request(t.http).post(`${BASE}/${service.id}/feature`).set(admin.headers).expect(200);
        const extra = await publishable();
        const res = await request(t.http).post(`${BASE}/${extra.id}/feature`).set(admin.headers);
        expectError(res, 409, 'FEATURED_LIMIT');
        expect(res.body.details).toEqual({ max: MAX_FEATURED_SERVICES });

        const first = created[0]!;
        const again = await request(t.http).post(`${BASE}/${first.id}/feature`).set(admin.headers).expect(200);
        expect(again.body.data.isFeatured).toBe(true);
        const off = await request(t.http).post(`${BASE}/${first.id}/unfeature`).set(admin.headers).expect(200);
        expect(off.body.data).toMatchObject({ isFeatured: false, featuredPosition: null });
        const positions = (await db().query('SELECT featured_position AS p FROM services WHERE is_featured = 1 AND deleted_at IS NULL ORDER BY featured_position')).map((r: any) => Number(r.p));
        expect(positions).toEqual(Array.from({ length: positions.length }, (_, i) => i + 1));
        expect(await audited('service.unfeatured', first.id)).not.toBeNull();

        const draft = await makeService(db(), { status: ServiceStatus.Draft });
        expectError(await request(t.http).post(`${BASE}/${draft.id}/feature`).set(admin.headers), 409, 'SERVICE_INVALID_TRANSITION');
      } finally {
        await db().query('UPDATE services SET is_featured = 0, featured_position = NULL WHERE id IN (?)', [created.map((s) => s.id).concat(MISSING)]);
      }
    });
  });

  // ── delete ──────────────────────────────────────────────────

  describe('DELETE /admin/services/:id', () => {
    it('409 SERVICE_HAS_BOOKINGS with accepted upcoming bookings unless force; cancels pending; flags packs', async () => {
      const { user } = await makeProvider(db());
      const service = await publishable({ providerId: user.id } as never);
      const other = await publishable({ providerId: user.id } as never);
      const accepted = await makeBooking(db(), { serviceId: service.id, providerId: user.id, status: BookingStatus.Accepted, eventDate: FUTURE });
      const pending = await makeBooking(db(), { serviceId: service.id, providerId: user.id, status: BookingStatus.Pending, eventDate: FUTURE });
      await db().getRepository(AvailabilityBlock).save({ providerId: user.id, serviceId: service.id, date: FUTURE, kind: AvailabilityKind.Held, bookingId: pending.id });
      const pack = await makePack(db(), { providerId: user.id, status: PackStatus.Published });
      await db().getRepository(PackItem).insert([
        { packId: pack.id, serviceId: service.id, position: 0 },
        { packId: pack.id, serviceId: other.id, position: 1 },
      ]);

      const refused = await request(t.http).delete(`${BASE}/${service.id}`).set(admin.headers);
      expectError(refused, 409, 'SERVICE_HAS_BOOKINGS');
      expect(refused.body.details).toEqual({ upcomingBookings: 1 });
      expect((await reload(service.id))!.deletedAt).toBeNull();

      const res = await request(t.http).delete(`${BASE}/${service.id}`).query({ force: true }).set(admin.headers).expect(200);
      expect(res.body.data).toEqual({ id: service.id, cancelledBookings: 1, keptUpcomingBookings: 1, packsNeedingAttention: 1 });
      expect((await reload(service.id))!.deletedAt).not.toBeNull();
      expect((await db().getRepository(Booking).findOneByOrFail({ id: pending.id })).status).toBe(BookingStatus.Cancelled);
      expect((await db().getRepository(Booking).findOneByOrFail({ id: accepted.id })).status).toBe(BookingStatus.Accepted);
      expect((await db().getRepository(Pack).findOneByOrFail({ id: pack.id })).needsAttention).toBe(true);
      expect(await audited('service.deleted', service.id)).toMatchObject({ level: 'sensitive' });
      expectError(await request(t.http).delete(`${BASE}/${service.id}`).set(admin.headers), 404, 'SERVICE_NOT_FOUND');
    });

    it('deletes without bookings; past accepted bookings do not block', async () => {
      const service = await publishable();
      await makeBooking(db(), { serviceId: service.id, providerId: service.providerId, status: BookingStatus.Accepted, eventDate: '2025-01-10' });
      const res = await request(t.http).delete(`${BASE}/${service.id}`).set(admin.headers).expect(200);
      expect(res.body.data).toMatchObject({ cancelledBookings: 0, keptUpcomingBookings: 0 });
      expectError(await request(t.http).delete(`${BASE}/${MISSING}`).set(admin.headers), 404, 'SERVICE_NOT_FOUND');
    });
  });

  // ── availability ────────────────────────────────────────────

  describe('availability', () => {
    const month = FUTURE.slice(0, 7);

    it('returns the month grid with blocks and bookings', async () => {
      const { user } = await makeProvider(db());
      const service = await makeService(db(), { providerId: user.id, maxEventsPerDay: 2 });
      await db().getRepository(AvailabilityBlock).save({ providerId: user.id, date: `${month}-03`, kind: AvailabilityKind.Blocked, note: 'Holiday' });
      const booking = await makeBooking(db(), { serviceId: service.id, providerId: user.id, status: BookingStatus.Accepted, eventDate: `${month}-20` });
      const res = await request(t.http).get(`/api/v1/admin/providers/${user.id}/availability`).query({ month }).set(admin.headers).expect(200);
      expect(res.body.data).toMatchObject({ providerId: user.id, month, maxEventsPerDay: 2 });
      expect(res.body.data.days).toHaveLength(30);
      expect(res.body.data.days[2]).toEqual({
        date: `${month}-03`,
        status: 'blocked',
        items: [{ id: expect.any(String), kind: 'blocked', date: `${month}-03`, startTime: null, endTime: null, service: null, booking: null, note: 'Holiday', removable: true }],
      });
      expect(res.body.data.days[19]).toMatchObject({ status: 'booked', items: [{ id: null, kind: 'booked', booking: { id: booking.id, status: 'accepted' }, removable: false }] });
      expect(res.body.data.days[0]).toEqual({ date: `${month}-01`, status: 'free', items: [] });
    });

    it('blocks a time range for one service and removes it', async () => {
      const { user } = await makeProvider(db());
      const service = await makeService(db(), { providerId: user.id });
      const url = `/api/v1/admin/providers/${user.id}/availability/blocks`;
      const res = await request(t.http).post(url).set(admin.headers).send({ date: FUTURE, startTime: '14:00', endTime: '23:00', serviceId: service.id, note: 'Private event' }).expect(201);
      expect(res.body.data).toEqual({
        id: expect.any(String),
        kind: 'blocked',
        date: FUTURE,
        startTime: '14:00',
        endTime: '23:00',
        service: { id: service.id, titleEn: service.titleEn, titleAr: service.titleAr },
        booking: null,
        note: 'Private event',
        removable: true,
      });
      expect(await audited('availability.blocked', res.body.data.id)).not.toBeNull();
      const grid = await request(t.http).get(`/api/v1/admin/providers/${user.id}/availability`).query({ month }).set(admin.headers);
      expect(grid.body.data.days[19]).toMatchObject({ status: 'partial', items: [{ startTime: '14:00', endTime: '23:00' }] });

      await request(t.http).delete(`/api/v1/admin/availability-blocks/${res.body.data.id}`).set(admin.headers).expect(204);
      expect(await db().getRepository(AvailabilityBlock).findOneBy({ id: res.body.data.id })).toBeNull();
      expectError(await request(t.http).delete(`/api/v1/admin/availability-blocks/${res.body.data.id}`).set(admin.headers), 404, 'AVAILABILITY_BLOCK_NOT_FOUND');
    });

    it('validation and business errors', async () => {
      const { user } = await makeProvider(db());
      const url = `/api/v1/admin/providers/${user.id}/availability/blocks`;
      expectError(await request(t.http).post(url).set(admin.headers).send({}), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(url).set(admin.headers).send({ date: FUTURE, startTime: '14:00' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(url).set(admin.headers).send({ date: FUTURE, startTime: '15:00', endTime: '14:00' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(url).set(admin.headers).send({ date: '2025-01-01' }), 422, 'AVAILABILITY_DATE_PAST');
      expectError(await request(t.http).post(url).set(admin.headers).send({ date: algiersToday(), serviceId: (await makeService(db())).id }), 422, 'AVAILABILITY_SERVICE_INVALID');
      const client = await makeUser(db());
      expectError(await request(t.http).post(`/api/v1/admin/providers/${client.id}/availability/blocks`).set(admin.headers).send({ date: FUTURE }), 422, 'NOT_A_PROVIDER');
      expectError(await request(t.http).get(`/api/v1/admin/providers/${MISSING}/availability`).query({ month }).set(admin.headers), 404, 'USER_NOT_FOUND');
      expectError(await request(t.http).get(`/api/v1/admin/providers/${user.id}/availability`).query({ month: '2030-13' }).set(admin.headers), 400, 'VALIDATION_FAILED');

      const booking = await makeBooking(db(), { providerId: user.id, serviceId: (await makeService(db(), { providerId: user.id })).id });
      const held = await db().getRepository(AvailabilityBlock).save({ providerId: user.id, date: FUTURE, kind: AvailabilityKind.Held, bookingId: booking.id });
      expectError(await request(t.http).delete(`/api/v1/admin/availability-blocks/${held.id}`).set(admin.headers), 409, 'AVAILABILITY_BLOCK_NOT_REMOVABLE');
      expectError(await request(t.http).get(`/api/v1/admin/providers/${user.id}/availability`).query({ month }), 401, 'AUTH_TOKEN_MISSING');
    });
  });
});
