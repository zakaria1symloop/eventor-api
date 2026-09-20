import sharp from 'sharp';
import request from 'supertest';
import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { Setting } from '../src/admin/entities/setting.entity.js';
import { Booking } from '../src/bookings/entities/booking.entity.js';
import { Wilaya } from '../src/catalog/entities/wilaya.entity.js';
import { BookingStatus } from '../src/common/enums/booking.enums.js';
import { EventType, PackStatus, ServiceStatus } from '../src/common/enums/catalog.enums.js';
import { UserRole, VerificationStatus } from '../src/common/enums/user.enums.js';
import { ExportRegistry } from '../src/exports/export-registry.js';
import { MailService } from '../src/mail/mail.service.js';
import { PackItem } from '../src/packs/entities/pack-item.entity.js';
import { Pack } from '../src/packs/entities/pack.entity.js';
import { Service } from '../src/services/entities/service.entity.js';
import { SettingsService } from '../src/settings/settings.service.js';
import {
  createApp,
  expectError,
  loginAs,
  makeBooking,
  makeCategory,
  makePack,
  makeProvider,
  makeService,
  makeUser,
  uid,
  type LoggedIn,
  type TestApp,
} from './utils/index.js';

const BASE = '/api/v1/admin/packs';
const MISSING = '00000000-0000-4000-8000-000000000000';
const FUTURE = '2030-06-20';

const png = () => sharp({ create: { width: 40, height: 40, channels: 3, background: '#39c' } }).png().toBuffer();

