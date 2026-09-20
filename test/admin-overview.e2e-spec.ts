import request from 'supertest';
import { addDays } from '../src/bookings/bookings.policy.js';
import { BookingStatus } from '../src/common/enums/booking.enums.js';
import { ConversationKind, ParticipantRole } from '../src/common/enums/messaging.enums.js';
import { ReportTargetType } from '../src/common/enums/moderation.enums.js';
import { UserRole, VerificationStatus } from '../src/common/enums/user.enums.js';
import { OverviewService } from '../src/stats/overview.service.js';
import { algiersDay } from '../src/stats/stats.policy.js';
import { computeDailyMetrics, readStats } from '../src/stats/stats.rollup.js';
import {
  createApp,
  expectError,
  loginAs,
  makeAcademicRequest,
  makeAuditLog,
  makeBooking,
  makeConversation,
  makeDispute,
  makeFile,
  makeInvoice,
  makeMessage,
  makeProvider,
  makeReport,
  makeReview,
  makeService,
  makeUser,
  makeUserDocument,
  uid,
  type LoggedIn,
  type TestApp,
} from './utils/index.js';

const API = '/api/v1/admin';
const HOUR = 3_600_000;

describe('Admin overview, search and nav counts (e2e)', () => {
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
  const overview = () => t.get(OverviewService);
  const get = (path: string, query: Record<string, unknown> = {}, headers = admin.headers) => request(t.http).get(`${API}/${path}`).set(headers).query(query);

  // ── overview ───────────────────────────────────────────────

  describe('GET /admin/overview', () => {
    it('returns the full shape for the default range (30d)', async () => {
      overview().clearCache();
      await makeBooking(db(), { status: BookingStatus.Completed });
      await makeAuditLog(db(), { action: 'review.hidden', objectType: 'review', objectId: '7c4a3e1b-1d2f-4a5b-9c8d-0e1f2a3b4c5d', actorId: admin.user.id, createdAt: new Date(Date.now() + 1000) });
      const res = await get('overview').expect(200);
      const d = res.body.data;
      const today = algiersDay(new Date());
      expect(d).toMatchObject({
        range: '30d',
        period: { from: addDays(today, -29), to: today },
        previousPeriod: { from: addDays(today, -59), to: addDays(today, -30) },
        attention: {
          verificationsWaiting: expect.any(Number),
          bookingsNoReply: expect.any(Number),
          disputesOpen: expect.any(Number),
          academicRequestsPending: expect.any(Number),
          reviewsReported: expect.any(Number),
          servicesReported: expect.any(Number),
        },
        generatedAt: expect.any(String),
      });
      expect(d.kpis.map((k: any) => k.key)).toEqual(['bookings', 'booking_value', 'new_users', 'average_rating']);
      expect(d.bookingsPerDay).toHaveLength(30);
      expect(d.bookingsPerDay[29]).toEqual({ date: today, requests: expect.any(Number), completed: expect.any(Number) });
      expect(d.recentActivity.length).toBeLessThanOrEqual(8);
      expect(d.recentActivity[0]).toMatchObject({ action: 'review.hidden', actor: { id: admin.user.id }, href: '/reviews/7c4a3e1b-1d2f-4a5b-9c8d-0e1f2a3b4c5d', logHref: expect.stringMatching(/^\/activity-log\//) });
      expect(Array.isArray(d.latestBookings)).toBe(true);
      const percent = d.bookingsByStatus.reduce((sum: number, s: any) => sum + s.percent, 0);
      expect(percent).toBeGreaterThan(99);
    });

    it('counts today’s activity live and compares with yesterday', async () => {
      overview().clearCache();
      const before = (await get('overview', { range: 'today' })).body.data;
      const kpi = (data: any, key: string) => data.kpis.find((k: any) => k.key === key);

      const client = await makeUser(db());
      const provider = (await makeProvider(db())).user;
      const accepted = await makeBooking(db(), { clientId: client.id, providerId: provider.id, status: BookingStatus.Accepted, total: '30000.00' });
      await makeBooking(db(), { status: BookingStatus.Declined, total: '99999.00' });
      const completed = await makeBooking(db(), { status: BookingStatus.Completed, completedAt: new Date(), total: '20000.00' });
      await makeReview(db(), { bookingId: completed.id, rating: 4 });

      overview().clearCache();
      const after = (await get('overview', { range: 'today' })).body.data;
      expect(Number(kpi(after, 'bookings').value) - Number(kpi(before, 'bookings').value)).toBe(3);
      expect(Number(kpi(after, 'booking_value').value) - Number(kpi(before, 'booking_value').value)).toBe(50000);
      expect(Number(kpi(after, 'new_users').value) - Number(kpi(before, 'new_users').value)).toBeGreaterThanOrEqual(2);
      expect(kpi(after, 'average_rating').value).toMatch(/^\d\.\d{2}$/);
      expect(after.bookingsPerDay).toHaveLength(1);
      expect(after.bookingsPerDay[0].requests - before.bookingsPerDay[0].requests).toBe(3);
      expect(after.bookingsPerDay[0].completed - before.bookingsPerDay[0].completed).toBeGreaterThanOrEqual(1);
      expect(after.latestBookings.length).toBeGreaterThan(0);
      expect(after.latestBookings.map((b: any) => b.id)).toContain(completed.id);
      expect(after.latestBookings.find((b: any) => b.id === completed.id)).toMatchObject({ total: '20000.00', status: 'completed', client: { id: completed.clientId } });
      expect(accepted).toBeDefined();
      expect(after.previousPeriod.from).toBe(addDays(after.period.from, -1));

      // Cached for 60 s: a new booking does not show until the cache expires.
      await makeBooking(db(), { status: BookingStatus.Pending });
      expect(kpi((await get('overview', { range: 'today' })).body.data, 'bookings').value).toBe(kpi(after, 'bookings').value);
    });

    it('uses stats_daily for rolled-up days (live for missing ones) and ranges work', async () => {
      const today = algiersDay(new Date());
      const day = addDays(today, -5000);
      await db().query('DELETE FROM stats_daily WHERE day = ?', [day]);
      await makeBooking(db(), { status: BookingStatus.Completed, createdAt: new Date(`${day}T10:00:00Z`), completedAt: new Date(`${day}T20:00:00Z`), total: '12000.00' });
      const live = await computeDailyMetrics(db(), day, day);
      expect(live.find((r) => r.metric === 'bookings_created')?.value).toBe('1.00');
      expect(live.find((r) => r.metric === 'booking_value')?.value).toBe('12000.00');
      await overview().rollup(day, day);
      expect((await readStats(db(), day, day)).sort((a, b) => (a.metric + a.dimension).localeCompare(b.metric + b.dimension))).toEqual(
        [...live].sort((a, b) => (a.metric + a.dimension).localeCompare(b.metric + b.dimension)),
      );
      await db().query("UPDATE stats_daily SET value = 7 WHERE day = ? AND metric = 'bookings_created'", [day]);
      const res = await get('overview', { range: 'custom', from: day, to: day }).expect(200);
      expect(res.body.data.kpis[0]).toMatchObject({ key: 'bookings', value: '7', previousValue: '0', deltaPercent: null });
      expect(res.body.data.bookingsPerDay).toEqual([{ date: day, requests: 7, completed: 1 }]);

      for (const range of ['7d', 'this_month']) {
        const r = await get('overview', { range }).expect(200);
        expect(r.body.data.period.to).toBe(today);
      }
      expect((await get('overview', { range: '7d' })).body.data.bookingsPerDay).toHaveLength(7);
    });

    it('validates the range', async () => {
      expectError(await get('overview', { range: 'year' }), 400, 'VALIDATION_FAILED');
      const missing = await get('overview', { range: 'custom' });
      expectError(missing, 400, 'VALIDATION_FAILED');
      expect(missing.body.details.map((d: any) => d.field).sort()).toEqual(['from', 'to']);
      expectError(await get('overview', { range: 'custom', from: '2026-09-10', to: '2026-09-01' }), 422, 'OVERVIEW_RANGE_INVALID');
      const ar = await get('overview', { range: 'custom', from: '2020-01-01', to: '2026-09-01' }).set('Accept-Language', 'ar');
      expectError(ar, 422, 'OVERVIEW_RANGE_INVALID');
      expect(ar.body.message).toContain('نطاق');
      expectError(await request(t.http).get(`${API}/overview`), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await get('overview', {}, client.headers), 403, 'FORBIDDEN_ROLE');
    });
  });

  // ── nav counts ─────────────────────────────────────────────

  describe('GET /admin/nav-counts', () => {
    it('counts attention items and unread conversations for the admin (cached 30 s)', async () => {
      const me = await loginAs(t, UserRole.Admin);
      overview().clearCache();
      const before = (await get('nav-counts', {}, me.headers).expect(200)).body.data;
      expect(Object.keys(before).sort()).toEqual(['academicRequestsPending', 'bookingsNoReply', 'disputesOpen', 'messagesReported', 'messagesUnread', 'reviewsReported', 'verificationsWaiting']);

      const { user: provider } = await makeProvider(db(), { user: { verificationStatus: VerificationStatus.Pending } });
      await makeUserDocument(db(), { userId: provider.id, fileId: (await makeFile(db(), { ownerId: provider.id })).id });
      await makeBooking(db(), { status: BookingStatus.Pending, createdAt: new Date(Date.now() - 72 * HOUR) });
      await makeDispute(db());
      await makeAcademicRequest(db());
      const review = await makeReview(db());
      await makeReport(db(), { targetId: review.id });
      await makeReport(db(), { targetId: review.id });
      const message = await makeMessage(db());
      await makeReport(db(), { targetType: ReportTargetType.Message, targetId: message.id });
      const conversation = await makeConversation(db(), { kind: ConversationKind.Support });
      await db().query('INSERT INTO conversation_participants (id, created_at, conversation_id, user_id, role, can_write, last_read_at) VALUES (UUID(), ?, ?, ?, ?, 1, NULL)', [
        new Date(),
        conversation.id,
        me.user.id,
        ParticipantRole.Support,
      ]);
      await makeMessage(db(), { conversationId: conversation.id, senderId: provider.id });

      expect((await get('nav-counts', {}, me.headers)).body.data).toEqual(before);
      overview().clearCache();
      const after = (await get('nav-counts', {}, me.headers)).body.data;
      expect(after.verificationsWaiting - before.verificationsWaiting).toBe(1);
      expect(after.bookingsNoReply - before.bookingsNoReply).toBe(1);
      expect(after.disputesOpen - before.disputesOpen).toBe(1);
      expect(after.academicRequestsPending - before.academicRequestsPending).toBe(1);
      expect(after.reviewsReported - before.reviewsReported).toBe(1);
      expect(after.messagesReported - before.messagesReported).toBe(1);
      expect(after).toMatchObject({ messagesUnread: before.messagesUnread + 1 });
      expectError(await request(t.http).get(`${API}/nav-counts`), 401, 'AUTH_TOKEN_MISSING');
    });
  });

  // ── search ─────────────────────────────────────────────────

  describe('GET /admin/search', () => {
    it('exact matches: EVT-, ACR-, DSP-, INV-, email and phone formats', async () => {
      const n = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
      const phone = `+2136${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
      const client = await makeUser(db(), { fullName: `Amina Benali ${uid()}`, email: `amina.${uid()}@gmail.com`, phone });
      const booking = await makeBooking(db(), { clientId: client.id, reference: `EVT-${n}` });
      const acr = await makeAcademicRequest(db(), { reference: `ACR-${n}` });
      const dispute = await makeDispute(db(), { reference: `DSP-${n}` });
      const invoice = await makeInvoice(db(), { bookingId: booking.id, number: `INV-2026-${n}` });

      const exact = async (q: string) => (await get('search', { q }).expect(200)).body.data.exactMatch;
      expect(await exact(`EVT-${n}`)).toEqual({ type: 'booking', id: booking.id, href: `/bookings/${booking.id}` });
      expect(await exact(`#evt-${n}`)).toMatchObject({ type: 'booking', id: booking.id });
      expect(await exact(`ACR-${n}`)).toEqual({ type: 'academic_request', id: acr.id, href: `/academic-requests/${acr.id}` });
      expect(await exact(`DSP-${n}`)).toEqual({ type: 'dispute', id: dispute.id, href: `/disputes/${dispute.id}` });
      expect(await exact(`INV-2026-${n}`)).toEqual({ type: 'invoice', id: invoice.id, href: `/bookings/${booking.id}/invoice` });
      expect(await exact(client.email.toUpperCase())).toEqual({ type: 'user', id: client.id, href: `/users/${client.id}` });
      expect(await exact(`0${phone.slice(4)}`)).toMatchObject({ type: 'user', id: client.id });
      expect(await exact(`+213 ${phone.slice(4, 7)} ${phone.slice(7)}`)).toMatchObject({ type: 'user', id: client.id });
      expect(await exact('EVT-999999999')).toBeNull();

      const byRef = (await get('search', { q: `EVT-${n}` })).body.data;
      expect(byRef.groups.map((g: any) => g.type)).toEqual(['users', 'services', 'bookings', 'requests', 'disputes', 'pages']);
      expect(byRef.groups.find((g: any) => g.type === 'bookings').items[0]).toMatchObject({ id: booking.id, title: `EVT-${n}`, href: `/bookings/${booking.id}`, badge: 'pending' });
    });

    it('scopes, limit, text matches and pages', async () => {
      const tag = uid();
      const { user: provider } = await makeProvider(db(), { user: { fullName: `Karim ${tag}` }, profile: { businessName: `Studio ${tag}` } });
      await makeService(db(), { providerId: provider.id, titleEn: `Wedding photo ${tag}` });
      await makeService(db(), { providerId: provider.id, titleEn: `Engagement photo ${tag}` });
      await makeUser(db(), { role: UserRole.Admin, fullName: `Admin ${tag}` });

      const all = (await get('search', { q: tag })).body.data;
      const group = (type: string) => all.groups.find((g: any) => g.type === type);
      expect(group('users').items).toEqual([{ id: provider.id, title: `Karim ${tag}`, subtitle: expect.stringContaining(`Studio ${tag}`), href: `/users/${provider.id}`, badge: 'provider' }]);
      expect(group('services').items).toHaveLength(2);
      expect(group('services').items[0]).toMatchObject({ subtitle: `Studio ${tag}`, badge: 'published', href: expect.stringMatching(/^\/services\//) });

      const scoped = (await get('search', { q: tag, scope: 'services', limit: 1 })).body.data;
      expect(scoped.groups).toEqual([{ type: 'services', items: [expect.any(Object)] }]);

      const pages = (await get('search', { q: 'التقييم', scope: 'pages' })).body.data.groups[0].items;
      expect(pages.map((p: any) => p.id)).toContain('reviews');
      expect((await get('search', { q: 'activity', scope: 'pages' })).body.data.groups[0].items[0]).toEqual({ id: 'activity-log', title: 'Activity log', subtitle: 'سجل النشاط', href: '/activity-log', badge: null });

      expectError(await get('search', {}), 400, 'VALIDATION_FAILED');
      expectError(await get('search', { q: '   ' }), 400, 'VALIDATION_FAILED');
      expectError(await get('search', { q: 'x', scope: 'files' }), 400, 'VALIDATION_FAILED');
      expectError(await get('search', { q: 'x', limit: 50 }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).get(`${API}/search`).query({ q: 'x' }), 401, 'AUTH_TOKEN_MISSING');
      const provider2 = await loginAs(t, UserRole.Provider);
      expectError(await get('search', { q: 'x' }, provider2.headers), 403, 'FORBIDDEN_ROLE');
    });
  });
});
