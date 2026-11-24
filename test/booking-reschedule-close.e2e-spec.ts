import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { addDays } from '../src/bookings/bookings.policy.js';
import { BookingJobsService } from '../src/bookings/booking-jobs.service.js';
import { closeStaleReschedules, findStaleReschedules } from '../src/bookings/stale-reschedules.js';
import { parseFlags } from '../src/bookings/stale-reschedules.cli.js';
import { BookingStatus, RescheduleStatus } from '../src/common/enums/booking.enums.js';
import { ServiceStatus } from '../src/common/enums/catalog.enums.js';
import { UserRole } from '../src/common/enums/user.enums.js';
import { algiersToday } from '../src/bookings/bookings.service.js';
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
  type LoggedIn,
  type TestApp,
} from './utils/index.js';

/**
 * BUG-E7 (acceptance E-24): a booking that ends — cancelled, declined (expiry
 * included) or completed, by any path — closes its pending reschedule proposals
 * as `cancelled`. Ended bookings never offer to answer a proposal, and the
 * proposal routes answer 409 on them.
 */
const APP = '/api/v1/app/bookings';
const PROVIDER = '/api/v1/app/provider/bookings';
const ADMIN = '/api/v1/admin';
const HOUR = 3_600_000;

let t: TestApp;
let admin: LoggedIn;
let client: LoggedIn;
let provider: LoggedIn;
const db = () => t.dataSource;

let day = 0;
/** A fresh future date per booking, so no test collides with another's slot. */
const future = () => addDays('2027-03-01', (day += 3));

beforeAll(async () => {
  t = await createApp();
  admin = await loginAs(t, UserRole.Admin);
  provider = await loginAs(t, UserRole.Provider);
  client = await loginAs(t, UserRole.Client);
});

afterAll(async () => {
  await t.close();
});

async function bookableService(providerId = provider.user.id) {
  const category = await makeCategory(db());
  const service = await makeService(db(), { providerId, categoryId: category.id, status: ServiceStatus.Published });
  await db().query('INSERT INTO service_wilayas (service_id, wilaya_code, created_at) VALUES (?, 16, NOW(6))', [service.id]);
  return service;
}

/** A pending proposal written directly, for the paths where the API cannot create one (pending booking, event over). */
async function insertProposal(bookingId: string, proposedById: string, eventDate: string): Promise<string> {
  const [{ id }] = await db().query('SELECT UUID() AS id');
  await db().query(
    `INSERT INTO booking_reschedules (id, created_at, updated_at, booking_id, old_date, old_start, old_end, new_date, new_start, new_end, proposed_by_id, reason, forced, status, resolved_at)
     VALUES (?, NOW(6), NOW(6), ?, ?, '18:00:00', '22:00:00', ?, '18:00:00', '22:00:00', ?, 'Hall moved', 0, 'pending', NULL)`,
    [id, bookingId, eventDate, addDays(eventDate, 4), proposedById],
  );
  return id;
}

const proposalRow = async (id: string) => (await db().query('SELECT status, resolved_at FROM booking_reschedules WHERE id = ?', [id]))[0];
const closedAudit = (bookingId: string) => db().getRepository(AuditLog).findOneBy({ action: 'booking.reschedule_closed', objectId: bookingId });

/** The proposal is closed as `cancelled`, resolved, and audited with the booking's new status as the reason. */
async function expectClosed(bookingId: string, proposalId: string, reason: string) {
  const row = await proposalRow(proposalId);
  expect(row.status).toBe(RescheduleStatus.Cancelled);
  expect(row.resolved_at).not.toBeNull();
  const audit = await closedAudit(bookingId);
  expect(audit).not.toBeNull();
  expect(audit!.changes).toMatchObject({ closed: 1, reason });
}