describe('Admin Ready Packs (e2e)', () => {
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
  const reload = (id: string) => db().getRepository(Pack).findOne({ where: { id }, withDeleted: true });

  /** A verified provider with published services at the given prices. */
  async function providerWithServices(prices: string[], options: { categoryNames?: string[]; verificationStatus?: VerificationStatus } = {}) {
    const { user } = await makeProvider(db(), { user: { verificationStatus: options.verificationStatus ?? VerificationStatus.Verified } });
    const services: Service[] = [];
    for (const [i, price] of prices.entries()) {
      const categoryId = (await makeCategory(db(), options.categoryNames?.[i] ? { nameEn: options.categoryNames[i] } : {})).id;
      services.push(await makeService(db(), { providerId: user.id, basePrice: price, categoryId }));
    }
    return { provider: user, services };
  }

  async function packWith(providerId: string, services: Service[], overrides: Partial<Pack> = {}) {
    const pack = await makePack(db(), { providerId, ...overrides } as never);
    await db().getRepository(PackItem).insert(services.map((s, position) => ({ packId: pack.id, serviceId: s.id, position })));
    return pack;
  }

  // ── list & detail ───────────────────────────────────────────

  describe('GET /admin/packs', () => {
    let tag: string;
    let providerId: string;
    let essentiel: Pack;
    let prestige: Pack;
    let draft: Pack;
    let broken: Pack;

    beforeAll(async () => {
      tag = uid();
      const { provider, services } = await providerWithServices(['250000.00', '120000.00', '55000.00'], { categoryNames: ['Venues', 'Catering', 'Music & DJ'] });
      providerId = provider.id;
      essentiel = await packWith(providerId, services, { nameEn: `Essentiel Mariage ${tag}`, nameAr: 'باقة الزفاف الأساسية', price: '380000.00', status: PackStatus.Published, wilayaCode: 9, createdAt: new Date('2026-04-01T00:00:00Z') } as never);
      prestige = await packWith(providerId, services.slice(0, 2), { nameEn: `Prestige ${tag}`, price: '350000.00', status: PackStatus.Unpublished, eventType: EventType.Engagement, createdAt: new Date('2026-05-01T00:00:00Z') } as never);
      draft = await packWith(providerId, services.slice(1), { nameEn: `Draft ${tag}`, price: '150000.00', createdAt: new Date('2026-06-01T00:00:00Z') } as never);
      broken = await packWith(providerId, services.slice(0, 2), { nameEn: `Broken ${tag}`, price: '300000.00', status: PackStatus.Published, needsAttention: true, createdAt: new Date('2026-07-01T00:00:00Z') } as never);
    });

    const list = (query: Record<string, unknown> = {}) => request(t.http).get(BASE).query({ providerId, ...query }).set(admin.headers);
    const ids = (res: request.Response) => res.body.data.map((r: any) => r.id);

    it('lists with counters and the row shape (pricing, items summary, visibility)', async () => {
      const res = await list({ sort: 'createdAt:asc' }).expect(200);
      expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 4, totalPages: 1, counts: { all: 4, published: 2, draft: 1, unpublished: 1, needs_attention: 1 } });
      expect(ids(res)).toEqual([essentiel.id, prestige.id, draft.id, broken.id]);
      expect(res.body.data[0]).toEqual({
        id: essentiel.id,
        nameEn: `Essentiel Mariage ${tag}`,
        nameAr: 'باقة الزفاف الأساسية',
        coverUrl: null,
        provider: { id: providerId, fullName: expect.any(String), businessName: expect.any(String), status: 'active', verificationStatus: 'verified' },
        itemsCount: 3,
        itemsSummary: [
          { nameEn: 'Venues', nameAr: expect.any(String) },
          { nameEn: 'Catering', nameAr: expect.any(String) },
          { nameEn: 'Music & DJ', nameAr: expect.any(String) },
        ],
        price: '380000.00',
        sumOfItems: '425000.00',
        savings: '45000.00',
        savingsPercent: 10.6,
        eventType: 'wedding',
        wilaya: { code: 9, name: expect.any(String), nameAr: expect.any(String) },
        rating: 0,
        ratingCount: 0,
        bookingsCount: 0,
        status: 'published',
        needsAttention: false,
        visibleInApp: true,
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: expect.any(String),
      });
      expect(res.body.data[3]).toMatchObject({ needsAttention: true, visibleInApp: false });
    });

    it('filters by tab, event type, wilaya, price and q; sorts and paginates', async () => {
      expect(ids(await list({ tab: 'published', sort: 'createdAt:asc' }))).toEqual([essentiel.id, broken.id]);
      expect(ids(await list({ tab: 'draft' }))).toEqual([draft.id]);
      expect(ids(await list({ tab: 'unpublished' }))).toEqual([prestige.id]);
      expect(ids(await list({ tab: 'needs_attention' }))).toEqual([broken.id]);
      expect(ids(await list({ eventType: 'engagement' }))).toEqual([prestige.id]);
      expect(ids(await list({ wilaya: 9 }))).toEqual([essentiel.id]);
      expect(ids(await list({ priceMin: 300000, priceMax: 360000, sort: 'price:asc' }))).toEqual([broken.id, prestige.id]);
      expect(ids(await request(t.http).get(BASE).query({ q: `Essentiel Mariage ${tag}` }).set(admin.headers))).toEqual([essentiel.id]);
      expect(ids(await list({ sort: 'name:asc' }))).toEqual([broken.id, draft.id, essentiel.id, prestige.id]);
      const page = await list({ sort: 'price:desc', limit: 3, page: 2 }).expect(200);
      expect(page.body.meta).toMatchObject({ total: 4, totalPages: 2 });
      expect(ids(page)).toEqual([draft.id]);
    });

    it('400 / 401 / 403', async () => {
      expectError(await list({ tab: 'hidden' }), 400, 'VALIDATION_FAILED');
      expectError(await list({ sort: 'savings:asc' }), 400, 'SORT_FIELD_NOT_ALLOWED');
      expectError(await request(t.http).get(BASE), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).get(BASE).set(client.headers), 403, 'FORBIDDEN_ROLE');
      expect(t.get(ExportRegistry).get('packs')?.columns.map((c) => c.key)).toContain('savings');
    });

    it('GET /:id returns items, attention reasons, checklist and stats', async () => {
      const { provider, services } = await providerWithServices(['100000.00', '50000.00']);
      await db().getRepository(Service).update(services[1]!.id, { status: ServiceStatus.Hidden });
      const pack = await packWith(provider.id, services, { price: '160000.00', nameAr: '' } as never);
      await makeBooking(db(), { packId: pack.id, providerId: provider.id, status: BookingStatus.Completed, total: '160000.00' });

      const res = await request(t.http).get(`${BASE}/${pack.id}`).set(admin.headers).expect(200);
      expect(res.body.data).toMatchObject({
        id: pack.id,
        descriptionEn: null,
        maxGuests: null,
        items: [
          { position: 0, price: '100000.00', availability: 'available', service: { id: services[0]!.id, status: 'published', coverUrl: null } },
          { position: 1, price: '50000.00', availability: 'hidden', service: { id: services[1]!.id, status: 'hidden' } },
        ],
        photos: [],
        attentionReasons: [{ code: 'item_not_published', serviceId: services[1]!.id }],
        publishMissing: ['nameAr', 'unpublishedItems', 'priceNotBelowSum'],
        stats: { bookings: { completed: 1, total: 1 }, revenue: '160000.00' },
        createdBy: { id: provider.id },
      });
      expectError(await request(t.http).get(`${BASE}/${MISSING}`).set(admin.headers), 404, 'PACK_NOT_FOUND');
      expectError(await request(t.http).get(`${BASE}/nope`).set(admin.headers).set('Accept-Language', 'ar'), 404, 'PACK_NOT_FOUND');
    });
  });

  // ── create / update ─────────────────────────────────────────

  describe('POST /admin/packs', () => {
    let providerId: string;
    let services: Service[];
    const body = () => ({ providerId, nameEn: 'Essentiel Mariage', nameAr: 'باقة الزفاف الأساسية', eventType: 'wedding', wilayaCode: 9, price: 380000, serviceIds: services.map((s) => s.id), maxGuests: 150 });

    beforeAll(async () => {
      ({ provider: { id: providerId }, services } = await providerWithServices(['250000.00', '120000.00', '55000.00']));
    });

    it('creates a draft with ordered items and audits it', async () => {
      const res = await request(t.http).post(BASE).set(admin.headers).send(body()).expect(201);
      expect(res.body.data).toMatchObject({ status: 'draft', price: '380000.00', sumOfItems: '425000.00', itemsCount: 3, maxGuests: 150, needsAttention: false, publishMissing: [], createdBy: { id: admin.user.id } });
      expect(res.body.data.items.map((i: any) => i.service.id)).toEqual(services.map((s) => s.id));
      expect(await audited('pack.created', res.body.data.id)).not.toBeNull();
    });

    it('400 for missing fields, item count, duplicates and unknown fields', async () => {
      for (const field of ['providerId', 'nameEn', 'eventType', 'wilayaCode', 'price', 'serviceIds']) {
        const payload: Record<string, unknown> = body();
        delete payload[field];
        const res = await request(t.http).post(BASE).set(admin.headers).send(payload);
        expectError(res, 400, 'VALIDATION_FAILED');
        expect(res.body.details.map((d: any) => d.field)).toContain(field);
      }
      expectError(await request(t.http).post(BASE).set(admin.headers).send({ ...body(), serviceIds: [services[0]!.id] }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(BASE).set(admin.headers).send({ ...body(), serviceIds: Array.from({ length: 7 }, () => services[0]!.id) }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(BASE).set(admin.headers).send({ ...body(), serviceIds: [services[0]!.id, services[0]!.id] }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(BASE).set(admin.headers).send({ ...body(), status: 'published' }), 400, 'VALIDATION_FAILED');
    });

    it('422 PACK_SERVICE_OTHER_PROVIDER, PACK_SERVICE_NOT_FOUND, NOT_A_PROVIDER, WILAYA_CLOSED', async () => {
      const foreign = await makeService(db());
      const res = await request(t.http).post(BASE).set(admin.headers).send({ ...body(), serviceIds: [services[0]!.id, foreign.id] }).set('Accept-Language', 'ar');
      expectError(res, 422, 'PACK_SERVICE_OTHER_PROVIDER');
      expect(res.body.details).toEqual({ serviceIds: [foreign.id], providerId });
      expect(res.body.message).toBe('يجب أن تكون كل خدمات الباقة تابعة لمقدم الخدمة نفسه.');
      expectError(await request(t.http).post(BASE).set(admin.headers).send({ ...body(), serviceIds: [services[0]!.id, MISSING] }), 422, 'PACK_SERVICE_NOT_FOUND');
      expectError(await request(t.http).post(BASE).set(admin.headers).send({ ...body(), providerId: (await makeUser(db())).id }), 422, 'NOT_A_PROVIDER');
      await db().getRepository(Wilaya).update(56, { isOpen: false });
      try {
        expectError(await request(t.http).post(BASE).set(admin.headers).send({ ...body(), wilayaCode: 56 }), 422, 'WILAYA_CLOSED');
      } finally {
        await db().getRepository(Wilaya).update(56, { isOpen: true });
      }
    });
  });

  describe('PATCH /admin/packs/:id', () => {
    it('replaces items, refuses other providers, and re-checks a published pack', async () => {
      const { provider, services } = await providerWithServices(['100000.00', '80000.00', '60000.00']);
      const pack = await packWith(provider.id, services.slice(0, 2), { price: '150000.00', status: PackStatus.Published, nameAr: 'باقة' } as never);

      const res = await request(t.http).patch(`${BASE}/${pack.id}`).set(admin.headers).send({ serviceIds: [services[2]!.id, services[0]!.id], price: '140000.00' }).expect(200);
      expect(res.body.data.items.map((i: any) => i.service.id)).toEqual([services[2]!.id, services[0]!.id]);
      expect(res.body.data).toMatchObject({ price: '140000.00', sumOfItems: '160000.00', savings: '20000.00' });
      expect((await audited('pack.updated', pack.id))?.changes).toMatchObject({ price: { from: '150000.00', to: '140000.00' } });

      expectError(await request(t.http).patch(`${BASE}/${pack.id}`).set(admin.headers).send({ serviceIds: [services[0]!.id, (await makeService(db())).id] }), 422, 'PACK_SERVICE_OTHER_PROVIDER');
      const other = await makeProvider(db());
      expectError(await request(t.http).patch(`${BASE}/${pack.id}`).set(admin.headers).send({ providerId: other.user.id }), 422, 'PACK_SERVICE_OTHER_PROVIDER');
      const guard = await request(t.http).patch(`${BASE}/${pack.id}`).set(admin.headers).send({ price: '160000.00' });
      expectError(guard, 422, 'PACK_PUBLISH_INVALID');
      expect(guard.body.details).toEqual({ missing: ['priceNotBelowSum'] });
      expect((await reload(pack.id))!.price).toBe('140000.00');
      expectError(await request(t.http).patch(`${BASE}/${MISSING}`).set(admin.headers).send({ price: '1' }), 404, 'PACK_NOT_FOUND');
    });
  });

  // ── actions ─────────────────────────────────────────────────

  describe('publish / unpublish / duplicate / delete', () => {
    it('publish guard lists what is missing; publishes; unpublishes', async () => {
      const { provider, services } = await providerWithServices(['100000.00', '80000.00'], { verificationStatus: VerificationStatus.Pending });
      await db().getRepository(Service).update(services[1]!.id, { status: ServiceStatus.Draft });
      const pack = await packWith(provider.id, services, { price: '200000.00', nameAr: '' } as never);
      const refused = await request(t.http).post(`${BASE}/${pack.id}/publish`).set(admin.headers);
      expectError(refused, 422, 'PACK_PUBLISH_INVALID');
      expect(refused.body.details.missing).toEqual(['nameAr', 'unpublishedItems', 'providerNotVerified', 'priceNotBelowSum']);

      const ok = await providerWithServices(['100000.00', '80000.00']);
      const good = await packWith(ok.provider.id, ok.services, { price: '170000.00', nameAr: 'باقة' } as never);
      const published = await request(t.http).post(`${BASE}/${good.id}/publish`).set(admin.headers).expect(200);
      expect(published.body.data).toMatchObject({ status: 'published', visibleInApp: true });
      expect(await audited('pack.published', good.id)).not.toBeNull();
      expectError(await request(t.http).post(`${BASE}/${good.id}/publish`).set(admin.headers), 409, 'PACK_INVALID_TRANSITION');
      const unpublished = await request(t.http).post(`${BASE}/${good.id}/unpublish`).set(admin.headers).expect(200);
      expect(unpublished.body.data.status).toBe('unpublished');
      expectError(await request(t.http).post(`${BASE}/${good.id}/unpublish`).set(admin.headers), 409, 'PACK_INVALID_TRANSITION');
      await request(t.http).post(`${BASE}/${good.id}/publish`).set(admin.headers).expect(200);
      expectError(await request(t.http).post(`${BASE}/${MISSING}/publish`).set(admin.headers), 404, 'PACK_NOT_FOUND');
    });

    it('duplicates as a draft with the same items', async () => {
      const { provider, services } = await providerWithServices(['100000.00', '80000.00']);
      const pack = await packWith(provider.id, services, { nameEn: 'Pack Sara', nameAr: 'باقة سارة', status: PackStatus.Published } as never);
      const res = await request(t.http).post(`${BASE}/${pack.id}/duplicate`).set(admin.headers).expect(201);
      expect(res.body.data).toMatchObject({ nameEn: 'Pack Sara (copy)', nameAr: 'باقة سارة (نسخة)', status: 'draft', itemsCount: 2 });
      expect(res.body.data.id).not.toBe(pack.id);
    });

    it('409 PACK_HAS_BOOKINGS for accepted upcoming bookings; otherwise deletes and cancels pending', async () => {
      const { provider, services } = await providerWithServices(['100000.00', '80000.00']);
      const pack = await packWith(provider.id, services);
      const accepted = await makeBooking(db(), { packId: pack.id, providerId: provider.id, status: BookingStatus.Accepted, eventDate: FUTURE });
      const pending = await makeBooking(db(), { packId: pack.id, providerId: provider.id, status: BookingStatus.Pending, eventDate: FUTURE });
      const refused = await request(t.http).delete(`${BASE}/${pack.id}`).set(admin.headers);
      expectError(refused, 409, 'PACK_HAS_BOOKINGS');
      expect(refused.body.details).toEqual({ upcomingBookings: 1 });

      await db().getRepository(Booking).update(accepted.id, { status: BookingStatus.Completed });
      const res = await request(t.http).delete(`${BASE}/${pack.id}`).set(admin.headers).expect(200);
      expect(res.body.data).toEqual({ id: pack.id, cancelledBookings: 1 });
      expect((await reload(pack.id))!.deletedAt).not.toBeNull();
      expect((await db().getRepository(Booking).findOneByOrFail({ id: pending.id })).status).toBe(BookingStatus.Cancelled);
      expect(await audited('pack.deleted', pack.id)).not.toBeNull();
      expectError(await request(t.http).delete(`${BASE}/${pack.id}`).set(admin.headers), 404, 'PACK_NOT_FOUND');
    });
  });

  // ── photos ──────────────────────────────────────────────────

  describe('photos', () => {
    it('adds, reorders and removes; 422 PHOTO_LIMIT_REACHED at max_photos_per_pack', async () => {
      const { provider, services } = await providerWithServices(['100000.00', '80000.00']);
      const pack = await packWith(provider.id, services);
      await db().getRepository(Setting).save({ key: 'max_photos_per_pack', value: 2 });
      t.get(SettingsService).invalidate();
      try {
        await request(t.http).post(`${BASE}/${pack.id}/photos`).set(admin.headers).attach('file', await png(), 'a.png').expect(201);
        const two = await request(t.http).post(`${BASE}/${pack.id}/photos`).set(admin.headers).attach('file', await png(), 'b.png').expect(201);
        expectError(await request(t.http).post(`${BASE}/${pack.id}/photos`).set(admin.headers).attach('file', await png(), 'c.png'), 422, 'PHOTO_LIMIT_REACHED');
        const [a, b] = two.body.data;
        const ordered = await request(t.http).patch(`${BASE}/${pack.id}/photos/order`).set(admin.headers).send({ ids: [b.id, a.id] }).expect(200);
        expect(ordered.body.data[0]).toMatchObject({ id: b.id, isCover: true, processingStatus: 'ready' });
        const list = await request(t.http).get(BASE).query({ providerId: provider.id }).set(admin.headers);
        expect(list.body.data[0].coverUrl).toContain(b.fileId);
        const removed = await request(t.http).delete(`${BASE}/${pack.id}/photos/${b.id}`).set(admin.headers).expect(200);
        expect(removed.body.data).toHaveLength(1);
        expectError(await request(t.http).delete(`${BASE}/${pack.id}/photos/${MISSING}`).set(admin.headers), 404, 'PHOTO_NOT_FOUND');
      } finally {
        await db().getRepository(Setting).save({ key: 'max_photos_per_pack', value: 6 });
        t.get(SettingsService).invalidate();
      }
    });
  });

  // ── needs attention from other modules ──────────────────────

  describe('needs_attention recompute on provider changes', () => {
    it('blocking the provider flags the pack and tells them; unblocking resolves it', async () => {
      const { provider, services } = await providerWithServices(['100000.00', '80000.00']);
      const pack = await packWith(provider.id, services, { status: PackStatus.Published } as never);
      await request(t.http).post(`/api/v1/admin/users/${provider.id}/block`).set(admin.headers).send({ reason: 'fake_account', bookings: 'keep' }).expect(200);
      expect((await reload(pack.id))!.needsAttention).toBe(true);
      expect(t.get(MailService).outbox.some((m) => m.to === provider.email && m.subject === 'Your Ready Pack needs attention')).toBe(true);
      const row = await request(t.http).get(`${BASE}/${pack.id}`).set(admin.headers);
      expect(row.body.data.attentionReasons).toEqual([{ code: 'provider_blocked', serviceId: null }]);

      await request(t.http).post(`/api/v1/admin/users/${provider.id}/unblock`).set(admin.headers).expect(200);
      expect((await reload(pack.id))!.needsAttention).toBe(false);
    });
  });
});
