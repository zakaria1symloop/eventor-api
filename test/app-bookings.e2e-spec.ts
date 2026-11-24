import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BookingStatus, RescheduleStatus } from '../src/common/enums/booking.enums.js';
import { EventType, PriceType, ServiceStatus } from '../src/common/enums/catalog.enums.js';
import { UserRole } from '../src/common/enums/user.enums.js';
import { PackItem } from '../src/packs/entities/pack-item.entity.js';
import {
  createApp,
  expectError,
  loginAs,
  makeBooking,
  makeCategory,
  makePack,
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

    it('prices an overnight per-hour booking across midnight and refuses ambiguous times (#49)', async () => {
      const service = await bookableService({ basePrice: '10000.00', priceType: PriceType.PerHour });
      const quote = (times: Record<string, string>) =>
        request(t.http).post(`${BASE}/quote`).set(client.headers).send({ serviceId: service.id, eventDate: FUTURE, ...times });

      const overnight = await quote({ startTime: '18:00', endTime: '02:00' });
      expect(overnight.status).toBe(200);
      expect(overnight.body.data.lines[0].quantity).toBe(8);
      expect(overnight.body.data.total).toBe('80000.00');

      expectError(await quote({ startTime: '18:00', endTime: '18:00' }), 400, 'VALIDATION_FAILED');
      expectError(await quote({ endTime: '02:00' }), 400, 'VALIDATION_FAILED');
    });

    it('sees a block inside the hours of an overnight booking (#49)', async () => {
      const service = await bookableService();
      await db().query(
        "INSERT INTO availability_blocks (id, created_at, updated_at, provider_id, service_id, date, start_time, end_time, kind, booking_id, note) VALUES (UUID(), NOW(6), NOW(6), ?, NULL, '2027-07-20', '20:00:00', '22:00:00', 'blocked', NULL, NULL)",
        [provider.user.id],
      );
      const quote = (startTime: string, endTime: string) =>
        request(t.http).post(`${BASE}/quote`).set(client.headers).send({ serviceId: service.id, eventDate: '2027-07-20', startTime, endTime });

      expect((await quote('18:00', '02:00')).body.data).toMatchObject({ available: false, unavailableReason: 'DATE_UNAVAILABLE' });
      expect((await quote('22:00', '03:00')).body.data).toMatchObject({ available: true });
      expect((await quote('09:00', '12:00')).body.data).toMatchObject({ available: true });
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

    it('refuses the same client booking the same service twice for overlapping hours (#80)', async () => {
      // Two clients may book the same hours of this one (issues 3 #7), so only the duplicate rule refuses.
      const service = await bookableService({ maxEventsPerDay: 5, concurrentClients: 2 });
      const body = { serviceId: service.id, eventDate: '2027-07-11', startTime: '18:00', endTime: '23:00', wilayaCode: 16, eventType: EventType.Wedding };
      const first = await request(t.http).post(BASE).set(client.headers).send(body);
      expect(first.status).toBe(201);

      const again = await request(t.http).post(BASE).set(client.headers).send({ ...body, startTime: '20:00', endTime: '01:00' });
      expectError(again, 409, 'BOOKING_DUPLICATE');
      expect(again.body.details).toMatchObject({ reference: first.body.data.reference, date: '2027-07-11' });
      // A whole-day request covers every hour of the day.
      expectError(await request(t.http).post(BASE).set(client.headers).send({ ...body, startTime: undefined, endTime: undefined }), 409, 'BOOKING_DUPLICATE');

      // Hours that don't overlap, another client, or a cancelled first booking are fine.
      expect((await request(t.http).post(BASE).set(client.headers).send({ ...body, startTime: '09:00', endTime: '12:00' })).status).toBe(201);
      expect((await request(t.http).post(BASE).set(otherClient.headers).send(body)).status).toBe(201);
      await request(t.http).post(`${BASE}/${first.body.data.id}/cancel`).set(client.headers).send({ reason: 'Changed plans' }).expect(200);
      expect((await request(t.http).post(BASE).set(client.headers).send(body)).status).toBe(201);
    });

    describe('multi-day bookings (issues 3 #11)', () => {
      const range = { eventDate: '2027-09-06', endDate: '2027-09-08' };
      const create = (who: LoggedIn, body: Record<string, unknown>) =>
        request(t.http).post(BASE).set(who.headers).send({ wilayaCode: 16, eventType: EventType.Wedding, ...body });

      it('prices per day, holds every day and blocks the middle day for others', async () => {
        const service = await bookableService({ basePrice: '15000.00', priceType: PriceType.PerDay, maxEventsPerDay: 1 });

        const quote = await request(t.http).post(`${BASE}/quote`).set(client.headers).send({ serviceId: service.id, ...range });
        expect(quote.body.data).toMatchObject({ available: true, days: 3, endDate: '2027-09-08', total: '45000.00' });
        expect(quote.body.data.lines[0].quantity).toBe(3);

        const res = await create(client, { serviceId: service.id, ...range });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ eventDate: '2027-09-06', endDate: '2027-09-08', total: '45000.00' });
        const holds = await db().query("SELECT DATE_FORMAT(date, '%Y-%m-%d') AS d FROM availability_blocks WHERE booking_id = ? AND deleted_at IS NULL ORDER BY date", [res.body.data.id]);
        expect(holds.map((h: { d: string }) => h.d)).toEqual(['2027-09-06', '2027-09-07', '2027-09-08']);

        // Another client on the middle day: the provider is taken (capacity 1 per day).
        expectError(await create(otherClient, { serviceId: service.id, eventDate: '2027-09-07' }), 409, 'DATE_UNAVAILABLE');
        const middle = await request(t.http).post(`${BASE}/quote`).set(otherClient.headers).send({ serviceId: service.id, eventDate: '2027-09-05', endDate: '2027-09-07' });
        expect(middle.body.data).toMatchObject({ available: false, unavailableReason: 'DATE_UNAVAILABLE', unavailableDate: '2027-09-06' });
        // The same client again on an overlapping range of a service with room: duplicate.
        const roomy = await bookableService({ priceType: PriceType.PerDay, maxEventsPerDay: 5 });
        expect((await create(client, { serviceId: roomy.id, ...range })).status).toBe(201);
        expectError(await create(client, { serviceId: roomy.id, eventDate: '2027-09-08', endDate: '2027-09-09' }), 409, 'BOOKING_DUPLICATE');

        // A reschedule keeps the length and moves every hold.
        const moved = await request(t.http).post(`${BASE}/${res.body.data.id}/reschedule`).set(client.headers).send({ date: '2027-09-20', reason: 'Venue moved us' });
        expect(moved.status).toBe(200);
        expect(moved.body.data).toMatchObject({ eventDate: '2027-09-20', endDate: '2027-09-22' });
        const after = await db().query("SELECT DATE_FORMAT(date, '%Y-%m-%d') AS d FROM availability_blocks WHERE booking_id = ? AND deleted_at IS NULL ORDER BY date", [res.body.data.id]);
        expect(after.map((h: { d: string }) => h.d)).toEqual(['2027-09-20', '2027-09-21', '2027-09-22']);
      });

      it('refuses ranges for other price types and packs, over 30 days, and backwards', async () => {
        const perEvent = await bookableService();
        expectError(await create(client, { serviceId: perEvent.id, ...range }), 422, 'MULTI_DAY_NOT_ALLOWED');
        const perDay = await bookableService({ priceType: PriceType.PerDay });
        expectError(await create(client, { serviceId: perDay.id, eventDate: '2027-10-01', endDate: '2027-10-31' }), 422, 'BOOKING_TOO_LONG');
        const backwards = await create(client, { serviceId: perDay.id, eventDate: '2027-10-05', endDate: '2027-10-01' });
        expectError(backwards, 400, 'VALIDATION_FAILED');
        expect(backwards.body.details[0]).toMatchObject({ field: 'endDate', code: 'BEFORE_EVENT_DATE' });
        expectError(await request(t.http).post(`${BASE}/quote`).set(client.headers).send({ serviceId: perEvent.id, ...range }), 422, 'MULTI_DAY_NOT_ALLOWED');
      });

      it('stays in Upcoming until its last day has passed', async () => {
        const yesterday = new Date(Date.now() + 3_600_000 - 86_400_000).toISOString().slice(0, 10);
        const tomorrow = new Date(Date.now() + 3_600_000 + 86_400_000).toISOString().slice(0, 10);
        const ongoing = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Accepted, eventDate: yesterday, endDate: tomorrow } as never);
        const upcoming = await request(t.http).get(`${BASE}?tab=upcoming&limit=100`).set(client.headers);
        expect(upcoming.body.data.map((b: { id: string }) => b.id)).toContain(ongoing.id);
        const card = upcoming.body.data.find((b: { id: string }) => b.id === ongoing.id);
        expect(card).toMatchObject({ eventDate: yesterday, endDate: tomorrow });
        // The event has not ended, so no check-in yet.
        expect(card.allowedActions).not.toContain('check_in');
      });
    });

    describe('service schedule (issues 3 #6, #7, #8)', () => {
      // 2027-07-16 is a Friday (weekday 5), 2027-07-17 a Saturday.
      const FRIDAY = '2027-07-16';
      const book = (who: LoggedIn, body: Record<string, unknown>) =>
        request(t.http).post(BASE).set(who.headers).send({ wilayaCode: 16, eventType: EventType.Wedding, ...body });

      it('needs times inside the weekly hours, overnight included', async () => {
        const service = await bookableService({ maxEventsPerDay: 5, concurrentClients: 5 });
        await db().query("INSERT INTO service_hours (id, created_at, service_id, weekday, start_time, end_time) VALUES (UUID(), NOW(6), ?, 5, '20:00', '02:00')", [service.id]);

        expectError(await book(client, { serviceId: service.id, eventDate: FRIDAY }), 422, 'SERVICE_TIMES_REQUIRED');
        const outside = await book(client, { serviceId: service.id, eventDate: FRIDAY, startTime: '18:00', endTime: '22:00' });
        expectError(outside, 422, 'OUTSIDE_SERVICE_HOURS');
        expect(outside.body.details).toEqual({ weekday: 5, hours: [{ startTime: '20:00', endTime: '02:00' }] });
        // Saturday has no hours: closed.
        expectError(await book(client, { serviceId: service.id, eventDate: '2027-07-17', startTime: '20:00', endTime: '22:00' }), 422, 'OUTSIDE_SERVICE_HOURS');
        expect((await book(client, { serviceId: service.id, eventDate: FRIDAY, startTime: '21:00', endTime: '01:30' })).status).toBe(201);

        // The quote reports the same reasons instead of failing.
        const quote = await request(t.http).post(`${BASE}/quote`).set(client.headers).send({ serviceId: service.id, eventDate: FRIDAY, startTime: '10:00', endTime: '12:00' });
        expect(quote.body.data).toMatchObject({ available: false, unavailableReason: 'OUTSIDE_SERVICE_HOURS' });
      });

      it('lets several clients book the same hours when "Allow several clients at the same time" is ticked', async () => {
        const shared = await bookableService({ maxEventsPerDay: null, concurrentClients: null });
        const third = await loginAs(t, UserRole.Client);
        const slot = { serviceId: shared.id, eventDate: '2027-07-27', startTime: '18:00', endTime: '22:00' };
        for (const who of [client, otherClient, third]) {
          expect((await book(who, slot)).status).toBe(201);
        }
        const detail = await request(t.http).get(`/api/v1/app/services/${shared.id}`);
        expect(detail.body.data).toMatchObject({ allowSimultaneous: true, concurrentClients: null });
        // Bookings never take the hours away: the whole day stays free.
        const month = await request(t.http).get(`/api/v1/app/services/${shared.id}/availability?month=2027-07`);
        expect(month.body.data.days.find((d: { date: string }) => d.date === '2027-07-27')).toMatchObject({
          state: 'available',
          freeRanges: [{ startTime: '00:00', endTime: '00:00' }],
        });

        // Unticked (the default): the second client on the same hours is refused.
        const single = await bookableService({ maxEventsPerDay: null });
        expect((await book(client, { ...slot, serviceId: single.id })).status).toBe(201);
        expectError(await book(otherClient, { ...slot, serviceId: single.id }), 409, 'SLOT_UNAVAILABLE');
      });

      it('takes any number of bookings a day when "Only one booking per day" is unticked', async () => {
        const unlimited = await bookableService({ maxEventsPerDay: null });
        const third = await loginAs(t, UserRole.Client);
        for (const who of [client, otherClient, third]) {
          expect((await book(who, { serviceId: unlimited.id, eventDate: '2027-07-25' })).status).toBe(201);
        }
        const detail = await request(t.http).get(`/api/v1/app/services/${unlimited.id}`);
        expect(detail.body.data).toMatchObject({ onePerDay: false, maxEventsPerDay: null });
        const month = await request(t.http).get(`/api/v1/app/services/${unlimited.id}/availability?month=2027-07`);
        expect(month.body.data.maxEventsPerDay).toBeNull();
        expect(month.body.data.days.find((d: { date: string }) => d.date === '2027-07-25').state).toBe('available');

        // Ticked: the second booking of the day is refused.
        const onePerDay = await bookableService({ maxEventsPerDay: 1 });
        expect((await book(client, { serviceId: onePerDay.id, eventDate: '2027-07-26' })).status).toBe(201);
        expectError(await book(otherClient, { serviceId: onePerDay.id, eventDate: '2027-07-26' }), 409, 'DATE_UNAVAILABLE');
      });

      it('lets "clients at the same time" book overlapping hours, then refuses SLOT_UNAVAILABLE', async () => {
        const service = await bookableService({ maxEventsPerDay: 5, concurrentClients: 2 });
        const third = await loginAs(t, UserRole.Client);
        const slot = { serviceId: service.id, eventDate: '2027-07-18', startTime: '18:00', endTime: '22:00' };

        expect((await book(client, slot)).status).toBe(201);
        expect((await book(otherClient, { ...slot, startTime: '20:00', endTime: '23:00' })).status).toBe(201);
        const full = await book(third, { ...slot, startTime: '21:00', endTime: '22:30' });
        expectError(full, 409, 'SLOT_UNAVAILABLE');
        expect(full.body.details).toMatchObject({ date: '2027-07-18' });
        // Hours nobody has taken twice are still free; whole-day bookings only count against maxEventsPerDay.
        expect((await book(third, { ...slot, startTime: '09:00', endTime: '12:00' })).status).toBe(201);
        const fourth = await loginAs(t, UserRole.Client);
        expect((await book(fourth, { serviceId: service.id, eventDate: '2027-07-18' })).status).toBe(201);
      });

      describe('one client per time slot (BUG-M2, acceptance M-08 / M-09)', () => {
        const PROVIDER = '/api/v1/app/provider/bookings';
        const time = (hhmm: string) => `${hhmm}:00`;

        it('creates only one of two requests for the same slot sent at the same moment (M-08)', async () => {
          const service = await bookableService({ maxEventsPerDay: null, concurrentClients: 1 });
          const slot = { serviceId: service.id, eventDate: '2027-08-06', startTime: '18:00', endTime: '20:00' };

          // Sent together: before the fix both were created, the second one reading a stale snapshot.
          const [first, second] = await Promise.all([book(client, slot), book(otherClient, slot)]);

          expect([first.status, second.status].sort()).toEqual([201, 409]);
          expectError([first, second].find((r) => r.status === 409)!, 409, 'SLOT_UNAVAILABLE');
          const [row] = await db().query("SELECT COUNT(*) AS n FROM bookings WHERE service_id = ? AND status = 'pending'", [service.id]);
          expect(Number(row.n)).toBe(1);
        });

        it('refuses to accept a second overlapping request and drops `accept` from it (M-09)', async () => {
          const service = await bookableService({ maxEventsPerDay: null, concurrentClients: 1 });
          // Two pending requests on the same hours, as left by the race above on live (EVT-000147 / 148).
          const base = { providerId: provider.user.id, serviceId: service.id, status: BookingStatus.Pending, eventDate: '2027-08-04', startTime: time('18:00'), endTime: time('20:00') };
          const first = await makeBooking(db(), { ...base, clientId: client.user.id });
          const second = await makeBooking(db(), { ...base, clientId: otherClient.user.id });
          // Same day, other hours: still acceptable.
          const later = await makeBooking(db(), { ...base, clientId: otherClient.user.id, startTime: time('20:00'), endTime: time('23:00') });

          const before = await request(t.http).get(`${PROVIDER}/${second.id}`).set(provider.headers);
          expect(before.body.data.allowedActions).toContain('accept');

          expect((await request(t.http).post(`${PROVIDER}/${first.id}/accept`).set(provider.headers)).status).toBe(200);

          const refused = await request(t.http).post(`${PROVIDER}/${second.id}/accept`).set(provider.headers);
          expectError(refused, 409, 'SLOT_UNAVAILABLE');
          expect(refused.body.details).toMatchObject({ date: '2027-08-04', startTime: '18:00', endTime: '20:00' });
          const [row] = await db().query('SELECT status FROM bookings WHERE id = ?', [second.id]);
          expect(row.status).toBe(BookingStatus.Pending);

          const detail = await request(t.http).get(`${PROVIDER}/${second.id}`).set(provider.headers);
          expect(detail.body.data.allowedActions).not.toContain('accept');
          expect(detail.body.data.allowedActions).toContain('decline');
          const list = await request(t.http).get(`${PROVIDER}?tab=requests&limit=100`).set(provider.headers);
          const card = list.body.data.find((b: { id: string }) => b.id === second.id);
          expect(card.allowedActions).not.toContain('accept');

          // Touching hours (20:00 → 23:00 after 18:00 → 20:00) don't overlap.
          expect((await request(t.http).post(`${PROVIDER}/${later.id}/accept`).set(provider.headers)).status).toBe(200);
          // Once the accepted one is cancelled, the second can be accepted again.
          expect((await request(t.http).post(`${PROVIDER}/${first.id}/cancel`).set(provider.headers).send({ reason: 'Moved' })).status).toBe(200);
          expect((await request(t.http).post(`${PROVIDER}/${second.id}/accept`).set(provider.headers)).status).toBe(200);
        });

        it('stops accept, decline and reschedule on an expired request once booking_auto_expire is on (BUG-F1)', async () => {
          const service = await bookableService({ maxEventsPerDay: null, concurrentClients: 1 });
          const admin = await loginAs(t, UserRole.Admin);
          const setAutoExpire = (on: boolean) =>
            request(t.http).patch('/api/v1/admin/settings').set(admin.headers).send({ values: { booking_auto_expire: on }, confirm: true }).expect(200);
          const old = { providerId: provider.user.id, serviceId: service.id, clientId: client.user.id, status: BookingStatus.Pending, eventDate: '2027-08-09', createdAt: new Date(Date.now() - 49 * 3_600_000) };
          const expired = await makeBooking(db(), old as never);
          const another = await makeBooking(db(), { ...old, eventDate: '2027-08-10' } as never);

          // Off (the default): nothing changes for old requests.
          const before = await request(t.http).get(`${PROVIDER}/${expired.id}`).set(provider.headers);
          expect(before.body.data.allowedActions).toEqual(expect.arrayContaining(['accept', 'decline', 'reschedule']));

          await setAutoExpire(true);
          try {
            const detail = await request(t.http).get(`${PROVIDER}/${expired.id}`).set(provider.headers);
            expect(detail.body.data.status).toBe('pending');
            for (const action of ['accept', 'decline', 'reschedule']) expect(detail.body.data.allowedActions).not.toContain(action);
            const mine = await request(t.http).get(`${BASE}/${expired.id}`).set(client.headers);
            expect(mine.body.data.allowedActions).not.toContain('reschedule');
            expect(mine.body.data.allowedActions).toContain('cancel');

            expectError(await request(t.http).post(`${PROVIDER}/${expired.id}/accept`).set(provider.headers), 409, 'BOOKING_EXPIRED');
            expectError(await request(t.http).post(`${PROVIDER}/${expired.id}/decline`).set(provider.headers).send({ reason: 'Too late' }), 409, 'BOOKING_EXPIRED');
            expectError(await request(t.http).post(`${BASE}/${expired.id}/reschedule`).set(client.headers).send({ date: '2027-08-20', reason: 'Moving the party' }), 409, 'BOOKING_EXPIRED');
            // The client can still withdraw it.
            expect((await request(t.http).post(`${BASE}/${expired.id}/cancel`).set(client.headers).send({ reason: 'No answer' })).status).toBe(200);
          } finally {
            await setAutoExpire(false);
          }
          // Off again: the old request is accepted as before.
          expect((await request(t.http).post(`${PROVIDER}/${another.id}/accept`).set(provider.headers)).status).toBe(200);
        });

        it('lets one of five clients sending the same slot together win, with no server error', async () => {
          const service = await bookableService({ maxEventsPerDay: null, concurrentClients: 1 });
          const others = await Promise.all([1, 2, 3].map(() => loginAs(t, UserRole.Client)));
          const slot = { serviceId: service.id, eventDate: '2027-08-07', startTime: '18:00', endTime: '20:00' };

          const results = await Promise.all([client, otherClient, ...others].map((who) => book(who, slot)));

          expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
          for (const r of results.filter((r) => r.status === 409)) expectError(r, 409, 'SLOT_UNAVAILABLE');
        });

        it('accepts only one of two overlapping requests accepted at the same moment', async () => {
          const service = await bookableService({ maxEventsPerDay: null, concurrentClients: 1 });
          const base = { providerId: provider.user.id, serviceId: service.id, status: BookingStatus.Pending, eventDate: '2027-08-08', startTime: time('18:00'), endTime: time('20:00') };
          const first = await makeBooking(db(), { ...base, clientId: client.user.id });
          const second = await makeBooking(db(), { ...base, clientId: otherClient.user.id });

          const results = await Promise.all([first, second].map((b) => request(t.http).post(`${PROVIDER}/${b.id}/accept`).set(provider.headers)));

          expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
          expectError(results.find((r) => r.status === 409)!, 409, 'SLOT_UNAVAILABLE');
          const rows = await db().query('SELECT status FROM bookings WHERE id IN (?)', [[first.id, second.id]]);
          expect(rows.map((r: { status: string }) => r.status).sort()).toEqual(['accepted', 'pending']);
        });

        it('applies the same rule to a pack that contains the service, and to the admin status change', async () => {
          const service = await bookableService({ maxEventsPerDay: null, concurrentClients: 1 });
          const pack = await makePack(db(), { providerId: provider.user.id });
          await db().getRepository(PackItem).insert({ packId: pack.id, serviceId: service.id, position: 0 });
          const base = { providerId: provider.user.id, status: BookingStatus.Pending, eventDate: '2027-08-05', startTime: time('18:00'), endTime: time('20:00') };
          const single = await makeBooking(db(), { ...base, serviceId: service.id, clientId: client.user.id });
          const packed = await makeBooking(db(), { ...base, packId: pack.id, serviceId: null, clientId: otherClient.user.id, startTime: time('19:00'), endTime: time('21:00') });

          expect((await request(t.http).post(`${PROVIDER}/${packed.id}/accept`).set(provider.headers)).status).toBe(200);
          expectError(await request(t.http).post(`${PROVIDER}/${single.id}/accept`).set(provider.headers), 409, 'SLOT_UNAVAILABLE');

          // The dashboard goes through the same transition.
          const admin = await loginAs(t, UserRole.Admin);
          const res = await request(t.http).post(`/api/v1/admin/bookings/${single.id}/status`).set(admin.headers).send({ status: 'accepted', note: 'QA M-09', notify: false });
          expectError(res, 409, 'SLOT_UNAVAILABLE');
        });
      });

      it('only takes event dates inside the period, and leaves the catalog after it', async () => {
        const service = await bookableService({ availableFrom: '2027-07-01', availableUntil: '2027-07-31' });
        const outside = await book(client, { serviceId: service.id, eventDate: '2027-08-01' });
        expectError(outside, 422, 'OUTSIDE_SERVICE_PERIOD');
        expect(outside.body.details).toEqual({ availableFrom: '2027-07-01', availableUntil: '2027-07-31' });
        expect((await book(client, { serviceId: service.id, eventDate: '2027-07-20' })).status).toBe(201);

        const ended = await bookableService({ availableUntil: '2020-01-01' });
        expectError(await request(t.http).get(`/api/v1/app/services/${ended.id}`), 404, 'SERVICE_NOT_FOUND');
      });
    });

    it('refuses an end without a start and an end equal to the start (#49)', async () => {
      const service = await bookableService();
      const body = { serviceId: service.id, eventDate: '2027-07-12', wilayaCode: 16, eventType: EventType.Wedding };

      const noStart = await request(t.http).post(BASE).set(client.headers).send({ ...body, endTime: '02:00' });
      expectError(noStart, 400, 'VALIDATION_FAILED');
      expect(noStart.body.details[0]).toMatchObject({ field: 'startTime', code: 'REQUIRED_WITH_END' });
      const equal = await request(t.http).post(BASE).set(client.headers).send({ ...body, startTime: '18:00', endTime: '18:00' });
      expectError(equal, 400, 'VALIDATION_FAILED');
      expect(equal.body.details[0]).toMatchObject({ field: 'endTime', code: 'SAME_AS_START' });
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

    it('carries the service category on the card, and null for a pack booking (#21)', async () => {
      const category = await makeCategory(db(), { nameEn: 'Photography', nameAr: 'التصوير' });
      const service = await bookableService({ categoryId: category.id });
      const booked = await request(t.http)
        .post(BASE)
        .set(client.headers)
        .send({ serviceId: service.id, eventDate: '2027-09-09', eventType: EventType.Wedding, wilayaCode: 16 })
        .expect(201);
      expect(booked.body.data.category).toMatchObject({ id: category.id, slug: expect.any(String), nameEn: 'Photography', nameAr: 'التصوير' });

      const list = await request(t.http).get(`${BASE}?tab=pending&limit=100`).set(client.headers);
      const card = list.body.data.find((b: { id: string }) => b.id === booked.body.data.id);
      expect(card.category).toMatchObject({ id: category.id });

      const pack = await makePack(db(), { providerId: provider.user.id });
      const packBooking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, serviceId: null, packId: pack.id, status: BookingStatus.Pending });
      const detail = await request(t.http).get(`${BASE}/${packBooking.id}`).set(client.headers).expect(200);
      expect(detail.body.data.category).toBeNull();
      expect(detail.body.data.eventType).toBeDefined();
    });

    it('lets the client withdraw their own pending reschedule proposal (#11)', async () => {
      const service = await bookableService();
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, serviceId: service.id, status: BookingStatus.Accepted, eventDate: '2027-10-10' });
      const proposed = await request(t.http).post(`${BASE}/${booking.id}/reschedule`).set(client.headers).send({ date: '2027-10-17', reason: 'Venue moved our date' }).expect(200);
      const rid = proposed.body.data.reschedules[0].id;

      // The provider (not the proposer) cannot withdraw it — they answer instead.
      expectError(await request(t.http).post(`/api/v1/app/provider/bookings/${booking.id}/reschedules/${rid}/withdraw`).set(provider.headers), 403, 'NOT_OWNER');
      // A stranger cannot touch the booking at all.
      expectError(await request(t.http).post(`${BASE}/${booking.id}/reschedules/${rid}/withdraw`).set(otherClient.headers), 403, 'NOT_OWNER');

      const withdrawn = await request(t.http).post(`${BASE}/${booking.id}/reschedules/${rid}/withdraw`).set(client.headers).expect(200);
      expect(withdrawn.body.data.reschedules[0]).toMatchObject({ id: rid, status: RescheduleStatus.Cancelled });
      expect(withdrawn.body.data.eventDate).toBe('2027-10-10');
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

    describe('a per-hour price follows the new hours (BUG-E3, acceptance E-24)', () => {
      const PROVIDER = '/api/v1/app/provider/bookings';
      const book = (body: Record<string, unknown>) => request(t.http).post(BASE).set(client.headers).send({ wilayaCode: 16, eventType: EventType.Wedding, ...body });
      const serviceLine = (detail: { lines: { kind: string }[] }) => detail.lines.find((l) => l.kind === 'service');
      const notesFor = (userId: string, type: string, bookingId: string) =>
        db().query("SELECT body FROM notifications WHERE user_id = ? AND type = ? AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.bookingId')) = ?", [userId, type, bookingId]);

      it('shows the new total on the proposal, and accepting it bills 5 h at the agreed rate and reissues the invoice', async () => {
        const service = await bookableService({ basePrice: '6000.00', priceType: PriceType.PerHour, maxEventsPerDay: null, concurrentClients: 1 });
        const created = await book({ serviceId: service.id, eventDate: '2027-09-03', startTime: '18:00', endTime: '22:00' });
        expect(created.status).toBe(201);
        expect(created.body.data.total).toBe('24000.00');
        const id = created.body.data.id;
        await request(t.http).post(`${PROVIDER}/${id}/accept`).set(provider.headers).expect(200);
        // The provider raises the service price afterwards: the rate agreed on the booking still applies.
        await db().query('UPDATE services SET base_price = ? WHERE id = ?', ['9000.00', service.id]);

        const proposed = await request(t.http).post(`${BASE}/${id}/reschedule`).set(client.headers).send({ date: '2027-09-10', startTime: '18:00', endTime: '23:00', reason: 'Longer party' });
        expect(proposed.status).toBe(200);
        expect(proposed.body.data.total).toBe('24000.00');
        expect(proposed.body.data.reschedules[0]).toMatchObject({ status: RescheduleStatus.Pending, oldTotal: '24000.00', newTotal: '30000.00' });
        const [proposalNote] = await notesFor(provider.user.id, 'booking.reschedule_proposed', id);
        expect(proposalNote.body).toContain('30000.00');

        const rid = proposed.body.data.reschedules[0].id;
        const accepted = await request(t.http).post(`${PROVIDER}/${id}/reschedules/${rid}/accept`).set(provider.headers);
        expect(accepted.status).toBe(200);
        expect(accepted.body.data).toMatchObject({ eventDate: '2027-09-10', startTime: '18:00', endTime: '23:00', subtotal: '30000.00', total: '30000.00' });
        expect(serviceLine(accepted.body.data)).toMatchObject({ quantity: 5, unitAmount: '6000.00', amount: '30000.00' });
        expect(accepted.body.data.invoice).toMatchObject({ version: 2, total: '30000.00', voided: false });
        expect(accepted.body.data.reschedules[0]).toMatchObject({ status: RescheduleStatus.Accepted, oldTotal: '24000.00', newTotal: '30000.00' });
        const changes = await db().query('SELECT old_total, new_total FROM booking_price_changes WHERE booking_id = ?', [id]);
        expect(changes).toEqual([{ old_total: '24000.00', new_total: '30000.00' }]);
        const [movedNote] = await notesFor(client.user.id, 'booking.rescheduled', id);
        expect(movedNote.body).toContain('30000.00');
      });

      it('applies the new total straight away when a pending request is moved, and tells the client', async () => {
        const service = await bookableService({ basePrice: '6000.00', priceType: PriceType.PerHour, maxEventsPerDay: null, concurrentClients: 1 });
        const created = await book({ serviceId: service.id, eventDate: '2027-09-17', startTime: '18:00', endTime: '22:00' });
        const id = created.body.data.id;

        const moved = await request(t.http).post(`${PROVIDER}/${id}/reschedule`).set(provider.headers).send({ date: '2027-09-17', startTime: '17:00', endTime: '22:00', reason: 'Setup earlier' });

        expect(moved.status).toBe(200);
        expect(moved.body.data).toMatchObject({ status: 'pending', startTime: '17:00', total: '30000.00' });
        expect(serviceLine(moved.body.data)).toMatchObject({ quantity: 5, amount: '30000.00' });
        expect(moved.body.data.invoice).toBeNull();
        const [note] = await notesFor(client.user.id, 'booking.rescheduled', id);
        expect(note.body).toContain('24000.00');
        expect(note.body).toContain('30000.00');
      });

      it('keeps the price of a flat-priced service and of the same number of hours', async () => {
        const flat = await bookableService({ basePrice: '45000.00', priceType: PriceType.PerEvent, maxEventsPerDay: null, concurrentClients: 1 });
        const a = await book({ serviceId: flat.id, eventDate: '2027-09-24', startTime: '18:00', endTime: '22:00' });
        const movedFlat = await request(t.http).post(`${PROVIDER}/${a.body.data.id}/reschedule`).set(provider.headers).send({ date: '2027-09-24', startTime: '18:00', endTime: '23:00', reason: 'Later' });
        expect(movedFlat.body.data.total).toBe('45000.00');
        expect(movedFlat.body.data.reschedules[0]).toMatchObject({ oldTotal: '45000.00', newTotal: '45000.00' });

        const hourly = await bookableService({ basePrice: '6000.00', priceType: PriceType.PerHour, maxEventsPerDay: null, concurrentClients: 1 });
        const b = await book({ serviceId: hourly.id, eventDate: '2027-09-24', startTime: '18:00', endTime: '22:00' });
        const sameLength = await request(t.http).post(`${PROVIDER}/${b.body.data.id}/reschedule`).set(provider.headers).send({ date: '2027-10-01', startTime: '19:00', endTime: '23:00', reason: 'Other day' });
        expect(sameLength.body.data.total).toBe('24000.00');

        expect(await db().query('SELECT id FROM booking_price_changes WHERE booking_id IN (?)', [[a.body.data.id, b.body.data.id]])).toHaveLength(0);
      });
    });

    it('reissues the invoice when what it prints changes — the day or the hours — and only then (BUG-E5, E-23)', async () => {
      const PROVIDER = '/api/v1/app/provider/bookings';
      const service = await bookableService({ basePrice: '45000.00', priceType: PriceType.PerEvent, maxEventsPerDay: null, concurrentClients: 1 });
      const created = await request(t.http).post(BASE).set(client.headers).send({ serviceId: service.id, eventDate: '2027-10-08', startTime: '18:00', endTime: '22:00', wilayaCode: 16, eventType: EventType.Wedding });
      const id = created.body.data.id;
      await request(t.http).post(`${PROVIDER}/${id}/accept`).set(provider.headers).expect(200);
      const v1 = (await request(t.http).get(`${BASE}/${id}/invoice`).set(client.headers).expect(200)).body.data;
      expect(v1).toMatchObject({ version: 1, eventDate: '2027-10-08', endDate: null, startTime: '18:00', endTime: '22:00' });

      const move = async (body: Record<string, unknown>) => {
        const proposed = await request(t.http).post(`${BASE}/${id}/reschedule`).set(client.headers).send({ reason: 'Move', ...body }).expect(200);
        const rid = proposed.body.data.reschedules.find((r: { status: string }) => r.status === 'pending').id;
        await request(t.http).post(`${PROVIDER}/${id}/reschedules/${rid}/accept`).set(provider.headers).expect(200);
        return (await request(t.http).get(`${BASE}/${id}/invoice`).set(client.headers).expect(200)).body.data;
      };

      // Same day and same hours: nothing printed on the invoice changed.
      expect(await move({ date: '2027-10-08', startTime: '18:00', endTime: '22:00' })).toMatchObject({ version: 1, number: v1.number });

      // Same day, later hours, flat price: the hours are printed, so a new version.
      const v2 = await move({ date: '2027-10-08', startTime: '19:00', endTime: '23:00' });
      expect(v2).toMatchObject({ version: 2, eventDate: '2027-10-08', startTime: '19:00', endTime: '23:00', total: '45000.00' });
      expect(v2.number).not.toBe(v1.number);

      const v3 = await move({ date: '2027-10-15' });
      expect(v3).toMatchObject({ version: 3, eventDate: '2027-10-15', versions: [1, 2, 3] });
      const live = await db().query('SELECT version FROM invoices WHERE booking_id = ? AND deleted_at IS NULL', [id]);
      expect(live).toEqual([{ version: 3 }]);
    });

    it('404s on an unknown proposal', async () => {
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Accepted });
      const res = await request(t.http).post(`${BASE}/${booking.id}/reschedules/11111111-1111-4111-8111-111111111111/reject`).set(client.headers);
      expectError(res, 404, 'RESCHEDULE_NOT_FOUND');
    });
  });

  describe('chat system messages (BUG-G2, G-09 / M-05 / N-09 / O-07)', () => {
    it('every booking event leaves a linked message, in each reader’s language', async () => {
      const PROVIDER = '/api/v1/app/provider/bookings';
      const service = await bookableService({ titleEn: 'Wedding DJ', titleAr: 'دي جي للأعراس', maxEventsPerDay: null, concurrentClients: 1 });
      const created = await request(t.http).post(BASE).set(client.headers).send({ serviceId: service.id, eventDate: '2027-11-05', startTime: '18:00', endTime: '22:00', wilayaCode: 16, eventType: EventType.Wedding });
      const id = created.body.data.id;
      await request(t.http).post(`${PROVIDER}/${id}/accept`).set(provider.headers).expect(200);
      const proposed = await request(t.http).post(`${BASE}/${id}/reschedule`).set(client.headers).send({ date: '2027-11-12', reason: 'Hall moved' }).expect(200);
      await request(t.http).post(`${PROVIDER}/${id}/reschedules/${proposed.body.data.reschedules[0].id}/reject`).set(provider.headers).expect(200);
      await request(t.http).post(`${BASE}/${id}/cancel`).set(client.headers).send({ reason: 'Changed plans' }).expect(200);
      const conversationId = created.body.data.conversationId;

      // One chat per client–provider pair: other bookings of the pair post here too, so keep this booking's messages.
      const thread = async (who: LoggedIn, lang: string) =>
        (await request(t.http).get(`/api/v1/app/conversations/${conversationId}/messages?limit=100`).set(who.headers).set('Accept-Language', lang).expect(200)).body.data.filter(
          (m: { kind: string; system: { bookingId: string } | null }) => m.kind === 'system' && m.system?.bookingId === id,
        );
      const mine = await thread(client, 'ar');
      expect(mine.map((m: { system: { event: string } }) => m.system.event)).toEqual([
        'booking_requested',
        'booking_accepted',
        'reschedule_proposed',
        'reschedule_declined',
        'booking_cancelled',
      ]);
      expect(mine.every((m: { system: { bookingId: string } }) => m.system.bookingId === id)).toBe(true);
      expect(mine[0].body).toBe(`تم طلب الحجز ${created.body.data.reference} بتاريخ 5 نوفمبر 2027 (18:00–22:00): دي جي للأعراس.`);
      expect(mine[4].body).toBe(`ألغى العميل الحجز ${created.body.data.reference}.`);
      expect(mine.map((m: { body: string }) => m.body).join(' ')).not.toMatch(/\d{4}-\d{2}-\d{2}/);

      const theirs = await thread(provider, 'en');
      expect(theirs[2].body).toBe(`The client proposed to move booking ${created.body.data.reference} to 12 November 2027 (18:00–22:00).`);
      expect(theirs[2].system.params).toMatchObject({ actor: 'client', oldDate: '2027-11-05', newDate: '2027-11-12', titleAr: 'دي جي للأعراس' });
    });
  });

  describe('after the event is over (BUG-E6, acceptance E-25)', () => {
    const PROVIDER = '/api/v1/app/provider/bookings';
    /** Africa/Algiers (UTC+1) today plus `n` days. */
    const algiersDay = (n: number) => new Date(Date.now() + 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);

    it('drops cancel and reschedule on both sides, and both endpoints answer 409 BOOKING_EVENT_OVER', async () => {
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Accepted, eventDate: algiersDay(-2), startTime: '18:00:00', endTime: '22:00:00' } as never);

      const mine = (await request(t.http).get(`${BASE}/${booking.id}`).set(client.headers).expect(200)).body.data.allowedActions;
      expect(mine).not.toContain('cancel');
      expect(mine).not.toContain('reschedule');
      expect(mine).toEqual(expect.arrayContaining(['message', 'invoice', 'check_in']));
      const theirs = (await request(t.http).get(`${PROVIDER}/${booking.id}`).set(provider.headers).expect(200)).body.data.allowedActions;
      expect(theirs).not.toContain('cancel');
      expect(theirs).not.toContain('reschedule');
      expect(theirs).toEqual(expect.arrayContaining(['message', 'invoice', 'check_in', 'complete']));

      // A client calling the endpoints directly gets the same answer as the missing buttons.
      expectError(await request(t.http).post(`${BASE}/${booking.id}/cancel`).set(client.headers).send({ reason: 'Too late' }), 409, 'BOOKING_EVENT_OVER');
      expectError(await request(t.http).post(`${BASE}/${booking.id}/reschedule`).set(client.headers).send({ date: FUTURE, reason: 'Again' }), 409, 'BOOKING_EVENT_OVER');
      expectError(await request(t.http).post(`${PROVIDER}/${booking.id}/cancel`).set(provider.headers).send({ reason: 'Too late' }), 409, 'BOOKING_EVENT_OVER');
      expectError(await request(t.http).post(`${PROVIDER}/${booking.id}/reschedule`).set(provider.headers).send({ date: FUTURE, reason: 'Again' }), 409, 'BOOKING_EVENT_OVER');
      const [row] = await db().query('SELECT status FROM bookings WHERE id = ?', [booking.id]);
      expect(row.status).toBe(BookingStatus.Accepted);
      expect(await db().query('SELECT id FROM booking_reschedules WHERE booking_id = ?', [booking.id])).toHaveLength(0);

      // What belongs after the event still works.
      const done = await request(t.http).post(`${PROVIDER}/${booking.id}/complete`).set(provider.headers);
      expect(done.status).toBe(200);
      expect(done.body.data.status).toBe(BookingStatus.Completed);
    });

    it('still allows both while a multi-day event is running (until its last day ends)', async () => {
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Accepted, eventDate: algiersDay(-1), endDate: algiersDay(1) });

      const mine = (await request(t.http).get(`${BASE}/${booking.id}`).set(client.headers).expect(200)).body.data.allowedActions;
      expect(mine).toEqual(expect.arrayContaining(['cancel', 'reschedule']));

      const res = await request(t.http).post(`${PROVIDER}/${booking.id}/cancel`).set(provider.headers).send({ reason: 'Storm' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(BookingStatus.Cancelled);
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

    it('keeps the Arabic names on the price lines and the invoice, whatever language booked (BUG-O2, O-07 / O-09)', async () => {
      const service = await bookableService({ titleEn: 'Wedding DJ', titleAr: 'دي جي للأعراس', basePrice: '45000.00' });
      await db().query('INSERT INTO service_extras (id, created_at, updated_at, service_id, name_en, name_ar, price, position) VALUES (UUID(), NOW(6), NOW(6), ?, ?, ?, ?, 0)', [service.id, 'Smoke machine', 'آلة الدخان', '5000.00']);
      const [extra] = await db().query('SELECT id FROM service_extras WHERE service_id = ?', [service.id]);
      // Booked from an app in English.
      const created = await request(t.http).post(BASE).set(client.headers).set('Accept-Language', 'en')
        .send({ serviceId: service.id, eventDate: '2027-01-22', wilayaCode: 16, eventType: EventType.Wedding, extras: [{ extraId: extra.id, quantity: 1 }] });
      const id = created.body.data.id;
      await request(t.http).post(`/api/v1/app/provider/bookings/${id}/accept`).set(provider.headers).expect(200);

      const inArabic = (await request(t.http).get(`${BASE}/${id}`).set(client.headers).set('Accept-Language', 'ar').expect(200)).body.data;
      expect(inArabic.lines.map((l: { label: string }) => l.label)).toEqual(['دي جي للأعراس', 'آلة الدخان']);
      expect(inArabic.lines[0]).toMatchObject({ labelEn: 'Wedding DJ', labelAr: 'دي جي للأعراس' });
      const inEnglish = (await request(t.http).get(`${BASE}/${id}`).set(client.headers).set('Accept-Language', 'en').expect(200)).body.data;
      expect(inEnglish.lines.map((l: { label: string }) => l.label)).toEqual(['Wedding DJ', 'Smoke machine']);

      const invoice = (await request(t.http).get(`${BASE}/${id}/invoice`).set(client.headers).expect(200)).body.data;
      expect(invoice.lines.map((l: { label: string; labelAr: string }) => [l.label, l.labelAr])).toEqual([
        ['Wedding DJ', 'دي جي للأعراس'],
        ['Smoke machine', 'آلة الدخان'],
      ]);
      const pdf = await request(t.http).get(`${BASE}/${id}/invoice.pdf`).set(client.headers);
      expect(pdf.status).toBe(200);
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
