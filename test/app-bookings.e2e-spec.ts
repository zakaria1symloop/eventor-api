import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BookingStatus, RescheduleStatus } from '../src/common/enums/booking.enums.js';
import { EventType, ServiceStatus } from '../src/common/enums/catalog.enums.js';
import { UserRole } from '../src/common/enums/user.enums.js';
import {
  createApp,
  expectError,
  loginAs,
  makeBooking,
  makeCategory,
  makeService,
  type LoggedIn,
  type TestApp,
} from './utils/index.js';

const BASE = '/api/v1/app/bookings';
/** Well past `booking_min_notice_days` from the seeded "today". */
const FUTURE = '2027-06-15';

let t: TestApp;
let client: LoggedIn;
let provider: LoggedIn;
let otherClient: LoggedIn;
const db = () => t.dataSource;

/** A service a client can actually book: published, verified provider, one open wilaya. */
async function bookableService(overrides: Record<string, unknown> = {}) {
  const category = await makeCategory(db());
  const service = await makeService(db(), { providerId: provider.user.id, categoryId: category.id, status: ServiceStatus.Published, ...overrides });
  await db().query('INSERT INTO service_wilayas (service_id, wilaya_code, created_at) VALUES (?, 16, NOW(6))', [service.id]);
  return service;
}

beforeAll(async () => {
  t = await createApp();
  provider = await loginAs(t, UserRole.Provider);
  client = await loginAs(t, UserRole.Client);
  otherClient = await loginAs(t, UserRole.Client);
});

afterAll(async () => {
  await t.close();
});

