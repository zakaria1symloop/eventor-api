import request from 'supertest';
import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { Booking } from '../src/bookings/entities/booking.entity.js';
import { BookingStatus } from '../src/common/enums/booking.enums.js';
import { ConversationKind } from '../src/common/enums/messaging.enums.js';
import { ReportReason, ReportStatus, ReportTargetType, ReviewReplyStatus, ReviewStatus } from '../src/common/enums/moderation.enums.js';
import { UserRole } from '../src/common/enums/user.enums.js';
import { runInTransaction } from '../src/database/transaction.js';
import { Dispute } from '../src/disputes/entities/dispute.entity.js';
import { ExportRegistry } from '../src/exports/export-registry.js';
import { Report } from '../src/reviews/entities/report.entity.js';
import { ReviewReply } from '../src/reviews/entities/review-reply.entity.js';
import { Review } from '../src/reviews/entities/review.entity.js';
import { ReportsService } from '../src/reviews/reports.service.js';
import { ReviewsService } from '../src/reviews/reviews.service.js';
import { Service } from '../src/services/entities/service.entity.js';
import { ProviderProfile } from '../src/users/entities/provider-profile.entity.js';
import {
  createApp,
  expectError,
  loginAs,
  makeBooking,
  makeConversation,
  makeMessage,
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

const API = '/api/v1/admin';
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('Admin reviews & reports (e2e)', () => {
  let t: TestApp;
  let admin: LoggedIn;

  beforeAll(async () => {
    t = await createApp();
    admin = await loginAs(t, UserRole.Admin, { fullName: 'Omar Belaid' });
  });

  afterAll(async () => {
    await t?.close();
  });

  const db = () => t.dataSource;
  const audited = (action: string, objectId: string) => db().getRepository(AuditLog).findOneBy({ action, objectId });
  const notificationsOf = (userId: string, type: string) => db().query('SELECT * FROM notifications WHERE user_id = ? AND type = ?', [userId, type]);

  /** A provider with one service and N completed bookings reviewed with these ratings (through the shared write path). */
  async function reviewed(ratings: number[], comments: string[] = []) {
    const client = await makeUser(db(), { fullName: `Amina Benali ${uid()}` });
    const { user: provider } = await makeProvider(db(), { user: { fullName: `Karim Belkacem ${uid()}` }, profile: { businessName: `Studio Lumière ${uid()}` } });
    const service = await makeService(db(), { providerId: provider.id });
    const reviews: string[] = [];
    for (const [i, rating] of ratings.entries()) {
      const booking = await makeBooking(db(), { clientId: client.id, providerId: provider.id, serviceId: service.id, status: BookingStatus.Completed, completedAt: new Date(Date.now() - 3 * 86_400_000) });
      const inserted = await runInTransaction(db(), (em, afterCommit) =>
        t.get(ReviewsService).createInTransaction(em, afterCommit, { bookingId: booking.id, rating, comment: comments[i] ?? `Très bien ${uid()}` }),
      );
      reviews.push(inserted.id);
    }
    return { client, provider, service, reviews };
  }

  const ratingOf = async (serviceId: string, providerId: string) => {
    const s = await db().getRepository(Service).findOneByOrFail({ id: serviceId });
    const p = await db().getRepository(ProviderProfile).findOneByOrFail({ userId: providerId });
    return { service: [Number(s.avgRating), s.ratingCount], provider: [Number(p.avgRating), p.ratingCount] };
  };

  // ── create path (mobile / seed) ────────────────────────────

  describe('review insert (flag scan)', () => {
    it('flags contact details, creates an automatic report (reporter null) and notifies every admin', async () => {
      const other = await loginAs(t, UserRole.Admin, { language: 'ar' as never });
      const ctx = await reviewed([5], ['Super ! Appelez-moi au 0661 20 41 02 pour moins cher.']);
      const review = await db().getRepository(Review).findOneByOrFail({ id: ctx.reviews[0]! });
      expect(review).toMatchObject({ status: ReviewStatus.Published, detectedFlags: ['phone'], hadDispute: false });
      const [report] = await db().getRepository(Report).findBy({ targetId: review.id });
      expect(report).toMatchObject({ reporterId: null, reason: ReportReason.ContactOutside, status: ReportStatus.Open, targetType: ReportTargetType.Review });
      expect(await ratingOf(ctx.service.id, ctx.provider.id)).toEqual({ service: [5, 1], provider: [5, 1] });

      const [en] = await notificationsOf(admin.user.id, 'review.reported');
      expect(en).toBeDefined();
      const rows = await db().query("SELECT user_id, title, data FROM notifications WHERE type = 'review.reported' AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.reviewId')) = ?", [review.id]);
      const byUser = new Map(rows.map((r: any) => [r.user_id, r]));
      expect((byUser.get(admin.user.id) as any).title).toBe('Review reported');
      expect((byUser.get(other.user.id) as any).title).toBe('تم الإبلاغ عن تقييم');
      expect((byUser.get(admin.user.id) as any).data).toMatchObject({ href: `/reviews/${review.id}`, reportId: report!.id });
    });
  });

  // ── list & detail ──────────────────────────────────────────

  describe('GET /admin/reviews', () => {
    it('lists with tabs, counts, filters, search and sort', async () => {
      const ctx = await reviewed([5, 2, 4], ['Photos magnifiques', 'Retard énorme, escroc', 'Bonne équipe']);
      const [five, two, four] = ctx.reviews as [string, string, string];
      await db().getRepository(Review).update(four, { status: ReviewStatus.Hidden });
      const list = (query: Record<string, unknown>) => request(t.http).get(`${API}/reviews`).set(admin.headers).query({ providerId: ctx.provider.id, ...query });

      const all = await list({}).expect(200);
      expect(all.body.meta).toMatchObject({ page: 1, limit: 20, total: 3, totalPages: 1, counts: { all: 3, published: 2, reported: 1, hidden: 1, redacted: 0 } });
      const row = all.body.data.find((r: any) => r.id === two);
      expect(row).toMatchObject({
        rating: 2,
        status: 'published',
        author: { id: ctx.client.id },
        provider: { id: ctx.provider.id, businessName: expect.stringContaining('Studio Lumière') },
        service: { id: ctx.service.id },
        pack: null,
        booking: { id: expect.any(String), reference: expect.any(String) },
        hadDispute: false,
        detectedFlags: ['insult'],
        reportsOpen: 1,
        reply: null,
        editedAt: null,
      });

      expect((await list({ tab: 'reported' })).body.data.map((r: any) => r.id)).toEqual([two]);
      expect((await list({ tab: 'hidden' })).body.data.map((r: any) => r.id)).toEqual([four]);
      expect((await list({ rating: ['4', '5'] })).body.data.map((r: any) => r.id).sort()).toEqual([five, four].sort());
      expect((await list({ ratingMin: 2, ratingMax: 3 })).body.data.map((r: any) => r.id)).toEqual([two]);
      expect((await list({ flagged: 'true' })).body.data.map((r: any) => r.id)).toEqual([two]);
      expect((await list({ flagged: 'false' })).body.meta.total).toBe(2);
      expect((await list({ serviceId: ctx.service.id, authorId: ctx.client.id, hadDispute: 'false' })).body.meta.total).toBe(3);
      expect((await list({ q: 'magnifiques' })).body.data.map((r: any) => r.id)).toEqual([five]);
      expect((await request(t.http).get(`${API}/reviews`).set(admin.headers).query({ q: ctx.provider.fullName })).body.meta.total).toBe(3);
      expect((await list({ sort: 'rating:asc' })).body.data.map((r: any) => r.rating)).toEqual([2, 4, 5]);
      const today = new Date().toISOString().slice(0, 10);
      expect((await list({ createdFrom: today, createdTo: today })).body.meta.total).toBe(3);
      expect((await list({ createdTo: '2020-01-01' })).body.meta.total).toBe(0);
      expect((await list({ limit: 1, page: 2, sort: 'rating:desc' })).body).toMatchObject({ data: [{ rating: 4 }], meta: { page: 2, limit: 1, total: 3, totalPages: 3 } });
    });

    it('400 on bad filters, 401 / 403, export registered', async () => {
      expectError(await request(t.http).get(`${API}/reviews`).set(admin.headers).query({ rating: 6 }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).get(`${API}/reviews`).set(admin.headers).query({ tab: 'nope' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).get(`${API}/reviews`).set(admin.headers).query({ sort: 'comment:asc' }), 400, 'SORT_FIELD_NOT_ALLOWED');
      expectError(await request(t.http).get(`${API}/reviews`), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).get(`${API}/reviews`).set(client.headers), 403, 'FORBIDDEN_ROLE');
      expect(t.get(ExportRegistry).get('reviews')).toBeDefined();
      expect(t.get(ExportRegistry).get('reports')).toBeDefined();
    });
  });

  describe('GET /admin/reviews/:id', () => {
    it('returns full text, reply, reports on review and reply, disputes and allowed actions', async () => {
      const ctx = await reviewed([1], ['Une arnaque totale, rien ne correspondait au devis signé il y a deux mois.']);
      const id = ctx.reviews[0]!;
      const reply = await runInTransaction(db(), (em, afterCommit) => t.get(ReviewsService).createReplyInTransaction(em, afterCommit, { reviewId: id, body: 'Merci, contactez-moi sur wa.me/213661204102' }));
      expect(reply.reportId).toBeTruthy();
      const res = await request(t.http).get(`${API}/reviews/${id}`).set(admin.headers).expect(200);
      expect(res.body.data).toMatchObject({
        id,
        comment: 'Une arnaque totale, rien ne correspondait au devis signé il y a deux mois.',
        reply: { id: reply.id, status: 'published', provider: { id: ctx.provider.id }, reportsOpen: 1, moderatedBy: null },
        booking: { status: 'completed', disputeStatus: 'none', total: '45000.00' },
        disputes: [],
        moderatedBy: null,
        allowedActions: ['hide', 'redact', 'dismiss_reports', 'edit', 'delete', 'convert_report'],
      });
      expect(res.body.data.reports.map((r: any) => r.targetType).sort()).toEqual(['review', 'review_reply']);
      expect(res.body.data.reports[0]).toMatchObject({ reporter: null, status: 'open' });
      expectError(await request(t.http).get(`${API}/reviews/${MISSING}`).set(admin.headers).set('Accept-Language', 'ar'), 404, 'REVIEW_NOT_FOUND');
      const ar = await request(t.http).get(`${API}/reviews/not-a-uuid`).set(admin.headers).set('Accept-Language', 'ar');
      expect(ar.body.message).toBe('التقييم غير موجود.');
    });
  });

  // ── moderation ─────────────────────────────────────────────

  describe('POST /admin/reviews/:id/moderate', () => {
    it('hide → show → redact recompute ratings, resolve reports, audit and notify the author', async () => {
      const ctx = await reviewed([5, 1], ['Parfait', 'Nul, appelez le 0555 12 34 56']);
      const [good, bad] = ctx.reviews as [string, string];
      const reporter = await makeUser(db());
      await makeReport(db(), { reporterId: reporter.id, targetId: bad, reason: ReportReason.Inappropriate });
      expect(await ratingOf(ctx.service.id, ctx.provider.id)).toEqual({ service: [3, 2], provider: [3, 2] });

      const moderate = (id: string, body: Record<string, unknown>) => request(t.http).post(`${API}/reviews/${id}/moderate`).set(admin.headers).send(body);
      const hidden = await moderate(bad, { action: 'hide', note: 'Insults and phone number.' }).expect(200);
      expect(hidden.body.data).toMatchObject({ status: 'hidden', reportsOpen: 0, moderatedBy: { id: admin.user.id }, moderationNote: 'Insults and phone number.' });
      expect(hidden.body.data.reports.every((r: any) => r.status === 'resolved')).toBe(true);
      expect(await ratingOf(ctx.service.id, ctx.provider.id)).toEqual({ service: [5, 1], provider: [5, 1] });
      expect(await audited('review.hidden', bad)).toMatchObject({ actorId: admin.user.id, changes: expect.objectContaining({ status: { from: 'published', to: 'hidden' }, reportsResolved: 2 }) });
      expect(await notificationsOf(ctx.client.id, 'review.hidden')).toHaveLength(1);
      expect(await notificationsOf(reporter.id, 'report.resolved')).toHaveLength(1);

      expectError(await moderate(bad, { action: 'hide' }), 409, 'REVIEW_INVALID_TRANSITION');
      expectError(await moderate(good, { action: 'show' }), 409, 'REVIEW_INVALID_TRANSITION');

      await moderate(bad, { action: 'show', notifyAuthor: false }).expect(200);
      expect(await ratingOf(ctx.service.id, ctx.provider.id)).toEqual({ service: [3, 2], provider: [3, 2] });
      expect(await notificationsOf(ctx.client.id, 'review.shown')).toHaveLength(0);

      const redacted = await moderate(bad, { action: 'redact', redactedComment: 'Nul, appelez le [phone hidden]' }).expect(200);
      expect(redacted.body.data).toMatchObject({ status: 'redacted', redactedComment: 'Nul, appelez le [phone hidden]', allowedActions: ['hide', 'show', 'redact', 'edit', 'delete'] });
      expect(await ratingOf(ctx.service.id, ctx.provider.id)).toEqual({ service: [3, 2], provider: [3, 2] });
      expect(await audited('review.redacted', bad)).toBeTruthy();
    });

    it('redact requires the text; validation and 404', async () => {
      const ctx = await reviewed([4]);
      const id = ctx.reviews[0]!;
      const res = await request(t.http).post(`${API}/reviews/${id}/moderate`).set(admin.headers).send({ action: 'redact' });
      expectError(res, 400, 'VALIDATION_FAILED');
      expect(res.body.details.map((d: any) => d.field)).toContain('redactedComment');
      expectError(await request(t.http).post(`${API}/reviews/${id}/moderate`).set(admin.headers).send({ action: 'delete' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${API}/reviews/${id}/moderate`).set(admin.headers).send({}), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${API}/reviews/${id}/moderate`).set(admin.headers).send({ action: 'hide', extra: 1 }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${API}/reviews/${MISSING}/moderate`).set(admin.headers).send({ action: 'hide' }), 404, 'REVIEW_NOT_FOUND');
      expectError(await request(t.http).post(`${API}/reviews/${id}/moderate`).send({ action: 'hide' }), 401, 'AUTH_TOKEN_MISSING');
    });

    it('dismiss_reports keeps the status and needs open reports', async () => {
      const ctx = await reviewed([3]);
      const id = ctx.reviews[0]!;
      expectError(await request(t.http).post(`${API}/reviews/${id}/moderate`).set(admin.headers).send({ action: 'dismiss_reports' }), 409, 'REVIEW_NO_OPEN_REPORTS');
      const reporter = await makeUser(db());
      await makeReport(db(), { reporterId: reporter.id, targetId: id });
      const res = await request(t.http).post(`${API}/reviews/${id}/moderate`).set(admin.headers).send({ action: 'dismiss_reports', note: 'Honest opinion.' }).expect(200);
      expect(res.body.data).toMatchObject({ status: 'published', reportsOpen: 0, reports: [expect.objectContaining({ status: 'dismissed', resolutionNote: 'Honest opinion.' })] });
      expect(await audited('review.reports_dismissed', id)).toBeTruthy();
      expect(await notificationsOf(reporter.id, 'report.dismissed')).toHaveLength(1);
    });
  });

  describe('PATCH / DELETE /admin/reviews/:id', () => {
    it('edits the text with a reason (flags rescanned, audit keeps both texts)', async () => {
      const ctx = await reviewed([4], ['Appelez-moi au 0661 20 41 02']);
      const id = ctx.reviews[0]!;
      const res = await request(t.http).patch(`${API}/reviews/${id}`).set(admin.headers).send({ comment: '  Très bonne prestation.  ', reason: 'Author asked to remove the phone.' }).expect(200);
      expect(res.body.data).toMatchObject({ comment: 'Très bonne prestation.', detectedFlags: [] });
      expect(await audited('review.edited', id)).toMatchObject({ note: 'Author asked to remove the phone.', changes: expect.objectContaining({ comment: { from: 'Appelez-moi au 0661 20 41 02', to: 'Très bonne prestation.' } }) });
      expectError(await request(t.http).patch(`${API}/reviews/${id}`).set(admin.headers).send({ comment: 'x' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).patch(`${API}/reviews/${MISSING}`).set(admin.headers).send({ comment: 'x', reason: 'y' }), 404, 'REVIEW_NOT_FOUND');
    });

    it('soft deletes with a reason, resolves reports and recomputes ratings', async () => {
      const ctx = await reviewed([5, 1]);
      const [, bad] = ctx.reviews as [string, string];
      await makeReport(db(), { reporterId: (await makeUser(db())).id, targetId: bad });
      expectError(await request(t.http).delete(`${API}/reviews/${bad}`).set(admin.headers).send({}), 400, 'VALIDATION_FAILED');
      const res = await request(t.http).delete(`${API}/reviews/${bad}`).set(admin.headers).send({ reason: 'Fake review.' }).expect(200);
      expect(res.body.data).toEqual({ id: bad, deletedAt: expect.any(String), reportsResolved: 1 });
      expect(await db().getRepository(Review).findOne({ where: { id: bad }, withDeleted: true })).toMatchObject({ deletedAt: expect.any(Date) });
      expect(await ratingOf(ctx.service.id, ctx.provider.id)).toEqual({ service: [5, 1], provider: [5, 1] });
      expect(await audited('review.deleted', bad)).toMatchObject({ level: 'sensitive', note: 'Fake review.' });
      expectError(await request(t.http).get(`${API}/reviews/${bad}`).set(admin.headers), 404, 'REVIEW_NOT_FOUND');
      expectError(await request(t.http).delete(`${API}/reviews/${bad}`).set(admin.headers).send({ reason: 'again' }), 404, 'REVIEW_NOT_FOUND');
    });

    it('recomputes pack ratings too', async () => {
      const { user: provider } = await makeProvider(db());
      const pack = await makePack(db(), { providerId: provider.id });
      const booking = await makeBooking(db(), { providerId: provider.id, packId: pack.id, serviceId: null, status: BookingStatus.Completed });
      const review = await makeReview(db(), { bookingId: booking.id, rating: 2 });
      await request(t.http).post(`${API}/reviews/${review.id}/moderate`).set(admin.headers).send({ action: 'redact', redactedComment: 'ok' }).expect(200);
      const [row] = await db().query('SELECT avg_rating, rating_count FROM packs WHERE id = ?', [pack.id]);
      expect([Number(row.avg_rating), Number(row.rating_count)]).toEqual([2, 1]);
    });
  });

  // ── replies ────────────────────────────────────────────────

  describe('review replies', () => {
    it('hide / show / delete with audit and provider notification', async () => {
      const ctx = await reviewed([4]);
      const reviewId = ctx.reviews[0]!;
      const reply = await runInTransaction(db(), (em, afterCommit) => t.get(ReviewsService).createReplyInTransaction(em, afterCommit, { reviewId, body: 'Merci beaucoup !' }));
      const base = `${API}/review-replies/${reply.id}`;

      const hidden = await request(t.http).post(`${base}/hide`).set(admin.headers).send({ note: 'Off topic.' }).expect(200);
      expect(hidden.body.data).toMatchObject({ id: reviewId, reply: { id: reply.id, status: 'hidden', moderatedBy: { id: admin.user.id } } });
      expect(await audited('review_reply.hidden', reply.id)).toMatchObject({ note: 'Off topic.' });
      expect(await notificationsOf(ctx.provider.id, 'review_reply.hidden')).toHaveLength(1);
      expectError(await request(t.http).post(`${base}/hide`).set(admin.headers).send({}), 409, 'REVIEW_REPLY_INVALID_TRANSITION');

      await request(t.http).post(`${base}/show`).set(admin.headers).send({}).expect(200);
      expect((await db().getRepository(ReviewReply).findOneByOrFail({ id: reply.id })).status).toBe(ReviewReplyStatus.Published);
      expectError(await request(t.http).post(`${base}/show`).set(admin.headers).send({}), 409, 'REVIEW_REPLY_INVALID_TRANSITION');
      expectError(await request(t.http).post(`${base}/hide`).set(admin.headers).send({ nope: true }), 400, 'VALIDATION_FAILED');

      const deleted = await request(t.http).delete(base).set(admin.headers).expect(200);
      expect(deleted.body.data).toEqual({ id: reply.id, reviewId, deletedAt: expect.any(String) });
      expect((await request(t.http).get(`${API}/reviews/${reviewId}`).set(admin.headers)).body.data.reply).toBeNull();
      expect(await audited('review_reply.deleted', reply.id)).toBeTruthy();
      expectError(await request(t.http).post(`${base}/show`).set(admin.headers).send({}), 404, 'REVIEW_REPLY_NOT_FOUND');
      expectError(await request(t.http).delete(`${API}/review-replies/${MISSING}`).set(admin.headers), 404, 'REVIEW_REPLY_NOT_FOUND');
    });
  });

  // ── reports ────────────────────────────────────────────────

  describe('GET /admin/reports', () => {
    it('lists by tab with target summaries, filters and counts', async () => {
      const reporter = await makeUser(db(), { fullName: `Reporter ${uid()}` });
      const ctx = await reviewed([2]);
      const service = await makeService(db());
      const { user: target } = await makeProvider(db());
      const conversation = await makeConversation(db(), { kind: ConversationKind.Direct });
      const message = await makeMessage(db(), { conversationId: conversation.id, body: 'Mon numéro 0661 20 41 02' });
      const r1 = await makeReport(db(), { reporterId: reporter.id, targetId: ctx.reviews[0]!, reason: ReportReason.Fake });
      const r2 = await makeReport(db(), { reporterId: reporter.id, targetType: ReportTargetType.Service, targetId: service.id, reason: ReportReason.Spam, status: ReportStatus.Dismissed });
      const r3 = await makeReport(db(), { reporterId: reporter.id, targetType: ReportTargetType.User, targetId: target.id, reason: ReportReason.Harassment, status: ReportStatus.Resolved });
      const r4 = await makeReport(db(), { reporterId: reporter.id, targetType: ReportTargetType.Message, targetId: message.id, reason: ReportReason.ContactOutside });
      const mine = (body: any) => body.data.filter((r: any) => r.reporter?.id === reporter.id);

      const open = await request(t.http).get(`${API}/reports`).set(admin.headers).query({ limit: 100, sort: 'createdAt:desc' }).expect(200);
      expect(mine(open.body).map((r: any) => r.id).sort()).toEqual([r1.id, r4.id].sort());
      expect(open.body.meta.counts).toEqual({ open: expect.any(Number), resolved: expect.any(Number), dismissed: expect.any(Number), all: expect.any(Number) });
      const reviewRow = mine(open.body).find((r: any) => r.id === r1.id);
      expect(reviewRow).toMatchObject({
        targetType: 'review',
        reason: 'fake',
        status: 'open',
        reporter: { id: reporter.id, fullName: reporter.fullName },
        target: { label: expect.stringContaining('★2'), href: `/reviews/${ctx.reviews[0]}`, reviewId: ctx.reviews[0], bookingId: expect.any(String), exists: true },
        resolvedBy: null,
        disputeId: null,
      });
      expect(mine(open.body).find((r: any) => r.id === r4.id).target).toMatchObject({ conversationId: conversation.id, bookingId: null, href: `/messages/${conversation.id}?message=${message.id}` });

      const all = await request(t.http).get(`${API}/reports`).set(admin.headers).query({ tab: 'all', limit: 100, sort: 'createdAt:desc' });
      expect(mine(all.body)).toHaveLength(4);
      expect(mine((await request(t.http).get(`${API}/reports`).set(admin.headers).query({ tab: 'dismissed', limit: 100, sort: 'createdAt:desc' })).body).map((r: any) => r.id)).toEqual([r2.id]);
      expect(mine((await request(t.http).get(`${API}/reports`).set(admin.headers).query({ tab: 'resolved', limit: 100, sort: 'createdAt:desc' })).body)[0]).toMatchObject({ id: r3.id, target: { href: `/users/${target.id}` } });
      expect(mine((await request(t.http).get(`${API}/reports`).set(admin.headers).query({ tab: 'all', targetType: ['service', 'user'], limit: 100, sort: 'createdAt:desc' })).body)).toHaveLength(2);
      expect(mine((await request(t.http).get(`${API}/reports`).set(admin.headers).query({ tab: 'all', reason: 'harassment', limit: 100, sort: 'createdAt:desc' })).body)).toHaveLength(1);
      expect(mine((await request(t.http).get(`${API}/reports`).set(admin.headers).query({ tab: 'all', createdTo: '2020-01-01', limit: 100, sort: 'createdAt:desc' })).body)).toHaveLength(0);
      expectError(await request(t.http).get(`${API}/reports`).set(admin.headers).query({ targetType: 'booking' }), 400, 'VALIDATION_FAILED');

      const one = await request(t.http).get(`${API}/reports/${r2.id}`).set(admin.headers).expect(200);
      expect(one.body.data).toMatchObject({ id: r2.id, target: { href: `/services/${service.id}` } });
      expectError(await request(t.http).get(`${API}/reports/${MISSING}`).set(admin.headers), 404, 'REPORT_NOT_FOUND');
    });
  });

  describe('POST /admin/reports/:id/resolve | dismiss', () => {
    it('resolve closes every open report on the target; dismiss only one; both notify reporters', async () => {
      const service = await makeService(db());
      const [a, b, c] = await Promise.all([makeUser(db()), makeUser(db()), makeUser(db())]);
      const r1 = await makeReport(db(), { reporterId: a.id, targetType: ReportTargetType.Service, targetId: service.id });
      const r2 = await makeReport(db(), { reporterId: b.id, targetType: ReportTargetType.Service, targetId: service.id });
      const pack = await makePack(db());
      const r3 = await makeReport(db(), { reporterId: c.id, targetType: ReportTargetType.Pack, targetId: pack.id });

      expectError(await request(t.http).post(`${API}/reports/${r1.id}/resolve`).set(admin.headers).send({}), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${API}/reports/${r1.id}/resolve`).set(admin.headers).send({ note: 'x', action: 'nuke' }), 400, 'VALIDATION_FAILED');
      const res = await request(t.http).post(`${API}/reports/${r1.id}/resolve`).set(admin.headers).send({ note: 'Service hidden.', action: 'service_hidden' }).expect(200);
      expect(res.body.data).toMatchObject({ id: r1.id, status: 'resolved', resolvedBy: { id: admin.user.id }, resolutionNote: 'Service hidden.', resolvedAt: expect.any(String) });
      expect((await db().getRepository(Report).findOneByOrFail({ id: r2.id })).status).toBe(ReportStatus.Resolved);
      expect(await audited('report.resolved', r1.id)).toMatchObject({ changes: expect.objectContaining({ action: 'service_hidden' }) });
      expect(await notificationsOf(a.id, 'report.resolved')).toHaveLength(1);
      expect(await notificationsOf(b.id, 'report.resolved')).toHaveLength(1);
      expectError(await request(t.http).post(`${API}/reports/${r2.id}/resolve`).set(admin.headers).send({ note: 'again' }), 409, 'REPORT_INVALID_TRANSITION');
      expectError(await request(t.http).post(`${API}/reports/${r2.id}/dismiss`).set(admin.headers).set('Accept-Language', 'ar').send({ note: 'again' }), 409, 'REPORT_INVALID_TRANSITION');

      const dismissed = await request(t.http).post(`${API}/reports/${r3.id}/dismiss`).set(admin.headers).send({ note: 'Price is correct.' }).expect(200);
      expect(dismissed.body.data).toMatchObject({ status: 'dismissed', resolutionNote: 'Price is correct.' });
      expect(await audited('report.dismissed', r3.id)).toBeTruthy();
      expect(await notificationsOf(c.id, 'report.dismissed')).toHaveLength(1);
      expectError(await request(t.http).post(`${API}/reports/${MISSING}/dismiss`).set(admin.headers).send({ note: 'x' }), 404, 'REPORT_NOT_FOUND');
      const provider = await loginAs(t, UserRole.Provider);
      expectError(await request(t.http).post(`${API}/reports/${r3.id}/dismiss`).set(provider.headers).send({ note: 'x' }), 403, 'FORBIDDEN_ROLE');
    });

    it('POST /admin/messages/:id/reports/dismiss dismisses every open report on a message', async () => {
      const message = await makeMessage(db(), { body: 'wa.me/213661204102' });
      const [a, b] = await Promise.all([makeUser(db()), makeUser(db())]);
      await makeReport(db(), { reporterId: a.id, targetType: ReportTargetType.Message, targetId: message.id });
      await makeReport(db(), { reporterId: b.id, targetType: ReportTargetType.Message, targetId: message.id });
      const url = `${API}/messages/${message.id}/reports/dismiss`;
      expectError(await request(t.http).post(url).set(admin.headers).send({}), 400, 'VALIDATION_FAILED');
      const res = await request(t.http).post(url).set(admin.headers).send({ note: 'Link to the provider page, allowed.' }).expect(200);
      expect(res.body.data).toEqual({ messageId: message.id, dismissed: 2 });
      expect(await audited('message.reports_dismissed', message.id)).toBeTruthy();
      expectError(await request(t.http).post(url).set(admin.headers).send({ note: 'again' }), 409, 'MESSAGE_NO_OPEN_REPORTS');
      expectError(await request(t.http).post(`${API}/messages/${MISSING}/reports/dismiss`).set(admin.headers).send({ note: 'x' }), 404, 'MESSAGE_NOT_FOUND');
    });
  });

  describe('POST /admin/reports/:id/convert-to-dispute', () => {
    const body = { type: 'service_not_as_described', openedByRole: 'client', description: 'The client says the photos were never delivered, as written in the review.' };

    it('converts a review report: dispute opened on its booking, reports resolved with dispute id', async () => {
      const ctx = await reviewed([1]);
      const reviewId = ctx.reviews[0]!;
      const reporter = await makeUser(db());
      const report = await makeReport(db(), { reporterId: reporter.id, targetId: reviewId, reason: ReportReason.Other });
      const other = await makeReport(db(), { reporterId: ctx.provider.id, targetId: reviewId, reason: ReportReason.Fake });

      expectError(await request(t.http).post(`${API}/reports/${report.id}/convert-to-dispute`).set(admin.headers).send({ ...body, description: 'too short' }), 400, 'VALIDATION_FAILED');
      const res = await request(t.http).post(`${API}/reports/${report.id}/convert-to-dispute`).set(admin.headers).send(body).expect(200);
      expect(res.body.data).toMatchObject({ id: report.id, status: 'resolved', disputeId: expect.any(String), disputeReference: expect.stringMatching(/^DSP-\d{6}$/), resolutionNote: expect.stringContaining('Converted to dispute') });
      const dispute = await db().getRepository(Dispute).findOneByOrFail({ id: res.body.data.disputeId });
      const review = await db().getRepository(Review).findOneByOrFail({ id: reviewId });
      expect(dispute).toMatchObject({ bookingId: review.bookingId, openedById: ctx.client.id, type: 'service_not_as_described' });
      expect((await db().getRepository(Booking).findOneByOrFail({ id: review.bookingId })).disputeStatus).toBe('open');
      expect(await db().getRepository(Report).findOneByOrFail({ id: other.id })).toMatchObject({ status: ReportStatus.Resolved, disputeId: dispute.id });
      expect(await audited('report.converted_to_dispute', report.id)).toBeTruthy();
      expect(await audited('dispute.opened', dispute.id)).toMatchObject({ note: expect.stringContaining('Converted from report') });
      expect(await notificationsOf(admin.user.id, 'dispute.opened')).not.toHaveLength(0);
      expectError(await request(t.http).post(`${API}/reports/${report.id}/convert-to-dispute`).set(admin.headers).send(body), 409, 'REPORT_INVALID_TRANSITION');
    });

    it('converts a message report through its conversation booking', async () => {
      const booking = await makeBooking(db(), { status: BookingStatus.Accepted, eventDate: '2026-01-10' });
      const conversation = await makeConversation(db(), { kind: ConversationKind.Direct, bookingId: booking.id });
      const message = await makeMessage(db(), { conversationId: conversation.id, senderId: booking.providerId });
      const report = await makeReport(db(), { reporterId: booking.clientId, targetType: ReportTargetType.Message, targetId: message.id });
      const res = await request(t.http).post(`${API}/reports/${report.id}/convert-to-dispute`).set(admin.headers).send({ ...body, type: 'behaviour' }).expect(200);
      expect(res.body.data.target).toMatchObject({ bookingId: booking.id });
      expect((await db().getRepository(Dispute).findOneByOrFail({ id: res.body.data.disputeId })).bookingId).toBe(booking.id);
    });

    it('422 REPORT_NOT_CONVERTIBLE without a booking; booking rules apply; rolls back', async () => {
      const service = await makeService(db());
      const serviceReport = await makeReport(db(), { reporterId: (await makeUser(db())).id, targetType: ReportTargetType.Service, targetId: service.id });
      expectError(await request(t.http).post(`${API}/reports/${serviceReport.id}/convert-to-dispute`).set(admin.headers).send(body), 422, 'REPORT_NOT_CONVERTIBLE');
      const message = await makeMessage(db());
      const messageReport = await makeReport(db(), { reporterId: (await makeUser(db())).id, targetType: ReportTargetType.Message, targetId: message.id });
      const ar = await request(t.http).post(`${API}/reports/${messageReport.id}/convert-to-dispute`).set(admin.headers).set('Accept-Language', 'ar').send(body);
      expectError(ar, 422, 'REPORT_NOT_CONVERTIBLE');
      expect(ar.body.message).toContain('نزاع');

      const pending = await makeBooking(db(), { status: BookingStatus.Pending });
      const conversation = await makeConversation(db(), { bookingId: pending.id });
      const msg = await makeMessage(db(), { conversationId: conversation.id });
      const r = await makeReport(db(), { reporterId: pending.clientId, targetType: ReportTargetType.Message, targetId: msg.id });
      expectError(await request(t.http).post(`${API}/reports/${r.id}/convert-to-dispute`).set(admin.headers).send(body), 422, 'BOOKING_NOT_DISPUTABLE');
      expect((await db().getRepository(Report).findOneByOrFail({ id: r.id })).status).toBe(ReportStatus.Open);
    });
  });

  describe('ReportsService.createInTransaction', () => {
    it('one open report per reporter and target; notifies admins with the message type', async () => {
      const message = await makeMessage(db());
      const reporter = await makeUser(db());
      const create = () =>
        runInTransaction(db(), (em, afterCommit) =>
          t.get(ReportsService).createInTransaction(em, afterCommit, { reporterId: reporter.id, targetType: ReportTargetType.Message, targetId: message.id, reason: ReportReason.Spam }),
        );
      const first = await create();
      const second = await create();
      expect(first.created).toBe(true);
      expect(second).toEqual({ id: first.id, created: false });
      const rows = await db().query("SELECT COUNT(*) AS n FROM notifications WHERE type = 'message.reported' AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.reportId')) = ?", [first.id]);
      const [{ n: admins }] = await db().query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL");
      expect(Number(rows[0].n)).toBe(Number(admins));
    });
  });
});
