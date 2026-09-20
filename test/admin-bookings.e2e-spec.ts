import { EventEmitter2 } from '@nestjs/event-emitter';
import request from 'supertest';
import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { BookingJobsService } from '../src/bookings/booking-jobs.service.js';
import { Booking } from '../src/bookings/entities/booking.entity.js';
import { Invoice } from '../src/bookings/entities/invoice.entity.js';
import { BookingDisputeStatus, BookingSource, BookingStatus } from '../src/common/enums/booking.enums.js';
import { EventType, PackStatus, PriceType, ServiceStatus } from '../src/common/enums/catalog.enums.js';
import { UserRole } from '../src/common/enums/user.enums.js';
import { ExportRegistry } from '../src/exports/export-registry.js';
import { MailService } from '../src/mail/mail.service.js';
import { PackItem } from '../src/packs/entities/pack-item.entity.js';
import { ServiceExtra } from '../src/services/entities/service-extra.entity.js';
import type { Service } from '../src/services/entities/service.entity.js';
import {
  createApp,
  expectError,
  loginAs,
  makeBooking,
  makeCategory,
  makeCommune,
  makePack,
  makeProvider,
  makeService,
  makeUser,
  uid,
  type LoggedIn,
  type TestApp,
} from './utils/index.js';

const BASE = '/api/v1/admin/bookings';
const MISSING = '00000000-0000-4000-8000-000000000000';
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** A future date far enough for min notice, unique per call so providers never collide. */
let dayCounter = 0;
const futureDate = () => {
  dayCounter += 1;
  return new Date(Date.UTC(2031, 0, 1) + dayCounter * DAY).toISOString().slice(0, 10);
};

