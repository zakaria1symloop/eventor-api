import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BookingStatus } from '../src/common/enums/booking.enums.js';
import { EventType, PackStatus, PriceType, ServiceStatus } from '../src/common/enums/catalog.enums.js';
import { UserRole, VerificationStatus } from '../src/common/enums/user.enums.js';
import {
  createApp,
  expectError,
  loginAs,
  makeBooking,
  makeCategory,
  makePack,
  makeReview,
  makeService,
  type LoggedIn,
  type TestApp,
} from './utils/index.js';

const BASE = '/api/v1/app/provider';

let t: TestApp;
let provider: LoggedIn;
let otherProvider: LoggedIn;
let client: LoggedIn;
let categoryId: string;
const db = () => t.dataSource;

/** A tiny real PNG, so the upload pipe's content sniffing is exercised. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f80f00010101005e2f2f0000000049454e44ae426082', 'hex');

async function ownService(overrides: Record<string, unknown> = {}) {
  const service = await makeService(db(), { providerId: provider.user.id, categoryId, status: ServiceStatus.Draft, ...overrides });
  await db().query('INSERT INTO service_wilayas (service_id, wilaya_code, created_at) VALUES (?, 16, NOW(6))', [service.id]);
  return service;
}

beforeAll(async () => {
  t = await createApp();
  provider = await loginAs(t, UserRole.Provider);
  otherProvider = await loginAs(t, UserRole.Provider);
  client = await loginAs(t, UserRole.Client);
  categoryId = (await makeCategory(db())).id;
});

afterAll(async () => {
  await t.close();
});

describe('App provider (e2e)', () => {
  describe('GET /app/provider/home', () => {
    it('draws screen 21 for a verified provider', async () => {
      await makeBooking(db(), { providerId: provider.user.id, clientId: client.user.id, status: BookingStatus.Pending });
      await ownService({ status: ServiceStatus.Published });

      const res = await request(t.http).get(`${BASE}/home`).set(provider.headers);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ state: 'verified', documents: null, acceptingBookings: true });
      expect(res.body.data.counts).toMatchObject({ requests: expect.any(Number), upcoming: expect.any(Number), services: expect.any(Number) });
      expect(res.body.data.requests.length).toBeGreaterThan(0);
      expect(res.body.data.requests[0].allowedActions).toEqual(expect.arrayContaining(['accept', 'decline']));
      expect(res.body.data.services.length).toBeGreaterThan(0);
      expect(res.body.data.verificationSteps.every((s: { done: boolean }) => s.done)).toBe(true);
    });

    it('draws screen 21a with the steps and the documents while the profile is pending', async () => {
      const pending = await loginAs(t, UserRole.Provider, { verificationStatus: VerificationStatus.Pending });

      const res = await request(t.http).get(`${BASE}/home`).set(pending.headers);

      expect(res.status).toBe(200);
      expect(res.body.data.state).toBe('pending');
      expect(res.body.data.documents).not.toBeNull();
      expect(res.body.data.verificationSteps[0]).toMatchObject({ key: 'account_created', done: true });
      expect(res.body.data.verificationSteps.at(-1)).toMatchObject({ key: 'approved', done: false });
    });

    it('refuses a client token and an anonymous call', async () => {
      expectError(await request(t.http).get(`${BASE}/home`).set(client.headers), 403, 'FORBIDDEN_ROLE');
      expect((await request(t.http).get(`${BASE}/home`)).status).toBe(401);
    });
  });

  describe('PATCH /app/provider/profile', () => {
    it('updates the business fields and the availability toggle', async () => {
      const res = await request(t.http)
        .patch(`${BASE}/profile`)
        .set(provider.headers)
        .send({ businessName: 'Studio Lumière', bioEn: 'We shoot weddings.', bioAr: 'نصور الأعراس.', languagesSpoken: ['ar', 'fr'], yearsActive: 8, acceptingBookings: false, wilayaCodes: [16, 9] });

      expect(res.status).toBe(200);
      const [row] = await db().query('SELECT business_name, accepting_bookings, years_active, languages_spoken FROM provider_profiles WHERE user_id = ?', [provider.user.id]);
      expect(row.business_name).toBe('Studio Lumière');
      expect(Number(row.accepting_bookings)).toBe(0);
      expect(Number(row.years_active)).toBe(8);
      const wilayas = await db().query('SELECT wilaya_code FROM provider_wilayas pw JOIN provider_profiles pp ON pp.id = pw.provider_profile_id WHERE pp.user_id = ?', [provider.user.id]);
      expect(wilayas.map((w: { wilaya_code: number }) => Number(w.wilaya_code)).sort((a: number, b: number) => a - b)).toEqual([9, 16]);

      await request(t.http).patch(`${BASE}/profile`).set(provider.headers).send({ acceptingBookings: true });
    });

    it('refuses a hidden category, an unknown wilaya and a bad field', async () => {
      const hidden = await makeCategory(db(), { isVisible: false });
      expectError(await request(t.http).patch(`${BASE}/profile`).set(provider.headers).send({ categoryId: hidden.id }), 422, 'CATEGORY_HIDDEN');
      expectError(await request(t.http).patch(`${BASE}/profile`).set(provider.headers).send({ wilayaCodes: [99] }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).patch(`${BASE}/profile`).set(provider.headers).send({ businessName: 'x' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).patch(`${BASE}/profile`).set(provider.headers).send({ nope: 1 }), 400, 'VALIDATION_FAILED');
    });

    it('answers in Arabic', async () => {
      const hidden = await makeCategory(db(), { isVisible: false });
      const res = await request(t.http).patch(`${BASE}/profile`).set(provider.headers).set('Accept-Language', 'ar').send({ categoryId: hidden.id });
      expectError(res, 422, 'CATEGORY_HIDDEN');
      expect(res.body.message).toMatch(/[؀-ۿ]/);
    });
  });

  describe('bookings', () => {
    it('lists only my requests', async () => {
      const mine = await makeBooking(db(), { providerId: provider.user.id, clientId: client.user.id, status: BookingStatus.Pending });
      const theirs = await makeBooking(db(), { providerId: otherProvider.user.id, clientId: client.user.id, status: BookingStatus.Pending });

      const res = await request(t.http).get(`${BASE}/bookings?tab=requests&limit=100`).set(provider.headers);

      const ids = res.body.data.map((b: { id: string }) => b.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
    });

    it('accepts a request, issues the invoice and unmasks the client phone', async () => {
      await db().query('UPDATE users SET phone = ? WHERE id = ?', ['+213559990002', client.user.id]);
      const booking = await makeBooking(db(), { providerId: provider.user.id, clientId: client.user.id, status: BookingStatus.Pending, eventDate: '2027-03-20' });

      const res = await request(t.http).post(`${BASE}/bookings/${booking.id}/accept`).set(provider.headers);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('accepted');
      expect(res.body.data.invoice).not.toBeNull();
      expect(res.body.data.counterparty.phone).toBe('+213559990002');
    });

    it('refuses to accept while the profile is under review', async () => {
      const pending = await loginAs(t, UserRole.Provider, { verificationStatus: VerificationStatus.Pending });
      const booking = await makeBooking(db(), { providerId: pending.user.id, clientId: client.user.id, status: BookingStatus.Pending });

      expectError(await request(t.http).post(`${BASE}/bookings/${booking.id}/accept`).set(pending.headers), 422, 'PROVIDER_NOT_VERIFIED');
    });

    it('declines with a reason and refuses an empty one', async () => {
      const booking = await makeBooking(db(), { providerId: provider.user.id, clientId: client.user.id, status: BookingStatus.Pending });
      expectError(await request(t.http).post(`${BASE}/bookings/${booking.id}/decline`).set(provider.headers).send({}), 400, 'VALIDATION_FAILED');

      const res = await request(t.http).post(`${BASE}/bookings/${booking.id}/decline`).set(provider.headers).send({ reason: 'Already booked' });
      expect(res.body.data).toMatchObject({ status: 'declined', declineReason: 'Already booked' });
    });

    it('completes an accepted booking whose event has passed', async () => {
      const booking = await makeBooking(db(), { providerId: provider.user.id, clientId: client.user.id, status: BookingStatus.Accepted, eventDate: '2026-08-01' });
      const res = await request(t.http).post(`${BASE}/bookings/${booking.id}/complete`).set(provider.headers);
      expect(res.body.data.status).toBe('completed');
    });

    it('refuses another provider’s booking and an unknown id', async () => {
      const theirs = await makeBooking(db(), { providerId: otherProvider.user.id, clientId: client.user.id, status: BookingStatus.Pending });
      expectError(await request(t.http).get(`${BASE}/bookings/${theirs.id}`).set(provider.headers), 403, 'NOT_OWNER');
      expectError(await request(t.http).post(`${BASE}/bookings/${theirs.id}/accept`).set(provider.headers), 403, 'NOT_OWNER');
      expectError(await request(t.http).get(`${BASE}/bookings/11111111-1111-4111-8111-111111111111`).set(provider.headers), 404, 'BOOKING_NOT_FOUND');
    });
  });

  describe('services', () => {
    it('creates a draft, edits it and lists it', async () => {
      const created = await request(t.http)
        .post(`${BASE}/services`)
        .set(provider.headers)
        .send({ categoryId, titleEn: 'Photo booth', titleAr: 'كشك التصوير', basePrice: '25000.00', priceType: PriceType.PerEvent, wilayaCodes: [16] });

      expect(created.status).toBe(201);
      expect(created.body.data.status).toBe('draft');
      const [row] = await db().query('SELECT provider_id FROM services WHERE id = ?', [created.body.data.id]);
      expect(row.provider_id).toBe(provider.user.id);

      const edited = await request(t.http).patch(`${BASE}/services/${created.body.data.id}`).set(provider.headers).send({ basePrice: '28000.00' });
      expect(edited.body.data.basePrice).toBe('28000.00');

      const list = await request(t.http).get(`${BASE}/services`).set(provider.headers);
      expect(list.body.data.map((s: { id: string }) => s.id)).toContain(created.body.data.id);
    });

    it('cannot set the owner or the status through the form', async () => {
      const res = await request(t.http)
        .post(`${BASE}/services`)
        .set(provider.headers)
        .send({ categoryId, titleEn: 'X', basePrice: '1000.00', priceType: PriceType.PerEvent, providerId: otherProvider.user.id });
      expectError(res, 400, 'VALIDATION_FAILED');

      const res2 = await request(t.http)
        .post(`${BASE}/services`)
        .set(provider.headers)
        .send({ categoryId, titleEn: 'X', basePrice: '1000.00', priceType: PriceType.PerEvent, status: 'published' });
      expectError(res2, 400, 'VALIDATION_FAILED');
    });

    it('runs the publish checklist and says what is missing', async () => {
      const service = await ownService({ titleAr: '', descriptionAr: '' });
      const res = await request(t.http).post(`${BASE}/services/${service.id}/publish`).set(provider.headers);
      expectError(res, 422, 'SERVICE_PUBLISH_INVALID');
      expect(res.body.details.missing).toEqual(expect.arrayContaining(['titleAr', 'photos']));
    });

    it('publishes and unpublishes a complete service', async () => {
      const service = await ownService();
      const photo = await request(t.http).post(`${BASE}/services/${service.id}/photos`).set(provider.headers).attach('file', PNG, 'cover.png');
      expect(photo.status).toBe(201);

      const published = await request(t.http).post(`${BASE}/services/${service.id}/publish`).set(provider.headers);
      expect(published.body.data.status).toBe('published');

      const unpublished = await request(t.http).post(`${BASE}/services/${service.id}/unpublish`).set(provider.headers);
      expect(unpublished.body.data.status).toBe('draft');
    });

    it('refuses to publish while the profile is under review', async () => {
      const pending = await loginAs(t, UserRole.Provider, { verificationStatus: VerificationStatus.Pending });
      const service = await makeService(db(), { providerId: pending.user.id, categoryId, status: ServiceStatus.Draft });
      expectError(await request(t.http).post(`${BASE}/services/${service.id}/publish`).set(pending.headers), 422, 'PROVIDER_NOT_VERIFIED');
    });

    it('reorders and removes photos, and keeps a published service with one', async () => {
      const service = await ownService();
      await request(t.http).post(`${BASE}/services/${service.id}/photos`).set(provider.headers).attach('file', PNG, 'a.png').expect(201);
      const second = await request(t.http).post(`${BASE}/services/${service.id}/photos`).set(provider.headers).attach('file', PNG, 'b.png');
      const ids = second.body.data.map((p: { id: string }) => p.id);

      const ordered = await request(t.http).patch(`${BASE}/services/${service.id}/photos/order`).set(provider.headers).send({ ids: [...ids].reverse() });
      expect(ordered.body.data[0].id).toBe(ids[1]);

      await request(t.http).post(`${BASE}/services/${service.id}/publish`).set(provider.headers).expect(200);
      await request(t.http).delete(`${BASE}/services/${service.id}/photos/${ids[0]}`).set(provider.headers).expect(200);
      const last = await request(t.http).delete(`${BASE}/services/${service.id}/photos/${ids[1]}`).set(provider.headers);
      expectError(last, 422, 'SERVICE_PUBLISH_INVALID');
    });

    it('refuses a photo with no file and an unknown photo id', async () => {
      const service = await ownService();
      expectError(await request(t.http).post(`${BASE}/services/${service.id}/photos`).set(provider.headers), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).delete(`${BASE}/services/${service.id}/photos/11111111-1111-4111-8111-111111111111`).set(provider.headers), 404, 'PHOTO_NOT_FOUND');
    });

    it('refuses another provider’s service everywhere', async () => {
      const theirs = await makeService(db(), { providerId: otherProvider.user.id, categoryId });
      expectError(await request(t.http).patch(`${BASE}/services/${theirs.id}`).set(provider.headers).send({ basePrice: '1.00' }), 403, 'NOT_OWNER');
      expectError(await request(t.http).post(`${BASE}/services/${theirs.id}/publish`).set(provider.headers), 403, 'NOT_OWNER');
      expectError(await request(t.http).delete(`${BASE}/services/${theirs.id}`).set(provider.headers), 403, 'NOT_OWNER');
      expectError(await request(t.http).post(`${BASE}/services/${theirs.id}/photos`).set(provider.headers).attach('file', PNG, 'x.png'), 403, 'NOT_OWNER');
    });

    it('deletes my own service', async () => {
      const service = await ownService();
      const res = await request(t.http).delete(`${BASE}/services/${service.id}`).set(provider.headers);
      expect(res.status).toBe(200);
      const [row] = await db().query('SELECT deleted_at FROM services WHERE id = ?', [service.id]);
      expect(row.deleted_at).not.toBeNull();
    });
  });

  describe('packs', () => {
    it('creates a pack from my own published services and publishes it', async () => {
      const a = await ownService({ status: ServiceStatus.Published, basePrice: '40000.00' });
      const b = await ownService({ status: ServiceStatus.Published, basePrice: '30000.00' });

      const created = await request(t.http)
        .post(`${BASE}/packs`)
        .set(provider.headers)
        .send({ nameEn: 'Essentiel', nameAr: 'الأساسي', eventType: EventType.Wedding, wilayaCode: 16, price: '60000.00', serviceIds: [a.id, b.id] });

      expect(created.status).toBe(201);
      const [row] = await db().query('SELECT provider_id FROM packs WHERE id = ?', [created.body.data.id]);
      expect(row.provider_id).toBe(provider.user.id);

      const published = await request(t.http).post(`${BASE}/packs/${created.body.data.id}/publish`).set(provider.headers);
      expect(published.body.data.status).toBe('published');

      const list = await request(t.http).get(`${BASE}/packs`).set(provider.headers);
      expect(list.body.data.map((p: { id: string }) => p.id)).toContain(created.body.data.id);
    });

    it('refuses another provider’s services in my pack', async () => {
      const mine = await ownService({ status: ServiceStatus.Published });
      const theirs = await makeService(db(), { providerId: otherProvider.user.id, categoryId, status: ServiceStatus.Published });

      const res = await request(t.http)
        .post(`${BASE}/packs`)
        .set(provider.headers)
        .send({ nameEn: 'Mixed', eventType: EventType.Wedding, wilayaCode: 16, price: '10000.00', serviceIds: [mine.id, theirs.id] });

      expectError(res, 422, 'PACK_SERVICE_OTHER_PROVIDER');
    });

    it('validates the pack form and refuses another provider’s pack', async () => {
      expectError(await request(t.http).post(`${BASE}/packs`).set(provider.headers).send({ nameEn: 'Too small', eventType: EventType.Wedding, wilayaCode: 16, price: '1.00', serviceIds: [] }), 400, 'VALIDATION_FAILED');
      const theirs = await makePack(db(), { providerId: otherProvider.user.id, status: PackStatus.Draft });
      expectError(await request(t.http).patch(`${BASE}/packs/${theirs.id}`).set(provider.headers).send({ price: '1.00' }), 403, 'NOT_OWNER');
      expectError(await request(t.http).delete(`${BASE}/packs/${theirs.id}`).set(provider.headers), 403, 'NOT_OWNER');
    });
  });

  describe('availability', () => {
    it('returns a month and marks a blocked day', async () => {
      const blocked = await request(t.http).post(`${BASE}/availability/blocks`).set(provider.headers).send({ date: '2027-02-14', note: 'Family wedding' });
      expect(blocked.status).toBe(201);

      const month = await request(t.http).get(`${BASE}/availability?month=2027-02`).set(provider.headers);
      expect(month.status).toBe(200);
      expect(month.body.data.days).toHaveLength(28);
      expect(month.body.data.days.find((d: { date: string }) => d.date === '2027-02-14').status).toBe('blocked');

      await request(t.http).delete(`${BASE}/availability/blocks/${blocked.body.data.id}`).set(provider.headers).expect(204);
      const after = await request(t.http).get(`${BASE}/availability?month=2027-02`).set(provider.headers);
      expect(after.body.data.days.find((d: { date: string }) => d.date === '2027-02-14').status).toBe('free');
    });

    it('refuses a past date, a bad month and another provider’s block', async () => {
      expectError(await request(t.http).post(`${BASE}/availability/blocks`).set(provider.headers).send({ date: '2020-01-01' }), 422, 'AVAILABILITY_DATE_PAST');
      expectError(await request(t.http).get(`${BASE}/availability?month=2027-13`).set(provider.headers), 400, 'VALIDATION_FAILED');

      const theirs = await request(t.http).post(`${BASE}/availability/blocks`).set(otherProvider.headers).send({ date: '2027-03-14' });
      expectError(await request(t.http).delete(`${BASE}/availability/blocks/${theirs.body.data.id}`).set(provider.headers), 403, 'NOT_OWNER');
      expectError(await request(t.http).delete(`${BASE}/availability/blocks/11111111-1111-4111-8111-111111111111`).set(provider.headers), 404, 'AVAILABILITY_BLOCK_NOT_FOUND');
    });
  });

  describe('reviews received', () => {
    it('lists my reviews with the author shortened, and replies once', async () => {
      const booking = await makeBooking(db(), { providerId: provider.user.id, clientId: client.user.id, status: BookingStatus.Completed, completedAt: new Date() });
      const review = await makeReview(db(), { bookingId: booking.id, rating: 5, comment: 'Wonderful team.' });

      const list = await request(t.http).get(`${BASE}/reviews`).set(provider.headers);
      expect(list.status).toBe(200);
      const row = list.body.data.find((r: { id: string }) => r.id === review.id);
      expect(row).toBeDefined();
      expect(row.authorName).not.toContain('@');
      expect(row.reply).toBeNull();

      const reply = await request(t.http).post(`/api/v1/app/reviews/${review.id}/reply`).set(provider.headers).send({ body: 'Thank you!' });
      expect(reply.status).toBe(201);

      expectError(await request(t.http).post(`/api/v1/app/reviews/${review.id}/reply`).set(provider.headers).send({ body: 'Again' }), 409, 'REVIEW_REPLY_EXISTS');

      const edited = await request(t.http).patch(`/api/v1/app/reviews/replies/${reply.body.data.id}`).set(provider.headers).send({ body: 'Thanks a lot!' });
      expect(edited.status).toBe(200);
      const [stored] = await db().query('SELECT body FROM review_replies WHERE id = ?', [reply.body.data.id]);
      expect(stored.body).toBe('Thanks a lot!');

      await request(t.http).delete(`/api/v1/app/reviews/replies/${reply.body.data.id}`).set(provider.headers).expect(204);
    });

    it('refuses to reply to another provider’s review, and refuses a client', async () => {
      const booking = await makeBooking(db(), { providerId: otherProvider.user.id, clientId: client.user.id, status: BookingStatus.Completed, completedAt: new Date() });
      const review = await makeReview(db(), { bookingId: booking.id });
      expectError(await request(t.http).post(`/api/v1/app/reviews/${review.id}/reply`).set(provider.headers).send({ body: 'Not mine' }), 403, 'NOT_OWNER');
      expectError(await request(t.http).post(`/api/v1/app/reviews/${review.id}/reply`).set(client.headers).send({ body: 'Wrong role' }), 403, 'FORBIDDEN_ROLE');
    });

    it('refuses to edit a reply after the 48-hour window', async () => {
      const booking = await makeBooking(db(), { providerId: provider.user.id, clientId: client.user.id, status: BookingStatus.Completed, completedAt: new Date() });
      const review = await makeReview(db(), { bookingId: booking.id });
      const reply = await request(t.http).post(`/api/v1/app/reviews/${review.id}/reply`).set(provider.headers).send({ body: 'Thanks' });
      await db().query('UPDATE review_replies SET created_at = DATE_SUB(NOW(6), INTERVAL 3 DAY) WHERE id = ?', [reply.body.data.id]);

      expectError(await request(t.http).patch(`/api/v1/app/reviews/replies/${reply.body.data.id}`).set(provider.headers).send({ body: 'Too late' }), 422, 'REVIEW_EDIT_WINDOW_CLOSED');
    });

    it('404s on an unknown review and reply', async () => {
      expectError(await request(t.http).post('/api/v1/app/reviews/11111111-1111-4111-8111-111111111111/reply').set(provider.headers).send({ body: 'Hi' }), 404, 'REVIEW_NOT_FOUND');
      expectError(await request(t.http).patch('/api/v1/app/reviews/replies/11111111-1111-4111-8111-111111111111').set(provider.headers).send({ body: 'Hi' }), 404, 'REVIEW_REPLY_NOT_FOUND');
    });
  });
});