describe('BUG-E7: pending proposals close when the booking ends (e2e)', () => {
  describe('app routes (acceptance E-24)', () => {
    it('client proposes, client cancels: both details show the proposal cancelled, nothing to answer or withdraw', async () => {
      const service = await bookableService();
      const date = future();
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, serviceId: service.id, status: BookingStatus.Accepted, eventDate: date });
      const proposed = await request(t.http).post(`${APP}/${booking.id}/reschedule`).set(client.headers).send({ date: addDays(date, 4), reason: 'Venue moved our date' }).expect(200);
      const rid = proposed.body.data.reschedules[0].id;
      const before = await request(t.http).get(`${PROVIDER}/${booking.id}`).set(provider.headers).expect(200);
      expect(before.body.data.allowedActions).toContain('respond_reschedule');

      await request(t.http).post(`${APP}/${booking.id}/cancel`).set(client.headers).send({ reason: 'Changed plans' }).expect(200);
      await expectClosed(booking.id, rid, 'cancelled');

      for (const [base, headers] of [[APP, client.headers], [PROVIDER, provider.headers]] as const) {
        const detail = (await request(t.http).get(`${base}/${booking.id}`).set(headers).expect(200)).body.data;
        expect(detail.status).toBe(BookingStatus.Cancelled);
        expect(detail.reschedules[0]).toMatchObject({ id: rid, status: RescheduleStatus.Cancelled, awaitingMe: false });
        expect(detail.allowedActions).not.toContain('respond_reschedule');
        expect(detail.allowedActions).not.toContain('reschedule');
      }
      expectError(await request(t.http).post(`${APP}/${booking.id}/reschedules/${rid}/withdraw`).set(client.headers), 409, 'RESCHEDULE_NOT_PENDING');
      expectError(await request(t.http).post(`${PROVIDER}/${booking.id}/reschedules/${rid}/accept`).set(provider.headers), 409, 'RESCHEDULE_NOT_PENDING');
      expectError(await request(t.http).post(`${PROVIDER}/${booking.id}/reschedules/${rid}/reject`).set(provider.headers), 409, 'RESCHEDULE_NOT_PENDING');
      // Only the cancellation itself is announced: no "proposal declined" notice.
      const notices: any[] = await db().query("SELECT type FROM notifications WHERE user_id IN (?, ?) AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.bookingId')) = ?", [client.user.id, provider.user.id, booking.id]);
      expect(notices.map((n) => n.type)).not.toContain('booking.reschedule_rejected');
    });

    it('provider proposes, provider cancels', async () => {
      const service = await bookableService();
      const date = future();
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, serviceId: service.id, status: BookingStatus.Accepted, eventDate: date });
      const proposed = await request(t.http).post(`${PROVIDER}/${booking.id}/reschedule`).set(provider.headers).send({ date: addDays(date, 4), reason: 'Team unavailable' }).expect(200);
      const rid = proposed.body.data.reschedules[0].id;

      await request(t.http).post(`${PROVIDER}/${booking.id}/cancel`).set(provider.headers).send({ reason: 'Equipment broke' }).expect(200);
      await expectClosed(booking.id, rid, 'cancelled');
      const detail = (await request(t.http).get(`${APP}/${booking.id}`).set(client.headers).expect(200)).body.data;
      expect(detail.reschedules[0]).toMatchObject({ status: RescheduleStatus.Cancelled, awaitingMe: false });
      expect(detail.allowedActions).not.toContain('respond_reschedule');
    });

    it('provider declines a pending request', async () => {
      const date = future();
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Pending, eventDate: date });
      const rid = await insertProposal(booking.id, client.user.id, date);
      await request(t.http).post(`${PROVIDER}/${booking.id}/decline`).set(provider.headers).send({ reason: 'Fully booked' }).expect(200);
      await expectClosed(booking.id, rid, 'declined');
    });

    it('provider completes after the event (a proposal still waiting after the event, BUG-E6, closes at completion)', async () => {
      const date = addDays(algiersToday(), -2);
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Accepted, eventDate: date, startTime: '18:00:00', endTime: '22:00:00' } as never);
      const rid = await insertProposal(booking.id, client.user.id, date);
      // Before completion the provider can still answer it (unchanged BUG-E6 behaviour).
      expect((await request(t.http).get(`${PROVIDER}/${booking.id}`).set(provider.headers).expect(200)).body.data.allowedActions).toContain('respond_reschedule');
      await request(t.http).post(`${PROVIDER}/${booking.id}/complete`).set(provider.headers).expect(200);
      await expectClosed(booking.id, rid, 'completed');
    });

    it('accepting a pending request keeps its proposal open (only an ending status closes it)', async () => {
      const service = await bookableService();
      const date = future();
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, serviceId: service.id, status: BookingStatus.Pending, eventDate: date });
      const rid = await insertProposal(booking.id, client.user.id, date);
      await request(t.http).post(`${PROVIDER}/${booking.id}/accept`).set(provider.headers).expect(200);
      expect((await proposalRow(rid)).status).toBe(RescheduleStatus.Pending);
      expect(await closedAudit(booking.id)).toBeNull();
    });
  });

  describe('dashboard and system paths', () => {
    const setStatus = (id: string, body: Record<string, unknown>) =>
      request(t.http).post(`${ADMIN}/bookings/${id}/status`).set(admin.headers).send({ note: 'Checked with both parties.', notify: true, ...body });

    it('admin cancels (status change): closed, and the dashboard detail has no pending proposal', async () => {
      const service = await bookableService();
      const date = future();
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, serviceId: service.id, status: BookingStatus.Accepted, eventDate: date });
      const proposed = await request(t.http).post(`${APP}/${booking.id}/reschedule`).set(client.headers).send({ date: addDays(date, 4), reason: 'Family reasons' }).expect(200);
      const rid = proposed.body.data.reschedules[0].id;
      expect((await request(t.http).get(`${ADMIN}/bookings/${booking.id}`).set(admin.headers).expect(200)).body.data.pendingReschedule).toMatchObject({ id: rid });

      await setStatus(booking.id, { status: 'cancelled', reason: 'client_changed_plans', cancelledBy: 'client' }).expect(200);
      await expectClosed(booking.id, rid, 'cancelled');
      expect((await request(t.http).get(`${ADMIN}/bookings/${booking.id}`).set(admin.headers).expect(200)).body.data.pendingReschedule).toBeNull();
      expectError(await request(t.http).post(`${ADMIN}/bookings/${booking.id}/reschedules/${rid}/cancel`).set(admin.headers), 409, 'RESCHEDULE_NOT_PENDING');
      // The provider's view after an admin cancellation (E-24 variant).
      const detail = (await request(t.http).get(`${PROVIDER}/${booking.id}`).set(provider.headers).expect(200)).body.data;
      expect(detail.reschedules[0]).toMatchObject({ status: RescheduleStatus.Cancelled, awaitingMe: false });
      expect(detail.allowedActions).not.toContain('respond_reschedule');
    });

    it('admin completes (status change)', async () => {
      const date = addDays(algiersToday(), -2);
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Accepted, eventDate: date });
      const rid = await insertProposal(booking.id, provider.user.id, date);
      await setStatus(booking.id, { status: 'completed', reason: 'event_done' }).expect(200);
      await expectClosed(booking.id, rid, 'completed');
    });

    it('admin blocks with "Cancel them" (BUG-M4): accepted bookings are cancelled and their proposals closed', async () => {
      const { user: blocked } = await makeProvider(db());
      const other = await makeUser(db());
      const date = future();
      const booking = await makeBooking(db(), { clientId: other.id, providerId: blocked.id, status: BookingStatus.Accepted, eventDate: date });
      const rid = await insertProposal(booking.id, other.id, date);
      await request(t.http).post(`${ADMIN}/users/${blocked.id}/block`).set(admin.headers).send({ reason: 'fraud', bookings: 'cancel' }).expect(200);
      await expectClosed(booking.id, rid, 'cancelled');
    });

    it('admin deletes the account: its pending requests are cancelled and their proposals closed', async () => {
      const deleted = await makeUser(db());
      const date = future();
      const booking = await makeBooking(db(), { clientId: deleted.id, status: BookingStatus.Pending, eventDate: date });
      const rid = await insertProposal(booking.id, deleted.id, date);
      await request(t.http).delete(`${ADMIN}/users/${deleted.id}`).set(admin.headers).send({ typedName: deleted.fullName }).expect(204);
      await expectClosed(booking.id, rid, 'cancelled');
    });

    it('admin deletes a service, and a pack', async () => {
      const { user: owner } = await makeProvider(db());
      const service = await makeService(db(), { providerId: owner.id });
      const date = future();
      const onService = await makeBooking(db(), { serviceId: service.id, providerId: owner.id, status: BookingStatus.Pending, eventDate: date });
      const rid1 = await insertProposal(onService.id, owner.id, date);
      await request(t.http).delete(`${ADMIN}/services/${service.id}`).query({ force: true }).set(admin.headers).expect(200);
      await expectClosed(onService.id, rid1, 'cancelled');

      const pack = await makePack(db(), { providerId: owner.id });
      const onPack = await makeBooking(db(), { packId: pack.id, serviceId: null, providerId: owner.id, status: BookingStatus.Pending, eventDate: date });
      const rid2 = await insertProposal(onPack.id, owner.id, date);
      await request(t.http).delete(`${ADMIN}/packs/${pack.id}`).set(admin.headers).expect(200);
      await expectClosed(onPack.id, rid2, 'cancelled');
    });

    it('request expiry job (BUG-F1) declines as expired and closes the proposal', async () => {
      const { user: owner } = await makeProvider(db());
      const service = await makeService(db(), { providerId: owner.id });
      const date = future();
      const booking = await makeBooking(db(), { serviceId: service.id, providerId: owner.id, status: BookingStatus.Pending, eventDate: date, createdAt: new Date(Date.now() - 60 * HOUR) } as never);
      const rid = await insertProposal(booking.id, owner.id, date);
      const setAutoExpire = (on: boolean) =>
        request(t.http).patch(`${ADMIN}/settings`).set(admin.headers).send({ values: { booking_auto_expire: on }, confirm: true, note: 'BUG-E7 test' }).expect(200);
      await setAutoExpire(true);
      try {
        expect(await t.get(BookingJobsService).expireRequests()).toBeGreaterThanOrEqual(1);
      } finally {
        await setAutoExpire(false);
      }
      await expectClosed(booking.id, rid, 'declined');
    });

    it('auto-complete job', async () => {
      const { user: owner } = await makeProvider(db());
      const booking = await makeBooking(db(), { providerId: owner.id, status: BookingStatus.Accepted, eventDate: '2026-01-10', endTime: '23:00:00' } as never);
      const rid = await insertProposal(booking.id, owner.id, '2026-01-10');
      await t.get(BookingJobsService).autoComplete(new Date('2026-01-14T12:00:00Z'));
      await expectClosed(booking.id, rid, 'completed');
    });

    it.each(['cancelled', 'completed'] as const)('dispute resolved as %s', async (outcome) => {
      const other = await makeUser(db());
      const { user: owner } = await makeProvider(db());
      const service = await makeService(db(), { providerId: owner.id });
      const date = addDays(algiersToday(), -1);
      const booking = await makeBooking(db(), { clientId: other.id, providerId: owner.id, serviceId: service.id, status: BookingStatus.Accepted, eventDate: date, startTime: '18:00:00', endTime: '23:00:00' } as never);
      const rid = await insertProposal(booking.id, other.id, date);
      const opened = await request(t.http)
        .post(`${ADMIN}/disputes`)
        .set(admin.headers)
        .send({ bookingId: booking.id, openedByRole: 'client', type: 'provider_no_show', description: 'The DJ never came to the wedding and did not answer our calls that evening.' })
        .expect(201);
      await request(t.http).post(`${ADMIN}/disputes/${opened.body.data.id}/resolve`).set(admin.headers).send({ bookingOutcome: outcome, decisionNote: 'Decided after hearing both parties.' }).expect(200);
      await expectClosed(booking.id, rid, outcome);
    });
  });

  describe('proposals left pending on ended bookings before the fix', () => {
    it('are never offered, every proposal route answers 409, and the cleanup closes them once', async () => {
      const date = future();
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Cancelled, eventDate: date });
      const rid = await insertProposal(booking.id, client.user.id, date);

      const providerView = (await request(t.http).get(`${PROVIDER}/${booking.id}`).set(provider.headers).expect(200)).body.data;
      expect(providerView.allowedActions).not.toContain('respond_reschedule');
      expect(providerView.reschedules[0]).toMatchObject({ id: rid, status: RescheduleStatus.Pending, awaitingMe: false });
      expect((await request(t.http).get(`${ADMIN}/bookings/${booking.id}`).set(admin.headers).expect(200)).body.data.pendingReschedule).toBeNull();
      expectError(await request(t.http).post(`${PROVIDER}/${booking.id}/reschedules/${rid}/accept`).set(provider.headers), 409, 'BOOKING_NOT_EDITABLE');
      expectError(await request(t.http).post(`${PROVIDER}/${booking.id}/reschedules/${rid}/reject`).set(provider.headers), 409, 'BOOKING_NOT_EDITABLE');
      expectError(await request(t.http).post(`${APP}/${booking.id}/reschedules/${rid}/withdraw`).set(client.headers), 409, 'BOOKING_NOT_EDITABLE');
      expectError(await request(t.http).post(`${ADMIN}/bookings/${booking.id}/reschedules/${rid}/cancel`).set(admin.headers), 409, 'BOOKING_NOT_EDITABLE');
      expect((await proposalRow(rid)).status).toBe(RescheduleStatus.Pending);

      // The read-only preview lists it; the fix closes it, audited, and a second run finds nothing.
      const listed = await findStaleReschedules(db());
      expect(listed.find((s) => s.rescheduleId === rid)).toMatchObject({ reference: booking.reference, bookingStatus: 'cancelled', oldDate: date, newDate: addDays(date, 4), newStartTime: '18:00' });
      expect((await proposalRow(rid)).status).toBe(RescheduleStatus.Pending);
      expect(await closeStaleReschedules(db())).toBeGreaterThanOrEqual(1);
      expect((await proposalRow(rid)).status).toBe(RescheduleStatus.Cancelled);
      expect((await closedAudit(booking.id))!).toMatchObject({ source: 'system', actorId: null, changes: { closed: 1, reason: 'cancelled', cleanup: true } });
      expect(await findStaleReschedules(db())).toHaveLength(0);
      expect(await closeStaleReschedules(db())).toBe(0);
    });

    it('the script only writes with --apply, and rejects unknown flags', () => {
      expect(parseFlags([])).toEqual({ json: false, apply: false });
      expect(parseFlags(['--json'])).toEqual({ json: true, apply: false });
      expect(parseFlags(['--apply'])).toEqual({ json: false, apply: true });
      expect(() => parseFlags(['--aply'])).toThrow(/Unknown option/);
      expect(() => parseFlags(['apply'])).toThrow(/Unknown option/);
    });
  });
});