describe('Admin bookings (e2e)', () => {
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
  const reload = (id: string) => db().getRepository(Booking).findOneByOrFail({ id });
  const lastMailTo = (email: string) => [...t.get(MailService).outbox].reverse().find((m) => m.to === email);
  const recordEvents = (name: string) => {
    const seen: any[] = [];
    const listener = (payload: unknown) => seen.push(payload);
    t.get(EventEmitter2).on(name, listener);
    return { seen, stop: () => t.get(EventEmitter2).off(name, listener) };
  };

  /** A verified provider with a published service in Algiers (visible in the app). */
  async function bookable(options: { price?: string; maxEventsPerDay?: number; priceType?: PriceType; accepting?: boolean } = {}) {
    const { user: provider, profile } = await makeProvider(db(), { profile: { acceptingBookings: options.accepting ?? true } });
    const service = await makeService(db(), {
      providerId: provider.id,
      basePrice: options.price ?? '45000.00',
      maxEventsPerDay: options.maxEventsPerDay ?? 1,
      priceType: options.priceType ?? PriceType.PerEvent,
    });
    await db().query('INSERT INTO service_wilayas (service_id, wilaya_code, created_at) VALUES (?, 16, NOW())', [service.id]);
    const client = await makeUser(db());
    return { provider, profile, service, client };
  }

  const create = (body: Record<string, unknown>) => request(t.http).post(BASE).set(admin.headers).send(body);
  const setStatus = (id: string, body: Record<string, unknown>) => request(t.http).post(`${BASE}/${id}/status`).set(admin.headers).send({ note: 'Checked with both parties.', notify: true, ...body });

  async function createPending(ctx?: Awaited<ReturnType<typeof bookable>>, overrides: Record<string, unknown> = {}) {
    const c = ctx ?? (await bookable());
    const res = await create({ clientId: c.client.id, serviceId: c.service.id, eventDate: futureDate(), eventType: 'wedding', wilayaCode: 16, ...overrides }).expect(201);
    return { ...c, booking: res.body.data };
  }

  async function createAccepted(ctx?: Awaited<ReturnType<typeof bookable>>, overrides: Record<string, unknown> = {}) {
    const pending = await createPending(ctx, overrides);
    await setStatus(pending.booking.id, { status: 'accepted' }).expect(200);
    return pending;
  }

  // ── create ──────────────────────────────────────────────────

  describe('POST /admin/bookings', () => {
    it('creates a pending service booking: lines, totals, fee, held availability, conversation, status row, audit, event, email', async () => {
      const ctx = await bookable({ price: '45000.00' });
      const extra = await db().getRepository(ServiceExtra).save({ serviceId: ctx.service.id, nameEn: 'Drone footage', nameAr: 'تصوير جوي', price: '7500.00', position: 0 });
      const commune = await makeCommune(db(), { wilayaCode: 16 });
      const created = recordEvents('booking.created');
      const date = futureDate();
      const res = await create({
        clientId: ctx.client.id,
        serviceId: ctx.service.id,
        eventDate: date,
        startTime: '18:00',
        endTime: '23:30',
        eventType: 'wedding',
        wilayaCode: 16,
        communeId: commune.id,
        locationText: 'Salle Yasmine, Hydra',
        guests: 150,
        clientNote: 'Photos at the entrance.',
        extras: [{ extraId: extra.id, quantity: 2 }],
      }).expect(201);
      created.stop();

      const b = res.body.data;
      expect(b).toMatchObject({
        reference: expect.stringMatching(/^EVT-\d{6}$/),
        status: 'pending',
        disputeStatus: 'none',
        source: 'dashboard',
        eventDate: date,
        startTime: '18:00',
        endTime: '23:30',
        guests: 150,
        total: '60000.00',
        subtotal: '60000.00',
        discountTotal: '0.00',
        feePercent: '10.00',
        feeAmount: '6000.00',
        providerAmount: '54000.00',
        noReply: false,
        service: { id: ctx.service.id },
        pack: null,
        client: { id: ctx.client.id, bookingsCount: 1 },
        provider: { id: ctx.provider.id },
        commune: { id: commune.id },
        createdBy: { id: admin.user.id },
        invoice: null,
        pendingReschedule: null,
        dispute: null,
      });
      expect(b.lines.map((l: any) => [l.kind, l.quantity, l.unitAmount, l.amount])).toEqual([
        ['service', 1, '45000.00', '45000.00'],
        ['extra', 2, '7500.00', '15000.00'],
      ]);
      expect(b.allowedTransitions.map((x: any) => x.action)).toEqual(['accepted', 'declined', 'cancelled']);
      expect(b.timeline).toEqual([expect.objectContaining({ type: 'status', fromStatus: null, toStatus: 'pending', actor: { id: admin.user.id, fullName: admin.user.fullName } })]);
      expect(b.conversation).toMatchObject({ kind: 'direct', lastMessages: [expect.objectContaining({ kind: 'system', senderLabel: 'Eventor' })] });
      expect(b.history[0]).toMatchObject({ action: 'booking.created', actor: { id: admin.user.id } });

      const [held] = await db().query('SELECT kind, date FROM availability_blocks WHERE booking_id = ? AND deleted_at IS NULL', [b.id]);
      expect(held.kind).toBe('held');
      const participants = await db().query('SELECT user_id, role FROM conversation_participants WHERE conversation_id = ? ORDER BY role', [b.conversation.id]);
      expect(participants).toEqual([
        { user_id: ctx.client.id, role: 'client' },
        { user_id: ctx.provider.id, role: 'provider' },
      ]);
      expect(await audited('booking.created', b.id)).not.toBeNull();
      expect(created.seen).toEqual([{ bookingId: b.id, reference: b.reference, clientId: ctx.client.id, providerId: ctx.provider.id, notify: true }]);
      expect(lastMailTo(ctx.provider.email)!.subject).toBe(`New booking request ${b.reference}`);

      // Same pair: the direct conversation is reused and points at the latest booking.
      const second = await create({ clientId: ctx.client.id, serviceId: ctx.service.id, eventDate: futureDate(), eventType: 'wedding', wilayaCode: 16 }).expect(201);
      expect(second.body.data.conversation.id).toBe(b.conversation.id);
      const [conversation] = await db().query('SELECT booking_id FROM conversations WHERE id = ?', [b.conversation.id]);
      expect(conversation.booking_id).toBe(second.body.data.id);

      // By reference too
      const byRef = await request(t.http).get(`${BASE}/${b.reference}`).set(admin.headers).expect(200);
      expect(byRef.body.data.id).toBe(b.id);
    });

    it('creates a pack booking with pack lines and the pack fee', async () => {
      const { user: provider } = await makeProvider(db());
      const s1 = await makeService(db(), { providerId: provider.id, basePrice: '250000.00' });
      const s2 = await makeService(db(), { providerId: provider.id, basePrice: '175000.00' });
      const pack = await makePack(db(), { providerId: provider.id, price: '380000.00', status: PackStatus.Published, nameEn: 'Essentiel' });
      await db().getRepository(PackItem).insert([
        { packId: pack.id, serviceId: s1.id, position: 0 },
        { packId: pack.id, serviceId: s2.id, position: 1 },
      ]);
      await db().query("UPDATE settings SET value = '12' WHERE `key` = 'pack_fee_percent'");
      const client = await makeUser(db());
      try {
        const res = await create({ clientId: client.id, packId: pack.id, eventDate: futureDate(), eventType: 'wedding', wilayaCode: 16 }).expect(201);
        expect(res.body.data).toMatchObject({ pack: { id: pack.id, nameEn: 'Essentiel' }, service: null, subtotal: '425000.00', discountTotal: '45000.00', total: '380000.00', offer: { kind: 'pack' } });
        expect(res.body.data.lines.map((l: any) => l.kind)).toEqual(['pack_service', 'pack_service', 'discount']);
        expect(['10.00', '12.00']).toContain(res.body.data.feePercent);
      } finally {
        await db().query("UPDATE settings SET value = '10' WHERE `key` = 'pack_fee_percent'");
      }
    });

    it('uses the price type for the quantity (per person × guests)', async () => {
      const ctx = await bookable({ price: '1500.00', priceType: PriceType.PerPerson });
      const res = await create({ clientId: ctx.client.id, serviceId: ctx.service.id, eventDate: futureDate(), eventType: 'wedding', wilayaCode: 16, guests: 200 }).expect(201);
      expect(res.body.data.lines[0]).toMatchObject({ quantity: 200, amount: '300000.00' });
    });

    it('400 for missing fields, both or none of service/pack, wrong types and unknown fields', async () => {
      const ctx = await bookable();
      const base = { clientId: ctx.client.id, serviceId: ctx.service.id, eventDate: futureDate(), eventType: 'wedding', wilayaCode: 16 };
      for (const field of ['clientId', 'eventDate', 'eventType', 'wilayaCode']) {
        const body: Record<string, unknown> = { ...base };
        delete body[field];
        const res = await create(body);
        expectError(res, 400, 'VALIDATION_FAILED');
        expect(res.body.details.map((d: any) => d.field)).toContain(field);
      }
      expectError(await create({ ...base, serviceId: undefined }), 400, 'VALIDATION_FAILED');
      expectError(await create({ ...base, packId: MISSING }), 400, 'VALIDATION_FAILED');
      expectError(await create({ ...base, eventDate: '20/12/2031' }), 400, 'VALIDATION_FAILED');
      expectError(await create({ ...base, startTime: '25:00' }), 400, 'VALIDATION_FAILED');
      expectError(await create({ ...base, guests: 'many' }), 400, 'VALIDATION_FAILED');
      expectError(await create({ ...base, total: '1.00' }), 400, 'VALIDATION_FAILED');
    });

    it('401 without a token, 403 for a client token', async () => {
      expectError(await request(t.http).get(BASE), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).post(BASE).set(client.headers).send({}), 403, 'FORBIDDEN_ROLE');
    });

    it('404 and 422 guards (client, service / pack visibility, accepting, min notice, extras, commune)', async () => {
      const ctx = await bookable();
      const base = { clientId: ctx.client.id, serviceId: ctx.service.id, eventDate: futureDate(), eventType: 'wedding', wilayaCode: 16 };
      expectError(await create({ ...base, clientId: MISSING }), 404, 'USER_NOT_FOUND');
      expectError(await create({ ...base, clientId: ctx.provider.id }), 422, 'NOT_A_CLIENT');
      expectError(await create({ ...base, serviceId: MISSING }), 404, 'SERVICE_NOT_FOUND');
      expectError(await create({ ...base, serviceId: undefined, packId: MISSING }), 404, 'PACK_NOT_FOUND');
      expectError(await create({ ...base, wilayaCode: 16, communeId: MISSING }), 404, 'COMMUNE_NOT_FOUND');
      expectError(await create({ ...base, academicRequestId: MISSING }), 404, 'ACADEMIC_REQUEST_NOT_FOUND');

      const draft = await makeService(db(), { providerId: ctx.provider.id, status: ServiceStatus.Draft });
      expectError(await create({ ...base, serviceId: draft.id }), 422, 'SERVICE_UNAVAILABLE_FOR_BOOKING');
      const draftPack = await makePack(db(), { providerId: ctx.provider.id, status: PackStatus.Draft });
      expectError(await create({ ...base, serviceId: undefined, packId: draftPack.id }), 422, 'PACK_UNAVAILABLE');

      const closed = await bookable({ accepting: false });
      expectError(await create({ ...base, clientId: closed.client.id, serviceId: closed.service.id }), 422, 'PROVIDER_NOT_ACCEPTING');

      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers' }).format(new Date());
      const tooSoon = await create({ ...base, eventDate: today }).set('Accept-Language', 'ar');
      expectError(tooSoon, 422, 'MIN_NOTICE');
      expect(tooSoon.body.message).toMatch(/^يجب أن يكون تاريخ المناسبة في \d{4}-\d{2}-\d{2} أو بعده\.$/);

      const other = await bookable();
      const foreignExtra = await db().getRepository(ServiceExtra).save({ serviceId: other.service.id, nameEn: 'X', nameAr: 'س', price: '1.00', position: 0 });
      expectError(await create({ ...base, extras: [{ extraId: foreignExtra.id, quantity: 1 }] }), 422, 'BOOKING_EXTRA_INVALID');
      const oran = await makeCommune(db(), { wilayaCode: 31 });
      expectError(await create({ ...base, communeId: oran.id }), 422, 'COMMUNE_WILAYA_MISMATCH');
      expect(await db().getRepository(Booking).countBy({ clientId: ctx.client.id })).toBe(0);
    });

    it('409 DATE_UNAVAILABLE at max_events_per_day or on a blocked day (row lock); capacity 2 allows a second event', async () => {
      const single = await bookable({ maxEventsPerDay: 1 });
      const date = futureDate();
      const body = { clientId: single.client.id, serviceId: single.service.id, eventDate: date, eventType: 'wedding', wilayaCode: 16 };
      // Two concurrent requests for the last slot: exactly one wins.
      const [a, b] = await Promise.all([create(body), create(body)]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expectError(a.status === 409 ? a : b, 409, 'DATE_UNAVAILABLE');

      const double = await bookable({ maxEventsPerDay: 2 });
      const body2 = { clientId: double.client.id, serviceId: double.service.id, eventDate: date, eventType: 'wedding', wilayaCode: 16 };
      await create(body2).expect(201);
      await create(body2).expect(201);
      expectError(await create(body2), 409, 'DATE_UNAVAILABLE');

      const blocked = await bookable();
      const blockedDate = futureDate();
      await db().query("INSERT INTO availability_blocks (id, created_at, updated_at, provider_id, date, kind) VALUES (UUID(), NOW(), NOW(), ?, ?, 'blocked')", [blocked.provider.id, blockedDate]);
      expectError(await create({ clientId: blocked.client.id, serviceId: blocked.service.id, eventDate: blockedDate, eventType: 'wedding', wilayaCode: 16 }), 409, 'DATE_UNAVAILABLE');
      // A partial block does not block a booking at other hours.
      const partialDate = futureDate();
      await db().query("INSERT INTO availability_blocks (id, created_at, updated_at, provider_id, date, start_time, end_time, kind) VALUES (UUID(), NOW(), NOW(), ?, ?, '09:00:00', '12:00:00', 'blocked')", [blocked.provider.id, partialDate]);
      await create({ clientId: blocked.client.id, serviceId: blocked.service.id, eventDate: partialDate, startTime: '18:00', endTime: '22:00', eventType: 'wedding', wilayaCode: 16 }).expect(201);
      expectError(
        await create({ clientId: blocked.client.id, serviceId: blocked.service.id, eventDate: partialDate, startTime: '11:00', endTime: '13:00', eventType: 'wedding', wilayaCode: 16 }),
        409,
        'DATE_UNAVAILABLE',
      );
    });
  });

  // ── list & detail ───────────────────────────────────────────

  describe('GET /admin/bookings', () => {
    let tag: string;
    let providerId: string;
    let serviceId: string;
    let categoryId: string;
    let rows: Booking[];

    beforeAll(async () => {
      tag = uid();
      const category = await makeCategory(db());
      categoryId = category.id;
      const { user: provider } = await makeProvider(db(), { user: { fullName: `Karim ${tag}` } });
      providerId = provider.id;
      const service: Service = await makeService(db(), { providerId, categoryId, titleEn: `Coverage ${tag}` });
      serviceId = service.id;
      const amina = await makeUser(db(), { fullName: `Amina ${tag}` });
      const karima = await makeUser(db(), { fullName: `Karima ${tag}` });
      const common = { serviceId, providerId };
      rows = [
        await makeBooking(db(), { ...common, clientId: amina.id, reference: `EVT-9${tag.slice(0, 5).replace(/\D/g, '1').padEnd(5, '1')}`, status: BookingStatus.Pending, eventDate: '2031-03-01', total: '45000.00', createdAt: new Date(Date.now() - 72 * HOUR) } as never),
        await makeBooking(db(), { ...common, clientId: amina.id, status: BookingStatus.Pending, eventDate: '2031-03-02', total: '50000.00', createdAt: new Date(Date.now() - 2 * HOUR), source: BookingSource.Ios } as never),
        await makeBooking(db(), { ...common, clientId: karima.id, status: BookingStatus.Accepted, eventDate: '2031-02-01', total: '120000.00', wilayaCode: 31, disputeStatus: BookingDisputeStatus.Open, createdAt: new Date(Date.now() - 10 * DAY) } as never),
        await makeBooking(db(), { ...common, clientId: karima.id, status: BookingStatus.Completed, eventDate: '2030-01-01', total: '30000.00', createdAt: new Date(Date.now() - 400 * DAY) } as never),
        await makeBooking(db(), { ...common, clientId: amina.id, status: BookingStatus.Declined, eventDate: '2031-04-01', total: '10000.00', createdAt: new Date(Date.now() - 5 * DAY) } as never),
        await makeBooking(db(), { ...common, clientId: karima.id, status: BookingStatus.Cancelled, eventDate: '2031-05-01', total: '99000.00', createdAt: new Date(Date.now() - 6 * DAY) } as never),
      ];
    });

    const list = (query: Record<string, unknown> = {}) => request(t.http).get(BASE).query({ providerId, ...query }).set(admin.headers);
    const refs = (res: request.Response) => res.body.data.map((r: any) => r.id);

    it('lists with tab counters, noReply and the row shape', async () => {
      const res = await list({ sort: 'eventDate:asc' }).expect(200);
      expect(res.body.meta).toEqual({
        page: 1,
        limit: 20,
        total: 6,
        totalPages: 1,
        counts: { all: 6, pending: 2, accepted: 1, completed: 1, declined: 1, cancelled: 1, disputed: 1, noReply: 1 },
      });
      expect(refs(res)).toEqual([rows[3]!.id, rows[2]!.id, rows[0]!.id, rows[1]!.id, rows[4]!.id, rows[5]!.id]);
      const row = res.body.data.find((r: any) => r.id === rows[0]!.id);
      expect(Object.keys(row).sort()).toEqual(
        ['client', 'createdAt', 'disputeStatus', 'endTime', 'eventDate', 'eventType', 'guests', 'id', 'noReply', 'pack', 'provider', 'reference', 'respondedAt', 'service', 'source', 'startTime', 'status', 'total', 'wilaya'].sort(),
      );
      expect(row).toMatchObject({ noReply: true, service: { id: serviceId, titleEn: `Coverage ${tag}` }, client: { fullName: `Amina ${tag}`, avatarUrl: null }, provider: { id: providerId, fullName: `Karim ${tag}` } });
    });

    it('filters by tab, noReply, parties, dates, amounts, wilaya, source, dispute, category and search; sorts; paginates', async () => {
      expect(refs(await list({ tab: 'pending' }))).toHaveLength(2);
      expect(refs(await list({ tab: 'pending', noReply: true }))).toEqual([rows[0]!.id]);
      expect(refs(await list({ tab: 'disputed' }))).toEqual([rows[2]!.id]);
      expect(refs(await list({ disputeStatus: 'open' }))).toEqual([rows[2]!.id]);
      expect((await list({ clientId: rows[2]!.clientId })).body.meta.total).toBe(3);
      expect((await list({ serviceId })).body.meta.total).toBe(6);
      expect((await list({ categoryId })).body.meta.total).toBe(6);
      expect((await list({ packId: MISSING })).body.meta.total).toBe(0);
      expect(refs(await list({ wilaya: 31 }))).toEqual([rows[2]!.id]);
      expect(refs(await list({ eventDateFrom: '2031-03-01', eventDateTo: '2031-03-31', sort: 'eventDate:asc' }))).toEqual([rows[0]!.id, rows[1]!.id]);
      const today = new Date().toISOString().slice(0, 10);
      expect((await list({ createdFrom: today, createdTo: today })).body.meta.total).toBe(1);
      expect(refs(await list({ amountMin: 90000, sort: 'total:desc' }))).toEqual([rows[2]!.id, rows[5]!.id]);
      expect(refs(await list({ amountMax: 10000 }))).toEqual([rows[4]!.id]);
      expect(refs(await list({ source: 'ios' }))).toEqual([rows[1]!.id]);
      expect((await list({ q: `Karima ${tag}` })).body.meta.total).toBe(3);
      expect((await list({ q: `Coverage ${tag}` })).body.meta.total).toBe(6);
      expect(refs(await list({ q: `#${rows[0]!.reference.toLowerCase()}` }))).toEqual([rows[0]!.id]);
      const page = await list({ limit: 4, page: 2, sort: 'createdAt:desc' }).expect(200);
      expect(page.body.meta).toMatchObject({ page: 2, limit: 4, total: 6, totalPages: 2 });
      expect(refs(page)).toEqual([rows[2]!.id, rows[3]!.id]);
      expectError(await list({ sort: 'reference:asc' }), 400, 'SORT_FIELD_NOT_ALLOWED');
      expectError(await list({ tab: 'nope' }), 400, 'VALIDATION_FAILED');
      expectError(await list({ eventDateFrom: 'yesterday' }), 400, 'VALIDATION_FAILED');
    });

    it('exports are registered for bookings', () => {
      expect(t.get(ExportRegistry).get('bookings')).toBeDefined();
    });

    it('404 for unknown ids and references', async () => {
      expectError(await request(t.http).get(`${BASE}/${MISSING}`).set(admin.headers), 404, 'BOOKING_NOT_FOUND');
      expectError(await request(t.http).get(`${BASE}/EVT-999999`).set(admin.headers), 404, 'BOOKING_NOT_FOUND');
      expectError(await request(t.http).get(`${BASE}/not-an-id`).set(admin.headers), 404, 'BOOKING_NOT_FOUND');
    });
  });

  // ── status ──────────────────────────────────────────────────

  describe('POST /admin/bookings/:id/status', () => {
    it('accepts: booked availability, invoice v1 with PDF, chat system message, audit, event and emails', async () => {
      const { booking, client, provider } = await createPending();
      const accepted = recordEvents('booking.accepted');
      const res = await setStatus(booking.id, { status: 'accepted' }).expect(200);
      accepted.stop();
      expect(res.body.data).toMatchObject({ status: 'accepted', respondedAt: expect.any(String), invoice: { version: 1, number: expect.stringMatching(/^INV-\d{4}-\d{4,}$/), pdfReady: true } });
      expect(res.body.data.allowedTransitions.map((x: any) => x.action)).toEqual(['cancelled', 'completed']);
      expect(res.body.data.timeline.at(-1)).toMatchObject({ fromStatus: 'pending', toStatus: 'accepted', note: 'Checked with both parties.', notified: true });
      const [row] = await db().query('SELECT kind FROM availability_blocks WHERE booking_id = ? AND deleted_at IS NULL', [booking.id]);
      expect(row.kind).toBe('booked');
      expect(res.body.data.conversation.lastMessages.at(-1).body).toMatch(/accepted\. Contact details are now visible/);
      expect((await audited('booking.status_changed', booking.id))!.changes).toMatchObject({ status: { from: 'pending', to: 'accepted' } });
      expect(accepted.seen[0]).toMatchObject({ bookingId: booking.id, from: 'pending', to: 'accepted', notify: true });
      expect(lastMailTo(client.email)!.subject).toBe(`Booking ${booking.reference} accepted`);
      expect(lastMailTo(provider.email)!.subject).toBe(`Booking ${booking.reference} accepted`);
    });

    it('re-checks the date on accept (409 DATE_UNAVAILABLE)', async () => {
      const ctx = await bookable({ maxEventsPerDay: 1 });
      const pending = await createPending(ctx);
      // Another booking took the slot directly in the database (e.g. provider app).
      await db().query("UPDATE availability_blocks SET deleted_at = NOW() WHERE booking_id = ?", [pending.booking.id]);
      const other = await makeBooking(db(), { serviceId: ctx.service.id, providerId: ctx.provider.id, status: BookingStatus.Accepted, eventDate: pending.booking.eventDate });
      await db().query("INSERT INTO availability_blocks (id, created_at, updated_at, provider_id, date, kind, booking_id) VALUES (UUID(), NOW(), NOW(), ?, ?, 'booked', ?)", [ctx.provider.id, pending.booking.eventDate, other.id]);
      expectError(await setStatus(pending.booking.id, { status: 'accepted' }), 409, 'DATE_UNAVAILABLE');
      expect((await reload(pending.booking.id)).status).toBe('pending');
    });

    it('declines and cancels (availability released, invoice voided, cancelledBy); notify false sends nothing', async () => {
      const declined = await createPending();
      await setStatus(declined.booking.id, { status: 'declined', reason: 'date_unavailable' }).expect(200);
      expect(await reload(declined.booking.id)).toMatchObject({ status: 'declined', declineReason: 'date_unavailable' });
      expect(Number((await db().query('SELECT COUNT(*) AS n FROM availability_blocks WHERE booking_id = ? AND deleted_at IS NULL', [declined.booking.id]))[0].n)).toBe(0);

      const accepted = await createAccepted();
      const outbox = t.get(MailService).outbox.length;
      const cancelled = recordEvents('booking.cancelled');
      const res = await setStatus(accepted.booking.id, { status: 'cancelled', reason: 'client_changed_plans', cancelledBy: 'client', notify: false }).expect(200);
      cancelled.stop();
      expect(res.body.data).toMatchObject({ status: 'cancelled', cancelledBy: 'client', cancelReason: 'client_changed_plans', invoice: null });
      expect(await db().getRepository(Invoice).countBy({ bookingId: accepted.booking.id })).toBe(0);
      expect(await db().getRepository(Invoice).count({ where: { bookingId: accepted.booking.id }, withDeleted: true })).toBe(1);
      expect(cancelled.seen[0]).toMatchObject({ cancelledBy: 'client', notify: false });
      expect(t.get(MailService).outbox.length).toBe(outbox);
      expect((await audited('booking.status_changed', accepted.booking.id))).not.toBeNull();
    });

    it('completes (counters, early completion flagged) and reopens (counters back)', async () => {
      const ctx = await bookable();
      const { booking } = await createAccepted(ctx);
      const res = await setStatus(booking.id, { status: 'completed', reason: 'event_done' }).expect(200);
      expect(res.body.data).toMatchObject({ status: 'completed', completedAt: expect.any(String), allowedTransitions: [{ action: 'reopen', to: 'accepted' }] });
      const counters = async () => (await db().query('SELECT s.bookings_count AS s, pp.completed_bookings_count AS p FROM services s JOIN provider_profiles pp ON pp.user_id = s.provider_id WHERE s.id = ?', [ctx.service.id]))[0];
      expect(await counters()).toEqual({ s: 1, p: 1 });
      const log = await db().getRepository(AuditLog).find({ where: { action: 'booking.status_changed', objectId: booking.id }, order: { createdAt: 'DESC' } });
      expect(log[0]!.changes).toMatchObject({ earlyCompletion: true });

      await setStatus(booking.id, { status: 'reopen', reason: 'dispute_reopened' }).expect(200);
      expect(await reload(booking.id)).toMatchObject({ status: 'accepted', completedAt: null });
      expect(await counters()).toEqual({ s: 0, p: 0 });
    });

    it('409 BOOKING_INVALID_TRANSITION for every move the matrix forbids', async () => {
      const cases: [BookingStatus, string][] = [
        [BookingStatus.Pending, 'completed'],
        [BookingStatus.Pending, 'reopen'],
        [BookingStatus.Accepted, 'accepted'],
        [BookingStatus.Accepted, 'declined'],
        [BookingStatus.Completed, 'cancelled'],
        [BookingStatus.Completed, 'accepted'],
        [BookingStatus.Declined, 'accepted'],
        [BookingStatus.Cancelled, 'reopen'],
      ];
      for (const [status, action] of cases) {
        const booking = await makeBooking(db(), { status, eventDate: '2031-12-01' });
        const res = await setStatus(booking.id, { status: action, reason: 'x' });
        expectError(res, 409, 'BOOKING_INVALID_TRANSITION');
        expect(res.body.details).toEqual({ from: status, to: action });
      }
      const booking = await makeBooking(db(), { status: BookingStatus.Declined });
      const ar = await setStatus(booking.id, { status: 'accepted' }).set('Accept-Language', 'ar');
      expect(ar.body.message).toBe('لا يمكن نقل الحجز من "declined" إلى "accepted".');
    });

    it('400 for a missing reason (except accept), missing note or notify, unknown status; 404', async () => {
      const booking = await makeBooking(db());
      expectError(await request(t.http).post(`${BASE}/${booking.id}/status`).set(admin.headers).send({ status: 'declined', note: 'n', notify: true }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${BASE}/${booking.id}/status`).set(admin.headers).send({ status: 'accepted', notify: true }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${BASE}/${booking.id}/status`).set(admin.headers).send({ status: 'accepted', note: 'n' }), 400, 'VALIDATION_FAILED');
      expectError(await setStatus(booking.id, { status: 'archived', reason: 'x' }), 400, 'VALIDATION_FAILED');
      expectError(await setStatus(MISSING, { status: 'declined', reason: 'x' }), 404, 'BOOKING_NOT_FOUND');
    });
  });

  // ── reschedule ──────────────────────────────────────────────

  describe('reschedule', () => {
    const reschedule = (id: string, body: Record<string, unknown>) => request(t.http).post(`${BASE}/${id}/reschedule`).set(admin.headers).send({ reason: 'Hall double-booked', ...body });

    it('applies directly on a pending booking (availability moved)', async () => {
      const { booking } = await createPending();
      const date = futureDate();
      const res = await reschedule(booking.id, { date, startTime: '19:00', endTime: '23:00' }).expect(200);
      expect(res.body.data).toMatchObject({ eventDate: date, startTime: '19:00', endTime: '23:00', pendingReschedule: null });
      expect(res.body.data.timeline.find((e: any) => e.type === 'reschedule')).toMatchObject({ oldDate: booking.eventDate, newDate: date, rescheduleStatus: 'accepted' });
      const [row] = await db().query('SELECT date, start_time FROM availability_blocks WHERE booking_id = ? AND deleted_at IS NULL', [booking.id]);
      expect([String(row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date).slice(0, 10), row.start_time]).toEqual([date, '19:00:00']);
      expect(await audited('booking.rescheduled', booking.id)).not.toBeNull();
    });

    it('proposes on an accepted booking; one pending at a time; cancel; force applies; busy dates 409 unless forced', async () => {
      const ctx = await bookable();
      const { booking } = await createAccepted(ctx);
      const date = futureDate();
      const proposed = await reschedule(booking.id, { date }).expect(200);
      expect(proposed.body.data.eventDate).toBe(booking.eventDate);
      expect(proposed.body.data.pendingReschedule).toMatchObject({ newDate: date, status: 'pending', forced: false, proposedBy: { id: admin.user.id } });
      expectError(await reschedule(booking.id, { date: futureDate() }), 409, 'RESCHEDULE_PENDING_EXISTS');

      const rid = proposed.body.data.pendingReschedule.id;
      const cancelled = await request(t.http).post(`${BASE}/${booking.id}/reschedules/${rid}/cancel`).set(admin.headers).expect(200);
      expect(cancelled.body.data.pendingReschedule).toBeNull();
      expectError(await request(t.http).post(`${BASE}/${booking.id}/reschedules/${rid}/cancel`).set(admin.headers), 409, 'RESCHEDULE_NOT_PENDING');
      expectError(await request(t.http).post(`${BASE}/${booking.id}/reschedules/${MISSING}/cancel`).set(admin.headers), 404, 'RESCHEDULE_NOT_FOUND');

      // Busy date: another accepted booking of the provider.
      const busy = await createAccepted(ctx);
      expectError(await reschedule(booking.id, { date: busy.booking.eventDate }), 409, 'DATE_UNAVAILABLE');
      const forced = await reschedule(booking.id, { date: busy.booking.eventDate, force: true }).expect(200);
      expect(forced.body.data).toMatchObject({ eventDate: busy.booking.eventDate, pendingReschedule: null });

      expectError(await reschedule(booking.id, { date: '2020-01-01' }), 422, 'BOOKING_DATE_PAST');
      expectError(await reschedule(booking.id, { date: 'soon' }), 400, 'VALIDATION_FAILED');
      const done = await makeBooking(db(), { status: BookingStatus.Completed });
      expectError(await reschedule(done.id, { date: futureDate() }), 409, 'BOOKING_NOT_EDITABLE');
    });
  });

  // ── price & invoices ────────────────────────────────────────

  describe('price and invoices', () => {
    const price = (id: string, body: Record<string, unknown>) => request(t.http).patch(`${BASE}/${id}/price`).set(admin.headers).send(body);
    const lines = [
      { kind: 'service', label: 'Wedding coverage', quantity: 1, unitAmount: '45000.00' },
      { kind: 'extra', label: 'Drone', quantity: 1, unitAmount: 7000 },
      { kind: 'discount', label: 'Loyalty', quantity: 1, unitAmount: '2000.00' },
    ];

    it('recomputes a pending booking without an invoice', async () => {
      const { booking } = await createPending();
      const res = await price(booking.id, { lines, reason: 'Client added drone' }).expect(200);
      expect(res.body.data).toMatchObject({ subtotal: '52000.00', discountTotal: '2000.00', total: '50000.00', feeAmount: '5000.00', invoice: null });
      expect(res.body.data.timeline.find((e: any) => e.type === 'price')).toMatchObject({ oldTotal: '45000.00', newTotal: '50000.00', reason: 'Client added drone' });
      expectError(await request(t.http).get(`${BASE}/${booking.id}/invoice`).set(admin.headers), 404, 'INVOICE_NOT_FOUND');
      expect((await audited('booking.price_changed', booking.id))!.level).toBe('sensitive');
    });

    it('issues a new invoice version on an accepted booking (the old one is voided); GET invoice, PDF and send', async () => {
      const { booking, client } = await createAccepted();
      const v1 = await request(t.http).get(`${BASE}/${booking.id}/invoice`).set(admin.headers).expect(200);
      expect(v1.body.data).toMatchObject({ version: 1, total: '45000.00', feeAmount: '4500.00', providerAmount: '40500.00', bookingReference: booking.reference, versions: [1], pdfReady: true });

      const res = await price(booking.id, { lines, reason: 'Drone added' }).expect(200);
      expect(res.body.data.invoice).toMatchObject({ version: 2 });
      const v2 = await request(t.http).get(`${BASE}/${booking.id}/invoice`).set(admin.headers).expect(200);
      expect(v2.body.data).toMatchObject({ version: 2, total: '50000.00', versions: [1, 2] });
      expect(v2.body.data.number).not.toBe(v1.body.data.number);
      expect(v2.body.data.lines.map((l: any) => l.amount)).toEqual(['45000.00', '7000.00', '-2000.00']);
      const all = await db().getRepository(Invoice).find({ where: { bookingId: booking.id }, withDeleted: true, order: { version: 'ASC' } });
      expect(all.map((i) => [i.version, i.deletedAt !== null])).toEqual([
        [1, true],
        [2, false],
      ]);

      const pdf = await request(t.http).get(`${BASE}/${booking.reference}/invoice.pdf`).set(admin.headers).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

      const sent = await request(t.http).post(`${BASE}/${booking.id}/invoice/send`).set(admin.headers).expect(200);
      expect(sent.body.data.sentToClientAt).toEqual(expect.any(String));
      const mail = lastMailTo(client.email)!;
      expect(mail.subject).toBe(`Your invoice ${v2.body.data.number}`);
      expect(mail.attachments).toEqual([`${v2.body.data.number}.pdf`]);
      expect(await audited('invoice.sent', booking.id)).not.toBeNull();
    });

    it('422 negative total, 409 not editable, 400 invalid lines, 404', async () => {
      const { booking } = await createPending();
      expectError(await price(booking.id, { lines: [{ kind: 'adjustment', label: 'Refund', quantity: 1, unitAmount: '-10.00' }], reason: 'x' }), 422, 'BOOKING_TOTAL_NEGATIVE');
      expectError(await price(booking.id, { lines: [], reason: 'x' }), 400, 'VALIDATION_FAILED');
      expectError(await price(booking.id, { lines: [{ kind: 'gift', label: 'x', quantity: 1, unitAmount: '1' }], reason: 'x' }), 400, 'VALIDATION_FAILED');
      expectError(await price(booking.id, { lines }), 400, 'VALIDATION_FAILED');
      const declined = await makeBooking(db(), { status: BookingStatus.Declined });
      expectError(await price(declined.id, { lines, reason: 'x' }), 409, 'BOOKING_NOT_EDITABLE');
      expectError(await price(MISSING, { lines, reason: 'x' }), 404, 'BOOKING_NOT_FOUND');
      expectError(await request(t.http).get(`${BASE}/${MISSING}/invoice.pdf`).set(admin.headers), 404, 'BOOKING_NOT_FOUND');
      expectError(await request(t.http).post(`${BASE}/${booking.id}/invoice/send`).set(admin.headers), 404, 'INVOICE_NOT_FOUND');
    });
  });

  // ── remind & details ────────────────────────────────────────

  describe('remind and event details', () => {
    it('reminds the provider once per 12 hours (429 REMINDER_TOO_SOON with Retry-After)', async () => {
      const { booking, provider } = await createPending();
      const res = await request(t.http).post(`${BASE}/${booking.id}/remind`).set(admin.headers).expect(200);
      expect(res.body.data).toEqual({ id: booking.id, reminderSentAt: expect.any(String), nextReminderAt: expect.any(String) });
      expect((await reload(booking.id)).reminderSentAt).not.toBeNull();
      expect(lastMailTo(provider.email)!.subject).toBe(`Reminder: booking ${booking.reference} is waiting for your reply`);
      const again = await request(t.http).post(`${BASE}/${booking.id}/remind`).set(admin.headers);
      expectError(again, 429, 'REMINDER_TOO_SOON');
      expect(Number(again.headers['retry-after'])).toBeGreaterThan(12 * 3600 - 60);

      await db().query('UPDATE bookings SET reminder_sent_at = ? WHERE id = ?', [new Date(Date.now() - 13 * HOUR), booking.id]);
      await request(t.http).post(`${BASE}/${booking.id}/remind`).set(admin.headers).expect(200);
      const accepted = await makeBooking(db(), { status: BookingStatus.Accepted });
      expectError(await request(t.http).post(`${BASE}/${accepted.id}/remind`).set(admin.headers), 409, 'BOOKING_NOT_EDITABLE');
    });

    it('edits event details; eventDate → 422 USE_RESCHEDULE; commune checks; not editable when completed', async () => {
      const { booking } = await createPending();
      const commune = await makeCommune(db(), { wilayaCode: 16 });
      const res = await request(t.http)
        .patch(`${BASE}/${booking.id}`)
        .set(admin.headers)
        .send({ eventType: 'engagement', startTime: '17:00', endTime: '21:00', guests: 80, locationText: 'Villa', communeId: commune.id, clientNote: null })
        .expect(200);
      expect(res.body.data).toMatchObject({ eventType: 'engagement', startTime: '17:00', endTime: '21:00', guests: 80, locationText: 'Villa', commune: { id: commune.id }, clientNote: null });
      const [row] = await db().query('SELECT start_time, end_time FROM availability_blocks WHERE booking_id = ? AND deleted_at IS NULL', [booking.id]);
      expect(row).toEqual({ start_time: '17:00:00', end_time: '21:00:00' });
      expect((await audited('booking.updated', booking.id))!.changes).toMatchObject({ guests: { from: null, to: 80 } });

      expectError(await request(t.http).patch(`${BASE}/${booking.id}`).set(admin.headers).send({ eventDate: '2031-01-01' }), 422, 'USE_RESCHEDULE');
      const oran = await makeCommune(db(), { wilayaCode: 31 });
      expectError(await request(t.http).patch(`${BASE}/${booking.id}`).set(admin.headers).send({ communeId: oran.id }), 422, 'COMMUNE_WILAYA_MISMATCH');
      const moved = await request(t.http).patch(`${BASE}/${booking.id}`).set(admin.headers).send({ wilayaCode: 31, communeId: oran.id }).expect(200);
      expect(moved.body.data).toMatchObject({ wilaya: { code: 31 }, commune: { id: oran.id } });
      expectError(await request(t.http).patch(`${BASE}/${booking.id}`).set(admin.headers).send({ guests: -1 }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).patch(`${BASE}/${booking.id}`).set(admin.headers).send({ status: 'accepted' }), 400, 'VALIDATION_FAILED');
      const done = await makeBooking(db(), { status: BookingStatus.Completed });
      expectError(await request(t.http).patch(`${BASE}/${done.id}`).set(admin.headers).send({ guests: 10 }), 409, 'BOOKING_NOT_EDITABLE');
    });
  });

  // ── jobs ────────────────────────────────────────────────────

  describe('jobs', () => {
    const jobs = () => t.get(BookingJobsService);

    it('auto-completes accepted bookings after the event end + dispute window, skipping open disputes and future ones', async () => {
      const ctx = await bookable();
      const common = { serviceId: ctx.service.id, providerId: ctx.provider.id, status: BookingStatus.Accepted, eventDate: '2026-01-10', endTime: '23:00:00' };
      const due = await makeBooking(db(), common);
      const disputed = await makeBooking(db(), { ...common, disputeStatus: BookingDisputeStatus.Open });
      const recent = await makeBooking(db(), { ...common, eventDate: '2026-01-14' });
      const now = new Date('2026-01-14T12:00:00Z');
      const completed = await jobs().autoComplete(now);
      expect(completed).toBeGreaterThanOrEqual(1);
      expect(await reload(due.id)).toMatchObject({ status: 'completed' });
      expect((await reload(disputed.id)).status).toBe('accepted');
      expect((await reload(recent.id)).status).toBe('accepted');
      const [change] = await db().query('SELECT actor_id, reason FROM booking_status_changes WHERE booking_id = ?', [due.id]);
      expect(change).toEqual({ actor_id: null, reason: 'auto_completed' });
      expect((await audited('booking.status_changed', due.id))!.source).toBe('system');
      // Idempotent
      await jobs().autoComplete(now);
      expect(Number((await db().query('SELECT COUNT(*) AS n FROM booking_status_changes WHERE booking_id = ?', [due.id]))[0].n)).toBe(1);
    });

    it('reminds providers at the reply deadline − 12 h once, and requests reviews after review_open_after_hours', async () => {
      const ctx = await bookable();
      const old = await makeBooking(db(), { serviceId: ctx.service.id, providerId: ctx.provider.id, createdAt: new Date(Date.now() - 37 * HOUR) } as never);
      const fresh = await makeBooking(db(), { serviceId: ctx.service.id, providerId: ctx.provider.id, createdAt: new Date(Date.now() - 2 * HOUR) } as never);
      await jobs().sendReplyReminders();
      expect((await reload(old.id)).reminderSentAt).not.toBeNull();
      expect((await reload(fresh.id)).reminderSentAt).toBeNull();
      expect(lastMailTo(ctx.provider.email)!.subject).toMatch(/is waiting for your reply/);
      const outbox = t.get(MailService).outbox.length;
      await jobs().sendReplyReminders();
      expect(t.get(MailService).outbox.length).toBe(outbox);

      const done = await makeBooking(db(), { serviceId: ctx.service.id, providerId: ctx.provider.id, clientId: ctx.client.id, status: BookingStatus.Completed, completedAt: new Date(Date.now() - 30 * HOUR) });
      const tooRecent = await makeBooking(db(), { serviceId: ctx.service.id, providerId: ctx.provider.id, status: BookingStatus.Completed, completedAt: new Date(Date.now() - 2 * HOUR) });
      await jobs().requestReviews();
      expect((await reload(done.id)).reviewRequestedAt).not.toBeNull();
      expect((await reload(tooRecent.id)).reviewRequestedAt).toBeNull();
      expect(lastMailTo(ctx.client.email)!.subject).toBe('How was your event?');
    });
  });

  it('keeps the event types enum on bookings', () => {
    expect(Object.values(EventType)).toContain('wedding');
  });
});