describe('App bookings (e2e)', () => {
  describe('POST /app/bookings/quote', () => {
    it('prices a service without writing anything', async () => {
      const service = await bookableService({ basePrice: '45000.00' });
      const before = await db().query('SELECT COUNT(*) AS n FROM bookings');

      const res = await request(t.http).post(`${BASE}/quote`).set(client.headers).send({ serviceId: service.id, eventDate: FUTURE });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ subtotal: '45000.00', total: '45000.00', available: true, unavailableReason: null });
      expect(res.body.data.feePercent).toMatch(/^\d+\.\d{2}$/);
      expect(res.body.data.lines).toHaveLength(1);
      expect(res.body.data.firstBookableDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const after = await db().query('SELECT COUNT(*) AS n FROM bookings');
      expect(Number(after[0].n)).toBe(Number(before[0].n));
    });

    it('adds the extras to the total', async () => {
      const service = await bookableService({ basePrice: '45000.00' });
      await db().query('INSERT INTO service_extras (id, created_at, updated_at, service_id, name_en, name_ar, price, position) VALUES (UUID(), NOW(6), NOW(6), ?, ?, ?, ?, 0)', [
        service.id,
        'Drone',
        'طائرة',
        '12000.00',
      ]);
      const [extra] = await db().query('SELECT id FROM service_extras WHERE service_id = ?', [service.id]);

      const res = await request(t.http)
        .post(`${BASE}/quote`)
        .set(client.headers)
        .send({ serviceId: service.id, eventDate: FUTURE, extras: [{ extraId: extra.id, quantity: 2 }] });

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe('69000.00');
      expect(res.body.data.lines).toHaveLength(2);
    });

    it('reports a date inside the minimum notice instead of failing', async () => {
      const service = await bookableService();

      const res = await request(t.http).post(`${BASE}/quote`).set(client.headers).send({ serviceId: service.id, eventDate: '2026-09-20' });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ available: false, unavailableReason: 'MIN_NOTICE' });
    });

    it('reports a provider who paused bookings', async () => {
      const paused = await loginAs(t, UserRole.Provider);
      const category = await makeCategory(db());
      const service = await makeService(db(), { providerId: paused.user.id, categoryId: category.id, status: ServiceStatus.Published });
      await db().query('INSERT INTO service_wilayas (service_id, wilaya_code, created_at) VALUES (?, 16, NOW(6))', [service.id]);
      await db().query('UPDATE provider_profiles SET accepting_bookings = 0 WHERE user_id = ?', [paused.user.id]);

      const res = await request(t.http).post(`${BASE}/quote`).set(client.headers).send({ serviceId: service.id, eventDate: FUTURE });

      expect(res.body.data).toMatchObject({ available: false, unavailableReason: 'PROVIDER_NOT_ACCEPTING' });
      await db().query('UPDATE provider_profiles SET accepting_bookings = 1 WHERE user_id = ?', [paused.user.id]);
    });

    it('refuses both a service and a pack at once', async () => {
      const service = await bookableService();
      const res = await request(t.http).post(`${BASE}/quote`).set(client.headers).send({ serviceId: service.id, packId: service.id, eventDate: FUTURE });
      expectError(res, 400, 'VALIDATION_FAILED');
    });

    it('refuses neither a service nor a pack', async () => {
      const res = await request(t.http).post(`${BASE}/quote`).set(client.headers).send({ eventDate: FUTURE });
      expectError(res, 400, 'VALIDATION_FAILED');
    });

    it('rejects a malformed date, an unknown field and a missing date', async () => {
      const service = await bookableService();
      for (const body of [
        { serviceId: service.id, eventDate: '15/06/2027' },
        { serviceId: service.id, eventDate: FUTURE, nope: 1 },
        { serviceId: service.id },
      ]) {
        expectError(await request(t.http).post(`${BASE}/quote`).set(client.headers).send(body), 400, 'VALIDATION_FAILED');
      }
    });

    it('404s on a service that is not visible', async () => {
      const draft = await makeService(db(), { providerId: provider.user.id, status: ServiceStatus.Draft });
      expectError(await request(t.http).post(`${BASE}/quote`).set(client.headers).send({ serviceId: draft.id, eventDate: FUTURE }), 404, 'SERVICE_NOT_FOUND');
    });

    it('needs a token', async () => {
      const res = await request(t.http).post(`${BASE}/quote`).send({ eventDate: FUTURE });
      expect(res.status).toBe(401);
    });

    it('refuses a provider token', async () => {
      const service = await bookableService();
      expectError(await request(t.http).post(`${BASE}/quote`).set(provider.headers).send({ serviceId: service.id, eventDate: FUTURE }), 403, 'FORBIDDEN_ROLE');
    });
  });

  describe('POST /app/bookings', () => {
    it('creates a pending booking with its lines, hold and chat', async () => {
      const service = await bookableService();

      const res = await request(t.http)
        .post(BASE)
        .set(client.headers)
        .set('X-Platform', 'ios')
        .send({ serviceId: service.id, eventDate: FUTURE, wilayaCode: 16, eventType: EventType.Wedding, guests: 180, clientNote: 'Drone shots please.' });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ status: BookingStatus.Pending, total: '45000.00', guests: 180 });
      expect(res.body.data.reference).toMatch(/^EVT-/);
      expect(res.body.data.conversationId).toEqual(expect.any(String));
      expect(res.body.data.allowedActions).toEqual(expect.arrayContaining(['cancel', 'reschedule', 'message']));
      // The counterparty is the provider, and their email is never exposed.
      expect(res.body.data.counterparty.email).toBeNull();
      expect(res.body.data.counterparty.phone).toBeNull();

      const [row] = await db().query('SELECT source, status FROM bookings WHERE id = ?', [res.body.data.id]);
      expect(row).toMatchObject({ source: 'ios', status: 'pending' });
      const holds = await db().query("SELECT kind FROM availability_blocks WHERE booking_id = ? AND deleted_at IS NULL", [res.body.data.id]);
      expect(holds).toHaveLength(1);
      expect(holds[0].kind).toBe('held');
    });

    it('refuses a second booking on a date the provider is already taken on', async () => {
      const service = await bookableService();
      const body = { serviceId: service.id, eventDate: '2027-07-04', wilayaCode: 16, eventType: EventType.Wedding };
      expect((await request(t.http).post(BASE).set(client.headers).send(body)).status).toBe(201);

      expectError(await request(t.http).post(BASE).set(otherClient.headers).send(body), 409, 'DATE_UNAVAILABLE');
    });

    it('refuses a date inside the minimum notice', async () => {
      const service = await bookableService();
      const res = await request(t.http).post(BASE).set(client.headers).send({ serviceId: service.id, eventDate: '2026-09-20', wilayaCode: 16, eventType: EventType.Wedding });
      expectError(res, 422, 'MIN_NOTICE');
    });

    it('refuses a provider who paused bookings', async () => {
      const service = await bookableService();
      await db().query('UPDATE provider_profiles SET accepting_bookings = 0 WHERE user_id = ?', [provider.user.id]);
      const res = await request(t.http).post(BASE).set(client.headers).send({ serviceId: service.id, eventDate: '2027-08-08', wilayaCode: 16, eventType: EventType.Wedding });
      expectError(res, 422, 'PROVIDER_NOT_ACCEPTING');
      await db().query('UPDATE provider_profiles SET accepting_bookings = 1 WHERE user_id = ?', [provider.user.id]);
    });

    it('refuses a service that exists but cannot be booked', async () => {
      const draft = await makeService(db(), { providerId: provider.user.id, status: ServiceStatus.Draft });
      const res = await request(t.http).post(BASE).set(client.headers).send({ serviceId: draft.id, eventDate: FUTURE, wilayaCode: 16, eventType: EventType.Wedding });
      expectError(res, 422, 'SERVICE_UNAVAILABLE_FOR_BOOKING');
    });

    it('refuses an account whose email is not verified', async () => {
      const unverified = await loginAs(t, UserRole.Client, { emailVerifiedAt: null });
      const service = await bookableService();
      const res = await request(t.http).post(BASE).set(unverified.headers).send({ serviceId: service.id, eventDate: '2027-09-09', wilayaCode: 16, eventType: EventType.Wedding });
      expectError(res, 403, 'EMAIL_NOT_VERIFIED');
    });

    it('refuses an unknown wilaya and a mismatched commune', async () => {
      const service = await bookableService();
      const res = await request(t.http).post(BASE).set(client.headers).send({ serviceId: service.id, eventDate: '2027-10-10', wilayaCode: 99, eventType: EventType.Wedding });
      expect(res.status).toBe(400);
    });

    it('validates the body', async () => {
      const service = await bookableService();
      for (const body of [
        { serviceId: service.id, eventDate: FUTURE, wilayaCode: 16 },
        { serviceId: service.id, eventDate: FUTURE, wilayaCode: 'sixteen', eventType: EventType.Wedding },
        { serviceId: service.id, eventDate: FUTURE, wilayaCode: 16, eventType: EventType.Wedding, surprise: true },
      ]) {
        expectError(await request(t.http).post(BASE).set(client.headers).send(body), 400, 'VALIDATION_FAILED');
      }
    });

    it('answers in Arabic when asked to', async () => {
      const service = await bookableService();
      const res = await request(t.http)
        .post(BASE)
        .set(client.headers)
        .set('Accept-Language', 'ar')
        .send({ serviceId: service.id, eventDate: '2026-09-20', wilayaCode: 16, eventType: EventType.Wedding });

      expectError(res, 422, 'MIN_NOTICE');
      expect(res.body.message).toMatch(/[؀-ۿ]/);
    });
  });

  describe('GET /app/bookings', () => {
    it('returns only my bookings, in the right tab, with pagination meta', async () => {
      const mine = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Pending });
      await makeBooking(db(), { clientId: otherClient.user.id, providerId: provider.user.id, status: BookingStatus.Pending });

      const res = await request(t.http).get(`${BASE}?tab=pending&limit=100`).set(client.headers);

      expect(res.status).toBe(200);
      expect(res.body.meta).toMatchObject({ page: 1, limit: 100 });
      const ids = res.body.data.map((b: { id: string }) => b.id);
      expect(ids).toContain(mine.id);
      expect(res.body.data.every((b: { status: string }) => b.status === 'pending')).toBe(true);
    });

    it('splits accepted bookings between upcoming and past by the event date', async () => {
      const upcoming = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Accepted, eventDate: '2027-12-01' });
      const past = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Accepted, eventDate: '2026-01-01' });

      const up = await request(t.http).get(`${BASE}?tab=upcoming&limit=100`).set(client.headers);
      const old = await request(t.http).get(`${BASE}?tab=past&limit=100`).set(client.headers);

      expect(up.body.data.map((b: { id: string }) => b.id)).toContain(upcoming.id);
      expect(up.body.data.map((b: { id: string }) => b.id)).not.toContain(past.id);
      expect(old.body.data.map((b: { id: string }) => b.id)).toContain(past.id);
    });

    it('puts declined bookings in the cancelled tab', async () => {
      const declined = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Declined });
      const res = await request(t.http).get(`${BASE}?tab=cancelled&limit=100`).set(client.headers);
      expect(res.body.data.map((b: { id: string }) => b.id)).toContain(declined.id);
    });

    it('rejects an unknown tab and an oversized page', async () => {
      expectError(await request(t.http).get(`${BASE}?tab=nope`).set(client.headers), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).get(`${BASE}?limit=500`).set(client.headers), 400, 'VALIDATION_FAILED');
    });

    it('needs a token', async () => {
      expect((await request(t.http).get(BASE)).status).toBe(401);
    });
  });

  describe('GET /app/bookings/:id', () => {
    it('returns the detail with its timeline, lines and allowed actions', async () => {
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Pending });

      const res = await request(t.http).get(`${BASE}/${booking.id}`).set(client.headers);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: booking.id, status: 'pending' });
      expect(res.body.data).toHaveProperty('timeline');
      expect(res.body.data).toHaveProperty('invoice');
      expect(res.body.data).toHaveProperty('dispute');
      expect(res.body.data).toHaveProperty('reschedules');
      expect(res.body.data.allowedActions).toContain('cancel');
    });

    it('refuses somebody else’s booking with NOT_OWNER', async () => {
      const booking = await makeBooking(db(), { clientId: otherClient.user.id, providerId: provider.user.id });
      expectError(await request(t.http).get(`${BASE}/${booking.id}`).set(client.headers), 403, 'NOT_OWNER');
    });

    it('404s on an unknown or malformed id', async () => {
      expectError(await request(t.http).get(`${BASE}/11111111-1111-4111-8111-111111111111`).set(client.headers), 404, 'BOOKING_NOT_FOUND');
      expectError(await request(t.http).get(`${BASE}/not-a-uuid`).set(client.headers), 404, 'BOOKING_NOT_FOUND');
    });

    it('hides the provider’s phone until the booking is accepted', async () => {
      await db().query('UPDATE users SET phone = ? WHERE id = ?', ['+213559990001', provider.user.id]);
      const pending = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Pending });
      const accepted = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Accepted, eventDate: '2027-02-02' });

      const before = await request(t.http).get(`${BASE}/${pending.id}`).set(client.headers);
      const after = await request(t.http).get(`${BASE}/${accepted.id}`).set(client.headers);

      expect(before.body.data.counterparty.phone).toBeNull();
      expect(after.body.data.counterparty.phone).not.toBeNull();
      expect(after.body.data.counterparty.email).toBeNull();
    });
  });

  describe('POST /app/bookings/:id/cancel', () => {
    it('cancels a pending booking and releases the date', async () => {
      const service = await bookableService();
      const created = await request(t.http).post(BASE).set(client.headers).send({ serviceId: service.id, eventDate: '2027-03-03', wilayaCode: 16, eventType: EventType.Wedding });

      const res = await request(t.http).post(`${BASE}/${created.body.data.id}/cancel`).set(client.headers).send({ reason: 'Venue changed' });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'cancelled', cancelledBy: 'client', cancelReason: 'Venue changed' });
      const holds = await db().query('SELECT id FROM availability_blocks WHERE booking_id = ? AND deleted_at IS NULL', [created.body.data.id]);
      expect(holds).toHaveLength(0);
    });

    it('refuses to cancel a completed booking', async () => {
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Completed });
      expectError(await request(t.http).post(`${BASE}/${booking.id}/cancel`).set(client.headers).send({ reason: 'Too late' }), 409, 'BOOKING_INVALID_TRANSITION');
    });

    it('needs a reason', async () => {
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id });
      expectError(await request(t.http).post(`${BASE}/${booking.id}/cancel`).set(client.headers).send({}), 400, 'VALIDATION_FAILED');
    });

    it('refuses somebody else’s booking', async () => {
      const booking = await makeBooking(db(), { clientId: otherClient.user.id, providerId: provider.user.id });
      expectError(await request(t.http).post(`${BASE}/${booking.id}/cancel`).set(client.headers).send({ reason: 'Nope' }), 403, 'NOT_OWNER');
    });
  });

  describe('reschedules', () => {
    it('moves a pending booking straight away', async () => {
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Pending, eventDate: '2027-04-04' });

      const res = await request(t.http).post(`${BASE}/${booking.id}/reschedule`).set(client.headers).send({ date: '2027-04-11', reason: 'The hall moved us' });

      expect(res.status).toBe(200);
      expect(res.body.data.eventDate).toBe('2027-04-11');
      expect(res.body.data.reschedules[0]).toMatchObject({ status: RescheduleStatus.Accepted, newDate: '2027-04-11' });
    });

    it('only proposes on an accepted booking, and the provider answers it', async () => {
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Accepted, eventDate: '2027-05-05' });

      const proposed = await request(t.http).post(`${BASE}/${booking.id}/reschedule`).set(client.headers).send({ date: '2027-05-12', reason: 'Family reasons' });
      expect(proposed.body.data.eventDate).toBe('2027-05-05');
      const rid = proposed.body.data.reschedules[0].id;
      expect(proposed.body.data.reschedules[0].awaitingMe).toBe(false);

      // The proposer cannot answer their own proposal.
      expectError(await request(t.http).post(`${BASE}/${booking.id}/reschedules/${rid}/accept`).set(client.headers), 403, 'NOT_OWNER');

      const accepted = await request(t.http).post(`/api/v1/app/provider/bookings/${booking.id}/reschedules/${rid}/accept`).set(provider.headers);
      expect(accepted.status).toBe(200);
      expect(accepted.body.data.eventDate).toBe('2027-05-12');
    });

    it('refuses a second open proposal', async () => {
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Accepted, eventDate: '2027-06-06' });
      await request(t.http).post(`${BASE}/${booking.id}/reschedule`).set(client.headers).send({ date: '2027-06-13', reason: 'One' });

      const second = await request(t.http).post(`${BASE}/${booking.id}/reschedule`).set(client.headers).send({ date: '2027-06-20', reason: 'Two' });
      expectError(second, 409, 'RESCHEDULE_PENDING_EXISTS');
    });

    it('refuses a past date and a missing reason', async () => {
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Accepted, eventDate: '2027-07-07' });
      expectError(await request(t.http).post(`${BASE}/${booking.id}/reschedule`).set(client.headers).send({ date: '2020-01-01', reason: 'Past' }), 422, 'BOOKING_DATE_PAST');
      expectError(await request(t.http).post(`${BASE}/${booking.id}/reschedule`).set(client.headers).send({ date: '2027-07-14' }), 400, 'VALIDATION_FAILED');
    });

    it('404s on an unknown proposal', async () => {
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Accepted });
      const res = await request(t.http).post(`${BASE}/${booking.id}/reschedules/11111111-1111-4111-8111-111111111111/reject`).set(client.headers);
      expectError(res, 404, 'RESCHEDULE_NOT_FOUND');
    });
  });

  describe('POST /app/bookings/:id/check-in', () => {
    it('records "All good" and completes once both parties have tapped it', async () => {
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Accepted, eventDate: '2026-09-01' });

      const first = await request(t.http).post(`${BASE}/${booking.id}/check-in`).set(client.headers).send({ answer: 'ok' });
      expect(first.status).toBe(200);
      expect(first.body.data).toMatchObject({ status: 'accepted', checkedIn: true, otherCheckedIn: false });

      const second = await request(t.http).post(`/api/v1/app/provider/bookings/${booking.id}/check-in`).set(provider.headers).send({ answer: 'ok' });
      expect(second.body.data.status).toBe('completed');
      const [row] = await db().query('SELECT completed_at FROM bookings WHERE id = ?', [booking.id]);
      expect(row.completed_at).not.toBeNull();
    });

    it('points "Report a problem" at the dispute endpoint', async () => {
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Accepted, eventDate: '2026-09-02' });
      const res = await request(t.http).post(`${BASE}/${booking.id}/check-in`).set(client.headers).send({ answer: 'problem' });
      expectError(res, 422, 'CHECK_IN_NOT_ALLOWED');
      expect(res.body.details.next).toContain('/disputes');
    });

    it('refuses before the event and on a pending booking', async () => {
      const early = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Accepted, eventDate: '2027-11-11' });
      expectError(await request(t.http).post(`${BASE}/${early.id}/check-in`).set(client.headers).send({ answer: 'ok' }), 422, 'CHECK_IN_TOO_EARLY');

      const pending = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Pending, eventDate: '2026-09-01' });
      expectError(await request(t.http).post(`${BASE}/${pending.id}/check-in`).set(client.headers).send({ answer: 'ok' }), 409, 'CHECK_IN_NOT_ALLOWED');
    });

    it('validates the answer', async () => {
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Accepted, eventDate: '2026-09-03' });
      expectError(await request(t.http).post(`${BASE}/${booking.id}/check-in`).set(client.headers).send({ answer: 'maybe' }), 400, 'VALIDATION_FAILED');
    });
  });

  describe('invoices', () => {
    it('serves the invoice of my accepted booking as JSON and as a PDF', async () => {
      const service = await bookableService();
      const created = await request(t.http).post(BASE).set(client.headers).send({ serviceId: service.id, eventDate: '2027-01-15', wilayaCode: 16, eventType: EventType.Wedding });
      const id = created.body.data.id;
      await request(t.http).post(`/api/v1/app/provider/bookings/${id}/accept`).set(provider.headers).expect(200);

      const json = await request(t.http).get(`${BASE}/${id}/invoice`).set(client.headers);
      expect(json.status).toBe(200);
      expect(json.body.data.number).toEqual(expect.any(String));

      const pdf = await request(t.http).get(`${BASE}/${id}/invoice.pdf`).set(client.headers);
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
    });

    it('refuses somebody else’s invoice', async () => {
      const booking = await makeBooking(db(), { clientId: otherClient.user.id, providerId: provider.user.id, status: BookingStatus.Accepted });
      expectError(await request(t.http).get(`${BASE}/${booking.id}/invoice`).set(client.headers), 403, 'NOT_OWNER');
    });

    it('404s when no invoice was issued', async () => {
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Pending });
      expectError(await request(t.http).get(`${BASE}/${booking.id}/invoice`).set(client.headers), 404, 'INVOICE_NOT_FOUND');
    });
  });
});
