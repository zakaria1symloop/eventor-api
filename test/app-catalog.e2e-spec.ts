import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BookingStatus } from '../src/common/enums/booking.enums.js';
import { AvailabilityKind, PackStatus, PriceType, ServiceStatus } from '../src/common/enums/catalog.enums.js';
import { ReviewStatus } from '../src/common/enums/moderation.enums.js';
import { UserRole, UserStatus, VerificationStatus } from '../src/common/enums/user.enums.js';
import { PackItem } from '../src/packs/entities/pack-item.entity.js';
import { ReviewReply } from '../src/reviews/entities/review-reply.entity.js';
import {
  createApp,
  expectError,
  loginAs,
  makeBooking,
  makeCategory,
  makePack,
  makeProvider,
  makeReview,
  makeService,
  makeUser,
  uid,
  type LoggedIn,
  type TestApp,
} from './utils/index.js';

const BASE = '/api/v1/app';
const ALGIERS = 16;

let t: TestApp;
let client: LoggedIn;
const db = () => t.dataSource;

async function addWilayas(serviceId: string, codes: number[] = [ALGIERS]): Promise<void> {
  for (const code of codes) {
    await db().query('INSERT INTO service_wilayas (service_id, wilaya_code, created_at) VALUES (?, ?, NOW(6))', [serviceId, code]);
  }
}

/** A service that satisfies the whole visibility rule: published, verified provider, open wilaya. */
async function visibleService(overrides: Record<string, unknown> = {}, wilayas: number[] = [ALGIERS]) {
  const service = await makeService(db(), { status: ServiceStatus.Published, ...overrides });
  await addWilayas(service.id, wilayas);
  return service;
}

/** A published pack of two visible services of the same provider. */
async function visiblePack(overrides: Record<string, unknown> = {}) {
  const { user: provider } = await makeProvider(db());
  const a = await visibleService({ providerId: provider.id, basePrice: '200000.00' });
  const b = await visibleService({ providerId: provider.id, basePrice: '165000.00' });
  const pack = await makePack(db(), {
    providerId: provider.id,
    status: PackStatus.Published,
    needsAttention: false,
    price: '320000.00',
    wilayaCode: ALGIERS,
    ...overrides,
  });
  await db().getRepository(PackItem).insert([
    { packId: pack.id, serviceId: a.id, position: 0 },
    { packId: pack.id, serviceId: b.id, position: 1 },
  ]);
  return { pack, provider, services: [a, b] };
}

beforeAll(async () => {
  t = await createApp();
  client = await loginAs(t, UserRole.Client);
});

afterAll(async () => {
  await t.close();
});

describe('App catalog (e2e)', () => {
  describe('GET /app/config', () => {
    it('is public and carries what the splash screen needs', async () => {
      const res = await request(t.http).get(`${BASE}/config`);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        minAppVersion: expect.any(String),
        maintenanceMode: expect.any(Boolean),
        defaultLanguage: 'en',
        currency: expect.any(String),
      });
      expect(res.body.data.languages).toEqual(expect.arrayContaining(['en', 'ar']));
      expect(res.body.data.uploads.maxDocumentMb).toBeGreaterThan(0);
      expect(res.body.data.passwordPolicy).toEqual({ minLength: 10, needsLetterAndDigit: true });
      expect(res.body.data.booking.minNoticeDays).toEqual(expect.any(Number));
      expect(res.headers['cache-control']).toContain('max-age=60');
    });
  });

  describe('GET /app/categories and /app/wilayas', () => {
    it('are public, ordered, localised and count only visible services', async () => {
      const category = await makeCategory(db(), { nameEn: 'Photography', nameAr: 'التصوير', position: 1 });
      await visibleService({ categoryId: category.id });
      await makeService(db(), { categoryId: category.id, status: ServiceStatus.Draft });

      const res = await request(t.http).get(`${BASE}/categories`);

      expect(res.status).toBe(200);
      const found = res.body.data.find((c: { id: string }) => c.id === category.id);
      expect(found).toMatchObject({ name: 'Photography', nameAr: 'التصوير', position: 1 });
      // The draft does not count.
      expect(found.servicesCount).toBe(1);

      const ar = await request(t.http).get(`${BASE}/categories`).set('Accept-Language', 'ar');
      expect(ar.body.data.find((c: { id: string }) => c.id === category.id).name).toBe('التصوير');
    });

    it('hides categories an admin made invisible', async () => {
      const hidden = await makeCategory(db(), { isVisible: false });

      const res = await request(t.http).get(`${BASE}/categories`);

      expect(res.body.data.map((c: { id: string }) => c.id)).not.toContain(hidden.id);
    });

    it('lists open wilayas only', async () => {
      const res = await request(t.http).get(`${BASE}/wilayas`).set('Accept-Language', 'ar');

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0]).toMatchObject({ code: expect.any(Number), nameEn: expect.any(String), nameAr: expect.any(String) });
      expect(res.body.data[0].name).toBe(res.body.data[0].nameAr);
    });
  });

  describe('GET /app/services (search)', () => {
    it('is public and returns only services visible per the rule', async () => {
      const visible = await visibleService({ titleEn: `Visible ${uid()}` });
      const draft = await makeService(db(), { status: ServiceStatus.Draft });
      await addWilayas(draft.id);
      const hidden = await makeService(db(), { status: ServiceStatus.Hidden });
      await addWilayas(hidden.id);
      const { user: unverified } = await makeProvider(db(), { user: { verificationStatus: VerificationStatus.Pending } });
      const ofUnverified = await makeService(db(), { providerId: unverified.id, status: ServiceStatus.Published });
      await addWilayas(ofUnverified.id);
      const { user: blocked } = await makeProvider(db(), { user: { status: UserStatus.Blocked } });
      const ofBlocked = await makeService(db(), { providerId: blocked.id, status: ServiceStatus.Published });
      await addWilayas(ofBlocked.id);
      const noWilaya = await makeService(db(), { status: ServiceStatus.Published });

      const res = await request(t.http).get(`${BASE}/services?limit=100`);

      expect(res.status).toBe(200);
      const ids = res.body.data.map((s: { id: string }) => s.id);
      expect(ids).toContain(visible.id);
      for (const excluded of [draft.id, hidden.id, ofUnverified.id, ofBlocked.id, noWilaya.id]) {
        expect(ids).not.toContain(excluded);
      }
    });

    it('returns a card with everything the list needs, and no contact details', async () => {
      const category = await makeCategory(db(), { nameEn: 'Photography', nameAr: 'التصوير' });
      const { user: provider } = await makeProvider(db(), { user: { phone: '+213555111222' } });
      const service = await visibleService({
        providerId: provider.id,
        categoryId: category.id,
        titleEn: `Wedding coverage ${uid()}`,
        titleAr: 'تغطية الزفاف',
        basePrice: '45000.00',
        priceType: PriceType.PerDay,
      });

      const res = await request(t.http).get(`${BASE}/services?q=${encodeURIComponent('Wedding coverage')}`);

      const card = res.body.data.find((s: { id: string }) => s.id === service.id);
      expect(card).toMatchObject({ basePrice: '45000.00', priceType: 'per_day', priceTypeLabel: 'per day', isFavourite: false });
      expect(card.category.name).toBe('Photography');
      expect(card.wilayas[0]).toMatchObject({ code: ALGIERS });
      expect(card.provider).toMatchObject({ id: provider.id, verified: true });
      // Privacy: a client never sees a provider's phone or email while browsing.
      expect(card.provider).not.toHaveProperty('phone');
      expect(card.provider).not.toHaveProperty('email');
      expect(JSON.stringify(res.body)).not.toContain('+213555111222');
      expect(JSON.stringify(res.body)).not.toContain(provider.email);
    });

    it('searches titles in both languages and provider names', async () => {
      const marker = uid(5);
      const byTitle = await visibleService({ titleEn: `Sunset ${marker} shoot`, titleAr: 'جلسة' });
      const byArabic = await visibleService({ titleEn: 'Other', titleAr: `تصوير ${marker}` });
      const { user: provider } = await makeProvider(db(), { user: { fullName: `Karim ${marker}` } });
      const byProvider = await visibleService({ providerId: provider.id });

      const res = await request(t.http).get(`${BASE}/services?q=${marker}&limit=100`);

      const ids = res.body.data.map((s: { id: string }) => s.id);
      expect(ids).toEqual(expect.arrayContaining([byTitle.id, byArabic.id, byProvider.id]));
    });

    it('filters by category, wilaya, price and rating', async () => {
      const category = await makeCategory(db());
      const cheap = await visibleService({ categoryId: category.id, basePrice: '10000.00', avgRating: '3.00' });
      const pricey = await visibleService({ categoryId: category.id, basePrice: '500000.00', avgRating: '5.00' });
      const elsewhere = await visibleService({ categoryId: category.id }, [9]);

      const byCategory = await request(t.http).get(`${BASE}/services?categoryId=${category.id}&limit=100`);
      expect(byCategory.body.data.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining([cheap.id, pricey.id, elsewhere.id]));

      const byPrice = await request(t.http).get(`${BASE}/services?categoryId=${category.id}&priceMin=1000&priceMax=20000&limit=100`);
      expect(byPrice.body.data.map((s: { id: string }) => s.id)).toEqual([cheap.id]);

      const byWilaya = await request(t.http).get(`${BASE}/services?categoryId=${category.id}&wilaya=9&limit=100`);
      expect(byWilaya.body.data.map((s: { id: string }) => s.id)).toEqual([elsewhere.id]);

      const byRating = await request(t.http).get(`${BASE}/services?categoryId=${category.id}&rating=4&limit=100`);
      expect(byRating.body.data.map((s: { id: string }) => s.id)).toEqual([pricey.id]);
    });

    it('filters by a date the provider is free on', async () => {
      const category = await makeCategory(db());
      const date = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
      const free = await visibleService({ categoryId: category.id });
      const blocked = await visibleService({ categoryId: category.id });
      await db().query(
        'INSERT INTO availability_blocks (id, created_at, updated_at, provider_id, date, kind) VALUES (UUID(), NOW(6), NOW(6), ?, ?, ?)',
        [blocked.providerId, date, AvailabilityKind.Blocked],
      );
      const booked = await visibleService({ categoryId: category.id, maxEventsPerDay: 1 });
      await makeBooking(db(), { serviceId: booked.id, providerId: booked.providerId, eventDate: date, status: BookingStatus.Accepted });

      const res = await request(t.http).get(`${BASE}/services?categoryId=${category.id}&eventDate=${date}&limit=100`);

      const ids = res.body.data.map((s: { id: string }) => s.id);
      expect(ids).toContain(free.id);
      expect(ids).not.toContain(blocked.id);
      expect(ids).not.toContain(booked.id);
    });

    it('sorts by price, rating and popularity', async () => {
      const category = await makeCategory(db());
      const a = await visibleService({ categoryId: category.id, basePrice: '10000.00', avgRating: '3.00', bookingsCount: 100 });
      const b = await visibleService({ categoryId: category.id, basePrice: '90000.00', avgRating: '5.00', bookingsCount: 1 });

      const cheapest = await request(t.http).get(`${BASE}/services?categoryId=${category.id}&order=price_asc`);
      expect(cheapest.body.data.map((s: { id: string }) => s.id)).toEqual([a.id, b.id]);

      const dearest = await request(t.http).get(`${BASE}/services?categoryId=${category.id}&order=price_desc`);
      expect(dearest.body.data.map((s: { id: string }) => s.id)).toEqual([b.id, a.id]);

      const best = await request(t.http).get(`${BASE}/services?categoryId=${category.id}&order=rating`);
      expect(best.body.data.map((s: { id: string }) => s.id)).toEqual([b.id, a.id]);

      const popular = await request(t.http).get(`${BASE}/services?categoryId=${category.id}&order=popular`);
      expect(popular.body.data.map((s: { id: string }) => s.id)).toEqual([a.id, b.id]);
    });

    it('paginates with a correct meta block', async () => {
      const category = await makeCategory(db());
      for (let i = 0; i < 3; i++) await visibleService({ categoryId: category.id });

      const res = await request(t.http).get(`${BASE}/services?categoryId=${category.id}&page=2&limit=2`);

      expect(res.body.meta).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
      expect(res.body.data).toHaveLength(1);
    });

    it('fills isFavourite for a signed-in caller and leaves it false for a visitor', async () => {
      const service = await visibleService();
      await request(t.http).post(`${BASE}/me/favourites`).set(client.headers).send({ serviceId: service.id });

      const signedIn = await request(t.http).get(`${BASE}/services?q=${service.titleEn}`).set(client.headers);
      expect(signedIn.body.data.find((s: { id: string }) => s.id === service.id).isFavourite).toBe(true);

      const anonymous = await request(t.http).get(`${BASE}/services?q=${service.titleEn}`);
      expect(anonymous.body.data.find((s: { id: string }) => s.id === service.id).isFavourite).toBe(false);
    });

    it('401 when favourite=true without a token', async () => {
      expectError(await request(t.http).get(`${BASE}/services?favourite=true`), 401, 'AUTH_TOKEN_MISSING');
    });

    it('400 VALIDATION_FAILED for a bad sort, limit or date', async () => {
      expectError(await request(t.http).get(`${BASE}/services?order=cheapest`), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).get(`${BASE}/services?limit=500`), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).get(`${BASE}/services?eventDate=14-03-2026`), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).get(`${BASE}/services?unknownFilter=1`), 400, 'VALIDATION_FAILED');
    });
  });

  describe('GET /app/services/:id (screen 12)', () => {
    it('returns the detail fields the screen prints', async () => {
      const category = await makeCategory(db(), { nameEn: 'Photography', nameAr: 'التصوير' });
      const service = await visibleService(
        {
          categoryId: category.id,
          titleEn: 'Wedding photo & video coverage',
          titleAr: 'تغطية تصوير الأعراس',
          descriptionEn: 'We cover the whole day.',
          descriptionAr: 'نغطي اليوم بأكمله.',
          cancellationPolicyEn: 'Free cancellation up to 30 days before.',
          cancellationPolicyAr: 'إلغاء مجاني قبل 30 يومًا.',
          facts: [{ label_en: 'Duration', label_ar: 'المدة', value_en: '10 h', value_ar: '10 ساعات' }],
          maxGuests: 300,
        },
        [ALGIERS, 9],
      );
      await db().query(
        'INSERT INTO service_extras (id, created_at, updated_at, service_id, name_en, name_ar, price, position) VALUES (UUID(), NOW(6), NOW(6), ?, ?, ?, ?, 0)',
        [service.id, 'Pre-wedding session', 'جلسة ما قبل الزفاف', '12000.00'],
      );

      const res = await request(t.http).get(`${BASE}/services/${service.id}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: service.id,
        title: 'Wedding photo & video coverage',
        titleAr: 'تغطية تصوير الأعراس',
        description: 'We cover the whole day.',
        cancellationPolicy: 'Free cancellation up to 30 days before.',
        maxGuests: 300,
      });
      expect(res.body.data.facts[0]).toMatchObject({ label: 'Duration', value: '10 h', labelAr: 'المدة' });
      expect(res.body.data.extras[0]).toMatchObject({ name: 'Pre-wedding session', price: '12000.00' });
      expect(res.body.data.wilayas.map((w: { code: number }) => w.code)).toEqual([9, 16]);
      expect(res.body.data.ratingBreakdown).toHaveLength(5);
      expect(res.body.data.provider).toMatchObject({ verified: true });
      expect(Array.isArray(res.body.data.photos)).toBe(true);
      expect(Array.isArray(res.body.data.recentReviews)).toBe(true);
      expect(Array.isArray(res.body.data.providerPacks)).toBe(true);
    });

    it('returns Arabic text with Accept-Language: ar, and falls back when it is missing', async () => {
      const full = await visibleService({ titleEn: 'English title', titleAr: 'عنوان عربي', descriptionEn: 'EN', descriptionAr: 'AR' });
      const half = await visibleService({ titleEn: 'Only English', titleAr: '', descriptionEn: 'EN only', descriptionAr: '' });

      const ar = await request(t.http).get(`${BASE}/services/${full.id}`).set('Accept-Language', 'ar');
      expect(ar.body.data.title).toBe('عنوان عربي');
      expect(ar.body.data.titleEn).toBe('English title');

      // A half-translated row still shows something rather than an empty screen.
      const fallback = await request(t.http).get(`${BASE}/services/${half.id}`).set('Accept-Language', 'ar');
      expect(fallback.body.data.title).toBe('Only English');
      expect(fallback.body.data.description).toBe('EN only');
    });

    it('honours the q-value ordering of Accept-Language', async () => {
      const service = await visibleService({ titleEn: 'English title', titleAr: 'عنوان عربي' });

      const res = await request(t.http).get(`${BASE}/services/${service.id}`).set('Accept-Language', 'fr;q=0.9,ar;q=0.8,en;q=0.7');

      expect(res.body.data.title).toBe('عنوان عربي');
    });

    it.each([
      ['a draft', { status: ServiceStatus.Draft }],
      ['a hidden service', { status: ServiceStatus.Hidden }],
    ])('404 SERVICE_NOT_FOUND for %s, rather than admitting it exists', async (_label, overrides) => {
      const service = await makeService(db(), overrides);
      await addWilayas(service.id);

      expectError(await request(t.http).get(`${BASE}/services/${service.id}`), 404, 'SERVICE_NOT_FOUND');
    });

    it('404 for an unknown id and for a malformed one', async () => {
      expectError(await request(t.http).get(`${BASE}/services/11111111-1111-4111-8111-111111111111`), 404, 'SERVICE_NOT_FOUND');
      expectError(await request(t.http).get(`${BASE}/services/not-a-uuid`), 404, 'SERVICE_NOT_FOUND');
    });

    it('returns the Arabic error message with Accept-Language: ar', async () => {
      const res = await request(t.http).get(`${BASE}/services/11111111-1111-4111-8111-111111111111`).set('Accept-Language', 'ar');

      expectError(res, 404, 'SERVICE_NOT_FOUND');
      expect(res.body.message).toMatch(/[؀-ۿ]/);
    });
  });

  describe('GET /app/services/:id/reviews', () => {
    it('returns published reviews with the provider reply, and hides moderated ones', async () => {
      const service = await visibleService();
      const booking = await makeBooking(db(), { serviceId: service.id, providerId: service.providerId, status: BookingStatus.Completed });
      const author = await makeUser(db(), { fullName: 'Yasmine Kaci' });
      const published = await makeReview(db(), {
        bookingId: booking.id,
        serviceId: service.id,
        providerId: service.providerId,
        authorId: author.id,
        rating: 5,
        comment: 'Wonderful team.',
        status: ReviewStatus.Published,
      });
      await db().getRepository(ReviewReply).insert({ reviewId: published.id, providerId: service.providerId, body: 'Thank you!' });
      const hiddenBooking = await makeBooking(db(), { serviceId: service.id, providerId: service.providerId, status: BookingStatus.Completed });
      await makeReview(db(), {
        bookingId: hiddenBooking.id,
        serviceId: service.id,
        providerId: service.providerId,
        comment: 'Hidden by an admin',
        status: ReviewStatus.Hidden,
      });

      const res = await request(t.http).get(`${BASE}/services/${service.id}/reviews`);

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0]).toMatchObject({ rating: 5, comment: 'Wonderful team.', reply: 'Thank you!', redacted: false });
      // Only "Yasmine K.", never the full name or the email.
      expect(res.body.data[0].authorName).toBe('Yasmine K.');
      expect(JSON.stringify(res.body)).not.toContain('Kaci');
      expect(JSON.stringify(res.body)).not.toContain(author.email);
      expect(JSON.stringify(res.body)).not.toContain('Hidden by an admin');
    });

    it('serves the redacted text for a redacted review', async () => {
      const service = await visibleService();
      const booking = await makeBooking(db(), { serviceId: service.id, providerId: service.providerId, status: BookingStatus.Completed });
      await makeReview(db(), {
        bookingId: booking.id,
        serviceId: service.id,
        providerId: service.providerId,
        comment: 'Call me on 0555123456',
        redactedComment: 'Call me on [removed]',
        status: ReviewStatus.Redacted,
      });

      const res = await request(t.http).get(`${BASE}/services/${service.id}/reviews`);

      expect(res.body.data[0]).toMatchObject({ comment: 'Call me on [removed]', redacted: true });
      expect(JSON.stringify(res.body)).not.toContain('0555123456');
    });

    it('filters by star rating and paginates', async () => {
      const service = await visibleService();
      for (const rating of [5, 4, 3]) {
        const booking = await makeBooking(db(), { serviceId: service.id, providerId: service.providerId, status: BookingStatus.Completed });
        await makeReview(db(), { bookingId: booking.id, serviceId: service.id, providerId: service.providerId, rating, status: ReviewStatus.Published });
      }

      expect((await request(t.http).get(`${BASE}/services/${service.id}/reviews?rating=4`)).body.meta.total).toBe(1);
      const page = await request(t.http).get(`${BASE}/services/${service.id}/reviews?page=1&limit=2`);
      expect(page.body.meta).toMatchObject({ total: 3, totalPages: 2 });
      expect(page.body.data).toHaveLength(2);
    });

    it('404 for a service that is not visible', async () => {
      const draft = await makeService(db(), { status: ServiceStatus.Draft });
      expectError(await request(t.http).get(`${BASE}/services/${draft.id}/reviews`), 404, 'SERVICE_NOT_FOUND');
    });
  });

  describe('GET /app/services/:id/availability', () => {
    it('marks blocked, busy and available days', async () => {
      const service = await visibleService({ maxEventsPerDay: 1 });
      const base = new Date(Date.now() + 60 * 86_400_000);
      const month = base.toISOString().slice(0, 7);
      const blockedDay = `${month}-10`;
      const bookedDay = `${month}-11`;
      await db().query(
        'INSERT INTO availability_blocks (id, created_at, updated_at, provider_id, date, kind) VALUES (UUID(), NOW(6), NOW(6), ?, ?, ?)',
        [service.providerId, blockedDay, AvailabilityKind.Blocked],
      );
      await makeBooking(db(), { serviceId: service.id, providerId: service.providerId, eventDate: bookedDay, status: BookingStatus.Accepted });

      const res = await request(t.http).get(`${BASE}/services/${service.id}/availability?month=${month}`);

      expect(res.status).toBe(200);
      expect(res.body.data.month).toBe(month);
      expect(res.body.data.maxEventsPerDay).toBe(1);
      const byDate = Object.fromEntries(res.body.data.days.map((d: { date: string; state: string }) => [d.date, d.state]));
      expect(byDate[blockedDay]).toBe('blocked');
      expect(byDate[bookedDay]).toBe('busy');
      expect(byDate[`${month}-12`]).toBe('available');
      expect(res.body.data.days.length).toBeGreaterThanOrEqual(28);
    });

    it('blocks every day already past', async () => {
      const service = await visibleService();
      const lastMonth = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 7);

      const res = await request(t.http).get(`${BASE}/services/${service.id}/availability?month=${lastMonth}`);

      expect(res.body.data.days.every((d: { state: string }) => d.state === 'blocked')).toBe(true);
    });

    it('400 for a malformed or missing month', async () => {
      const service = await visibleService();
      expectError(await request(t.http).get(`${BASE}/services/${service.id}/availability?month=2026-13`), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).get(`${BASE}/services/${service.id}/availability`), 400, 'VALIDATION_FAILED');
    });
  });

  describe('GET /app/providers/:id (screen 13)', () => {
    it('returns the profile, stats, checks, services and reviews', async () => {
      const category = await makeCategory(db(), { nameEn: 'Photography', nameAr: 'التصوير' });
      const { user: provider, profile } = await makeProvider(db(), {
        user: { phone: '+213555999888' },
        profile: { businessName: 'Studio Lumière', categoryId: category.id, bioEn: 'We cover weddings.', bioAr: 'نغطي الأعراس.', yearsActive: 6, avgReplyMinutes: 120, completedBookingsCount: 48, avgRating: '4.80', ratingCount: 32 },
      });
      await db().query('INSERT INTO provider_wilayas (provider_profile_id, wilaya_code, created_at) VALUES (?, ?, NOW(6))', [profile.id, ALGIERS]);
      const service = await visibleService({ providerId: provider.id });

      const res = await request(t.http).get(`${BASE}/providers/${provider.id}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: provider.id,
        businessName: 'Studio Lumière',
        verified: true,
        avgRating: '4.80',
        ratingCount: 32,
        completedBookingsCount: 48,
        yearsActive: 6,
        replyTime: '2 h',
        bio: 'We cover weddings.',
        servicesCount: 1,
      });
      expect(res.body.data.services.map((s: { id: string }) => s.id)).toEqual([service.id]);
      expect(res.body.data.wilayas.map((w: { code: number }) => w.code)).toEqual([ALGIERS]);
      expect(res.body.data.checks).toHaveLength(3);
      expect(res.body.data.checks[0]).toMatchObject({ code: 'identity', passed: true });
      expect(res.body.data.memberSince).toEqual(expect.stringMatching(/^\d{4}-/));
      // Privacy again.
      expect(JSON.stringify(res.body)).not.toContain('+213555999888');
      expect(JSON.stringify(res.body)).not.toContain(provider.email);
    });

    it('localises the bio and the checks', async () => {
      const { user: provider } = await makeProvider(db(), { profile: { bioEn: 'English bio', bioAr: 'سيرة عربية' } });

      const res = await request(t.http).get(`${BASE}/providers/${provider.id}`).set('Accept-Language', 'ar');

      expect(res.body.data.bio).toBe('سيرة عربية');
      expect(res.body.data.checks[0].title).toMatch(/[؀-ۿ]/);
    });

    it.each([
      ['unverified', { verificationStatus: VerificationStatus.Pending }],
      ['blocked', { status: UserStatus.Blocked }],
    ])('404 PROVIDER_NOT_FOUND for a %s provider', async (_label, overrides) => {
      const { user: provider } = await makeProvider(db(), { user: overrides });

      expectError(await request(t.http).get(`${BASE}/providers/${provider.id}`), 404, 'PROVIDER_NOT_FOUND');
    });

    it('404 PROVIDER_NOT_FOUND for a client id', async () => {
      expectError(await request(t.http).get(`${BASE}/providers/${client.user.id}`), 404, 'PROVIDER_NOT_FOUND');
    });

    it('lists the provider’s reviews separately', async () => {
      const { user: provider } = await makeProvider(db());
      const service = await visibleService({ providerId: provider.id });
      const booking = await makeBooking(db(), { serviceId: service.id, providerId: provider.id, status: BookingStatus.Completed });
      await makeReview(db(), { bookingId: booking.id, serviceId: service.id, providerId: provider.id, status: ReviewStatus.Published });

      const res = await request(t.http).get(`${BASE}/providers/${provider.id}/reviews`);

      expect(res.body.meta.total).toBe(1);
    });
  });

  describe('GET /app/packs (screens 19 / 20)', () => {
    it('lists visible packs with their saving and item summary', async () => {
      const { pack } = await visiblePack({ nameEn: 'Essentiel Mariage', nameAr: 'أساسيات الزفاف' });

      const res = await request(t.http).get(`${BASE}/packs?limit=100`);

      expect(res.status).toBe(200);
      const card = res.body.data.find((p: { id: string }) => p.id === pack.id);
      expect(card).toMatchObject({
        name: 'Essentiel Mariage',
        price: '320000.00',
        sumOfItems: '365000.00',
        savings: '45000.00',
        itemsCount: 2,
      });
      expect(card.savingsPercent).toBeCloseTo(12.3, 1);
      expect(card.provider.businessName).toEqual(expect.any(String));
      expect(card.wilaya.code).toBe(ALGIERS);
    });

    it.each([
      ['a draft', { status: PackStatus.Draft }],
      ['an unpublished pack', { status: PackStatus.Unpublished }],
      ['one that needs attention', { needsAttention: true }],
    ])('hides %s', async (_label, overrides) => {
      const { pack } = await visiblePack(overrides);

      const res = await request(t.http).get(`${BASE}/packs?limit=100`);

      expect(res.body.data.map((p: { id: string }) => p.id)).not.toContain(pack.id);
      expectError(await request(t.http).get(`${BASE}/packs/${pack.id}`), 404, 'PACK_NOT_FOUND');
    });

    it('filters by event type and wilaya, and sorts by saving', async () => {
      const { pack: big } = await visiblePack({ price: '100000.00' });
      const { pack: small } = await visiblePack({ price: '360000.00' });

      const res = await request(t.http).get(`${BASE}/packs?limit=100`);
      const ids = res.body.data.map((p: { id: string }) => p.id);
      // The biggest saving leads, which is what screen 19 promises.
      expect(ids.indexOf(big.id)).toBeLessThan(ids.indexOf(small.id));

      const byWilaya = await request(t.http).get(`${BASE}/packs?wilaya=9&limit=100`);
      expect(byWilaya.body.data.map((p: { id: string }) => p.id)).not.toContain(big.id);
    });

    it('returns the detail with its items, shared wilayas and prices', async () => {
      const { pack, services } = await visiblePack({ descriptionEn: 'Everything for 150 guests.', descriptionAr: 'كل شيء لـ150 ضيفًا.' });

      const res = await request(t.http).get(`${BASE}/packs/${pack.id}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: pack.id, description: 'Everything for 150 guests.', savings: '45000.00' });
      expect(res.body.data.items).toHaveLength(2);
      expect(res.body.data.items.map((i: { serviceId: string }) => i.serviceId).sort()).toEqual([services[0]!.id, services[1]!.id].sort());
      expect(res.body.data.items[0]).toMatchObject({ price: expect.any(String), position: 0 });
      expect(res.body.data.wilayas.map((w: { code: number }) => w.code)).toEqual([ALGIERS]);
      expect(Array.isArray(res.body.data.photos)).toBe(true);
    });

    it('combines the item providers’ calendars: one taken provider makes the day busy', async () => {
      const { pack, services } = await visiblePack();
      const month = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 7);
      const takenDay = `${month}-15`;
      await db().query('UPDATE services SET max_events_per_day = 1 WHERE id IN (?, ?)', [services[0]!.id, services[1]!.id]);
      await makeBooking(db(), {
        serviceId: services[0]!.id,
        providerId: services[0]!.providerId,
        eventDate: takenDay,
        status: BookingStatus.Accepted,
      });

      const res = await request(t.http).get(`${BASE}/packs/${pack.id}/availability?month=${month}`);

      const byDate = Object.fromEntries(res.body.data.days.map((d: { date: string; state: string }) => [d.date, d.state]));
      expect(byDate[takenDay]).toBe('busy');
      expect(byDate[`${month}-16`]).toBe('available');
    });

    it('404 for an unknown pack', async () => {
      expectError(await request(t.http).get(`${BASE}/packs/11111111-1111-4111-8111-111111111111`), 404, 'PACK_NOT_FOUND');
      expectError(await request(t.http).get(`${BASE}/packs/not-a-uuid/availability?month=2026-03`), 404, 'PACK_NOT_FOUND');
    });
  });

  describe('GET /app/home (screen 11)', () => {
    it('aggregates everything the screen shows', async () => {
      const me = await loginAs(t, UserRole.Client, { fullName: 'Amina Benali', wilayaCode: ALGIERS });
      await visibleService();
      await visiblePack();
      const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      const booked = await visibleService();
      await makeBooking(db(), {
        clientId: me.user.id,
        serviceId: booked.id,
        providerId: booked.providerId,
        eventDate: future,
        status: BookingStatus.Accepted,
      });
      await request(t.http).put(`${BASE}/me/budget`).set(me.headers).send({ title: 'Wedding', totalAmount: '400000.00' });

      const res = await request(t.http).get(`${BASE}/home`).set(me.headers);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ fullName: 'Amina Benali' });
      expect(res.body.data.wilaya.code).toBe(ALGIERS);
      expect(res.body.data.categories.length).toBeGreaterThan(0);
      expect(res.body.data.upcomingBookings.length).toBeGreaterThan(0);
      expect(res.body.data.upcomingBookings[0]).toMatchObject({ eventDate: future, status: 'accepted' });
      expect(res.body.data.upcomingBookings[0].providerName).toEqual(expect.any(String));
      expect(res.body.data.budget).toMatchObject({ exists: true, totalAmount: '400000.00', spentTotal: '0.00' });
      expect(res.body.data.packs.length).toBeGreaterThan(0);
      expect(res.body.data.nearbyServices.length).toBeGreaterThan(0);
      expect(res.body.data.unreadNotifications).toEqual(expect.any(Number));
    });

    it('shows at most two upcoming bookings, soonest first, and never a past one', async () => {
      const me = await loginAs(t, UserRole.Client);
      const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
      for (const offset of [40, 10, 20]) {
        const service = await visibleService();
        await makeBooking(db(), { clientId: me.user.id, serviceId: service.id, providerId: service.providerId, eventDate: day(offset), status: BookingStatus.Accepted });
      }
      const past = await visibleService();
      await makeBooking(db(), { clientId: me.user.id, serviceId: past.id, providerId: past.providerId, eventDate: day(-10), status: BookingStatus.Accepted });

      const res = await request(t.http).get(`${BASE}/home`).set(me.headers);

      expect(res.body.data.upcomingBookings).toHaveLength(2);
      expect(res.body.data.upcomingBookings.map((b: { eventDate: string }) => b.eventDate)).toEqual([day(10), day(20)]);
    });

    it('reports an empty budget without failing, before one exists', async () => {
      const me = await loginAs(t, UserRole.Client);

      const res = await request(t.http).get(`${BASE}/home`).set(me.headers);

      expect(res.body.data.budget).toMatchObject({ exists: false, spentTotal: '0.00', itemsCount: 0 });
    });

    it('401 without a token — home is the one personalised browse route', async () => {
      expectError(await request(t.http).get(`${BASE}/home`), 401, 'AUTH_TOKEN_MISSING');
    });
  });

  describe('POST /app/events', () => {
    it('accepts the two event shapes with 202 and stores nothing (V1 stub)', async () => {
      const service = await visibleService();

      const view = await request(t.http).post(`${BASE}/events`).send({ type: 'service_view', serviceId: service.id });
      expect(view.status).toBe(202);
      expect(view.body).toEqual({});

      const search = await request(t.http).post(`${BASE}/events`).send({ type: 'search', query: 'photographe', wilaya: ALGIERS });
      expect(search.status).toBe(202);
    });

    it('400 VALIDATION_FAILED for an unknown type or field, so the V2 contract is already pinned', async () => {
      expectError(await request(t.http).post(`${BASE}/events`).send({ type: 'click' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${BASE}/events`).send({ type: 'search', foo: 'bar' }), 400, 'VALIDATION_FAILED');
    });
  });
});
