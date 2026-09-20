import { EventEmitter2 } from '@nestjs/event-emitter';
import sharp from 'sharp';
import request from 'supertest';
import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { BookingJobsService } from '../src/bookings/booking-jobs.service.js';
import { addDays } from '../src/bookings/bookings.policy.js';
import { algiersToday } from '../src/bookings/bookings.service.js';
import { Booking } from '../src/bookings/entities/booking.entity.js';
import { BookingDisputeStatus, BookingStatus } from '../src/common/enums/booking.enums.js';
import { FilePurpose } from '../src/common/enums/file.enums.js';
import { ConversationKind, ConversationStatus, ParticipantRole } from '../src/common/enums/messaging.enums.js';
import { DisputeEvidenceKind, DisputeStatus, DisputeType } from '../src/common/enums/moderation.enums.js';
import { PartyRole, UserRole } from '../src/common/enums/user.enums.js';
import { DisputesService } from '../src/disputes/disputes.service.js';
import { DisputeEvidence } from '../src/disputes/entities/dispute-evidence.entity.js';
import { Dispute } from '../src/disputes/entities/dispute.entity.js';
import { ExportRegistry } from '../src/exports/export-registry.js';
import { MailService } from '../src/mail/mail.service.js';
import { ConversationParticipant } from '../src/messaging/entities/conversation-participant.entity.js';
import { Conversation } from '../src/messaging/entities/conversation.entity.js';
import {
  createApp,
  expectError,
  loginAs,
  makeBooking,
  makeConversation,
  makeDispute,
  makeFile,
  makeInvoice,
  makeMessage,
  makeProvider,
  makeService,
  makeUser,
  uid,
  type LoggedIn,
  type TestApp,
} from './utils/index.js';

const BASE = '/api/v1/admin/disputes';
const MISSING = '00000000-0000-4000-8000-000000000000';
const DAY = 86_400_000;
const png = () => sharp({ create: { width: 32, height: 32, channels: 3, background: '#c33' } }).png().toBuffer();
const DESCRIPTION = 'The DJ never came to the wedding and did not answer our calls that evening.';

describe('Admin disputes (e2e)', () => {
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
  const reloadBooking = (id: string) => db().getRepository(Booking).findOneByOrFail({ id });
  const reloadDispute = (id: string) => db().getRepository(Dispute).findOneByOrFail({ id });
  const lastMailTo = (email: string) => [...t.get(MailService).outbox].reverse().find((m) => m.to === email);
  const yesterday = () => addDays(algiersToday(), -1);
  const recordEvents = (name: string) => {
    const seen: any[] = [];
    const listener = (payload: unknown) => seen.push(payload);
    t.get(EventEmitter2).on(name, listener);
    return { seen, stop: () => t.get(EventEmitter2).off(name, listener) };
  };

  /** An accepted booking whose event was yesterday evening (inside the 72 h window), with a direct chat. */
  async function disputable(overrides: Partial<Booking> = {}, options: { chat?: boolean } = {}) {
    const client = await makeUser(db(), { fullName: `Karima Ait ${uid()}` });
    const { user: provider } = await makeProvider(db(), { user: { fullName: `Yacine Meddour ${uid()}` } });
    const service = await makeService(db(), { providerId: provider.id });
    const booking = await makeBooking(db(), {
      clientId: client.id,
      providerId: provider.id,
      serviceId: service.id,
      status: BookingStatus.Accepted,
      eventDate: yesterday(),
      startTime: '18:00:00',
      endTime: '23:00:00',
      ...overrides,
    } as never);
    let chat: Conversation | null = null;
    if (options.chat !== false) {
      chat = await makeConversation(db(), { kind: ConversationKind.Direct, bookingId: booking.id });
      await makeMessage(db(), { conversationId: chat.id, senderId: client.id, body: 'Are you on your way?' });
    }
    return { client, provider, service, booking, chat };
  }

  const open = (body: Record<string, unknown>, headers = admin.headers) => request(t.http).post(BASE).set(headers).send(body);

  async function openFor(ctx: Awaited<ReturnType<typeof disputable>>, extra: Record<string, unknown> = {}) {
    const res = await open({ bookingId: ctx.booking.id, openedByRole: 'client', type: 'provider_no_show', description: DESCRIPTION, ...extra });
    expect(res.status).toBe(201);
    return res.body.data;
  }

  // ── open ────────────────────────────────────────────────────

  describe('POST /admin/disputes', () => {
    it('opens on behalf of the client: reference, frozen booking, dispute chat, snapshot, events, audit, email, notifications', async () => {
      const ctx = await disputable({ reference: `EVT-${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` });
      const evidenceFile = await makeFile(db(), { purpose: FilePurpose.Evidence, originalName: 'no-show.png', mimeType: 'image/png' });
      const opened = recordEvents('dispute.opened');
      const res = await open({ bookingId: ctx.booking.reference, openedByRole: 'client', type: 'provider_no_show', description: DESCRIPTION, evidenceFileIds: [evidenceFile.id] }).expect(201);
      opened.stop();
      const d = res.body.data;

      expect(d).toMatchObject({
        reference: expect.stringMatching(/^DSP-\d{6}$/),
        type: 'provider_no_show',
        status: 'open',
        description: DESCRIPTION,
        openedBy: { id: ctx.client.id, role: 'client' },
        against: { id: ctx.provider.id, role: 'provider' },
        assignedAdmin: null,
        conversationStatus: 'open',
        bookingOutcome: null,
        decisionNote: null,
        booking: { id: ctx.booking.id, status: 'accepted', disputeStatus: 'open', kind: 'service', invoiceNumber: null },
        allowedActions: ['assign', 'message', 'request_evidence', 'add_evidence', 'resolve', 'close'],
      });
      expect(d.sides.client).toMatchObject({ id: ctx.client.id, isOpener: true, description: DESCRIPTION, evidenceCount: 2, history: { disputesCount: 1, cancellationsCount: 0, ratingAvg: null } });
      expect(d.sides.provider).toMatchObject({ id: ctx.provider.id, isOpener: false, description: null, businessName: expect.any(String), history: { disputesCount: 1 } });
      expect(d.evidence).toEqual([
        expect.objectContaining({ kind: 'chat_snapshot', conversationId: ctx.chat!.id, file: null, uploadedBy: expect.objectContaining({ id: ctx.client.id }) }),
        expect.objectContaining({ kind: 'file', file: expect.objectContaining({ id: evidenceFile.id, name: 'no-show.png', url: expect.stringContaining('sig=') }) }),
      ]);
      expect(d.timeline).toEqual([expect.objectContaining({ type: 'opened', actor: { id: admin.user.id, fullName: 'Omar Belaid' }, data: expect.objectContaining({ onBehalfOf: 'client', ignoreWindow: false }) })]);

      expect((await reloadBooking(ctx.booking.id)).disputeStatus).toBe(BookingDisputeStatus.Open);
      const conversation = await db().getRepository(Conversation).findOneByOrFail({ id: d.conversationId });
      expect(conversation).toMatchObject({ kind: ConversationKind.Dispute, bookingId: ctx.booking.id, disputeId: d.id, status: ConversationStatus.Open });
      const participants = await db().getRepository(ConversationParticipant).findBy({ conversationId: d.conversationId });
      expect(participants.map((p) => [p.userId, p.role]).sort()).toEqual(
        [
          [ctx.client.id, ParticipantRole.Client],
          [ctx.provider.id, ParticipantRole.Provider],
          [admin.user.id, ParticipantRole.Support],
        ].sort(),
      );
      const [system] = await db().query("SELECT body FROM messages WHERE conversation_id = ? AND kind = 'system'", [d.conversationId]);
      expect(system.body).toContain(d.reference);
      expect(await audited('dispute.opened', d.id)).toMatchObject({ objectLabel: d.reference });
      expect(opened.seen).toEqual([expect.objectContaining({ disputeId: d.id, againstUserId: ctx.provider.id, type: 'provider_no_show' })]);
      expect(lastMailTo(ctx.provider.email)?.subject).toContain(d.reference);
      expect(lastMailTo(ctx.client.email)?.subject ?? '').not.toContain(d.reference);
      const notified = await db().query("SELECT user_id FROM notifications WHERE type = 'dispute.opened' AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.disputeId')) = ?", [d.id]);
      expect(notified.map((n: any) => n.user_id)).toEqual(expect.arrayContaining([ctx.provider.id, admin.user.id]));
      expect(notified.map((n: any) => n.user_id)).not.toContain(ctx.client.id);
    });

    it('opens for the provider against the client', async () => {
      const ctx = await disputable({}, { chat: false });
      const d = await openFor(ctx, { openedByRole: 'provider', type: 'client_no_show' });
      expect(d).toMatchObject({ openedBy: { id: ctx.provider.id, role: 'provider' }, against: { id: ctx.client.id, role: 'client' }, evidence: [] });
    });

    it('validates the body', async () => {
      const ctx = await disputable();
      const valid = { bookingId: ctx.booking.id, openedByRole: 'client', type: 'provider_no_show', description: DESCRIPTION };
      for (const field of Object.keys(valid)) {
        const { [field]: _removed, ...body } = valid as Record<string, unknown>;
        const res = await open(body);
        expectError(res, 400, 'VALIDATION_FAILED');
        expect(res.body.details.map((e: any) => e.field)).toContain(field);
      }
      expectError(await open({ ...valid, description: 'Too short to explain.' }), 400, 'VALIDATION_FAILED');
      expectError(await open({ ...valid, openedByRole: 'admin' }), 400, 'VALIDATION_FAILED');
      expectError(await open({ ...valid, type: 'refund' }), 400, 'VALIDATION_FAILED');
      expectError(await open({ ...valid, evidenceFileIds: ['nope'] }), 400, 'VALIDATION_FAILED');
      expectError(await open({ ...valid, refund: true }), 400, 'VALIDATION_FAILED');
      const noNote = await open({ ...valid, ignoreWindow: true });
      expectError(noNote, 400, 'VALIDATION_FAILED');
      expect(noNote.body.details.map((e: any) => e.field)).toContain('note');
    });

    it('requires an admin token', async () => {
      expectError(await request(t.http).post(BASE).send({}), 401, 'AUTH_TOKEN_MISSING');
      const client = await loginAs(t, UserRole.Client);
      expectError(await open({}, client.headers), 403, 'FORBIDDEN_ROLE');
    });

    it('404 for an unknown booking, in Arabic too', async () => {
      const body = { bookingId: MISSING, openedByRole: 'client', type: 'other', description: DESCRIPTION };
      expectError(await open(body), 404, 'BOOKING_NOT_FOUND');
      const ar = await open(body).set('Accept-Language', 'ar');
      expectError(ar, 404, 'BOOKING_NOT_FOUND');
      expect(ar.body.message).toMatch(/[؀-ۿ]/);
    });

    it('refuses pending / declined bookings and a second open dispute', async () => {
      for (const status of [BookingStatus.Pending, BookingStatus.Declined]) {
        const ctx = await disputable({ status });
        expectError(await open({ bookingId: ctx.booking.id, openedByRole: 'client', type: 'other', description: DESCRIPTION }), 422, 'BOOKING_NOT_DISPUTABLE');
      }
      const ctx = await disputable();
      const first = await openFor(ctx);
      const again = await open({ bookingId: ctx.booking.id, openedByRole: 'provider', type: 'other', description: DESCRIPTION });
      expectError(again, 409, 'DISPUTE_ALREADY_OPEN');
      expect(again.body.details).toEqual({ reference: first.reference });
    });

    it('applies the dispute window, with an admin override', async () => {
      const future = await disputable({ eventDate: addDays(algiersToday(), 5) });
      const tooEarly = await open({ bookingId: future.booking.id, openedByRole: 'client', type: 'other', description: DESCRIPTION });
      expectError(tooEarly, 422, 'DISPUTE_WINDOW_CLOSED');
      expect(tooEarly.body.details).toEqual({ opensAt: expect.any(String), closesAt: expect.any(String) });

      const old = await disputable({ eventDate: addDays(algiersToday(), -10), status: BookingStatus.Completed, completedAt: new Date(Date.now() - 6 * DAY) });
      expectError(await open({ bookingId: old.booking.id, openedByRole: 'client', type: 'other', description: DESCRIPTION }), 422, 'DISPUTE_WINDOW_CLOSED');
      const overridden = await openFor(old, { ignoreWindow: true, note: 'Client called support 10 days after the event.' });
      expect(overridden.timeline[0].data).toMatchObject({ ignoreWindow: true, note: 'Client called support 10 days after the event.' });
      expect((await audited('dispute.opened', overridden.id))?.changes).toMatchObject({ windowOverridden: true });

      // Cancelled: within 7 days of the cancellation only.
      const recent = await disputable({ eventDate: addDays(algiersToday(), 20), status: BookingStatus.Cancelled, cancelledBy: PartyRole.Provider });
      await db().query("INSERT INTO booking_status_changes (id, created_at, booking_id, from_status, to_status, notified) VALUES (UUID(), ?, ?, 'accepted', 'cancelled', 1)", [new Date(Date.now() - 2 * DAY), recent.booking.id]);
      await openFor(recent, { type: 'cancellation_disagreement' });
      const stale = await disputable({ eventDate: addDays(algiersToday(), 20), status: BookingStatus.Cancelled });
      await db().query("INSERT INTO booking_status_changes (id, created_at, booking_id, from_status, to_status, notified) VALUES (UUID(), ?, ?, 'accepted', 'cancelled', 1)", [new Date(Date.now() - 8 * DAY), stale.booking.id]);
      expectError(await open({ bookingId: stale.booking.id, openedByRole: 'client', type: 'other', description: DESCRIPTION }), 422, 'DISPUTE_WINDOW_CLOSED');
    });

    it('checks evidence files', async () => {
      const ctx = await disputable();
      const publicPhoto = await makeFile(db(), { purpose: FilePurpose.ServicePhoto, isPrivate: false });
      const res = await open({ bookingId: ctx.booking.id, openedByRole: 'client', type: 'other', description: DESCRIPTION, evidenceFileIds: [MISSING, publicPhoto.id] });
      expectError(res, 422, 'EVIDENCE_FILE_INVALID');
      expect(res.body.details.fileIds.sort()).toEqual([MISSING, publicPhoto.id].sort());
      const many = await Promise.all(Array.from({ length: 11 }, () => makeFile(db(), { purpose: FilePurpose.Evidence })));
      expectError(await open({ bookingId: ctx.booking.id, openedByRole: 'client', type: 'other', description: DESCRIPTION, evidenceFileIds: many.map((f) => f.id) }), 422, 'DISPUTE_EVIDENCE_LIMIT');
      expect((await reloadBooking(ctx.booking.id)).disputeStatus).toBe(BookingDisputeStatus.None);
    });
  });

  // ── list ────────────────────────────────────────────────────

  describe('GET /admin/disputes', () => {
    it('lists with tab counts, filters, search, sort and pagination', async () => {
      const { user: provider } = await makeProvider(db(), { user: { fullName: `Studio Lumière ${uid()}` } });
      const otherAdmin = await makeUser(db(), { role: UserRole.Admin });
      const hakim = await makeUser(db(), { fullName: `Hakim Mansouri ${uid()}` });
      const make = async (status: DisputeStatus, extra: Partial<Dispute>, daysAgo: number, clientId?: string) => {
        const booking = await makeBooking(db(), { providerId: provider.id, serviceId: (await makeService(db(), { providerId: provider.id })).id, status: BookingStatus.Accepted, ...(clientId ? { clientId } : {}) } as never);
        return makeDispute(db(), { bookingId: booking.id, againstUserId: provider.id, openedById: booking.clientId, status, createdAt: new Date(Date.now() - daysAgo * DAY), ...extra } as never);
      };
      const a = await make(DisputeStatus.Open, { type: DisputeType.ProviderNoShow }, 5, hakim.id);
      const b = await make(DisputeStatus.Open, { type: DisputeType.PriceDisagreement }, 9);
      const c = await make(DisputeStatus.InReview, { assignedAdminId: admin.user.id }, 3);
      const e = await make(DisputeStatus.InReview, { assignedAdminId: otherAdmin.id }, 2);
      const f = await make(DisputeStatus.Resolved, { type: DisputeType.Other }, 20);
      const g = await make(DisputeStatus.Closed, { openedByRole: PartyRole.Provider, openedById: provider.id, againstUserId: hakim.id } as never, 30, hakim.id);
      await db().getRepository(DisputeEvidence).save({ disputeId: a.id, uploadedById: hakim.id, kind: DisputeEvidenceKind.Note, note: 'n', createdAt: new Date() });

      const list = (query: Record<string, unknown>) => request(t.http).get(BASE).set(admin.headers).query({ userId: provider.id, ...query }).expect(200);
      const ids = (res: request.Response) => res.body.data.map((r: any) => r.id);

      const all = await list({});
      expect(all.body.meta).toMatchObject({ page: 1, limit: 20, total: 6, totalPages: 1, counts: { open: 2, inReview: 2, resolved: 1, closed: 1, all: 6 } });
      expect(ids(all)).toEqual([e.id, c.id, a.id, b.id, f.id, g.id]);
      const row = all.body.data.find((r: any) => r.id === a.id);
      expect(Object.keys(row).sort()).toEqual(['against', 'assignedAdmin', 'booking', 'createdAt', 'evidenceCount', 'id', 'lastActivityAt', 'openedBy', 'reference', 'status', 'type'].sort());
      expect(row).toMatchObject({ openedBy: { id: hakim.id, role: 'client', fullName: hakim.fullName }, against: { id: provider.id, role: 'provider' }, evidenceCount: 1, assignedAdmin: null, booking: { id: a.bookingId, titleEn: expect.any(String) } });

      const open = await list({ tab: 'open' });
      expect(ids(open)).toEqual([b.id, a.id]); // oldest first
      expect(open.body.meta.counts).toEqual(all.body.meta.counts);
      expect(ids(await list({ tab: 'open', sort: 'createdAt:desc' }))).toEqual([a.id, b.id]);
      expect(ids(await list({ tab: 'in_review' })).sort()).toEqual([c.id, e.id].sort());
      expect(ids(await list({ tab: 'resolved' }))).toEqual([f.id]);
      expect(ids(await list({ tab: 'closed' }))).toEqual([g.id]);
      expect(ids(await list({ type: 'price_disagreement' }))).toEqual([b.id]);
      expect(ids(await list({ type: ['price_disagreement', 'other'] })).sort()).toEqual([b.id, f.id].sort());
      expect(ids(await list({ openedByRole: 'provider' }))).toEqual([g.id]);
      expect(ids(await list({ assignedAdminId: 'me' }))).toEqual([c.id]);
      expect(ids(await list({ assignedAdminId: otherAdmin.id }))).toEqual([e.id]);
      expect(ids(await list({ assignedAdminId: 'unassigned' })).length).toBe(4);
      expect(ids(await list({ bookingId: b.bookingId }))).toEqual([b.id]);
      await db().getRepository(Booking).update(f.bookingId, { status: BookingStatus.Completed });
      expect(ids(await list({ bookingStatus: 'completed' }))).toEqual([f.id]);
      expect(ids(await list({ bookingStatus: ['completed', 'accepted'] })).length).toBe(6);
      expectError(await request(t.http).get(BASE).set(admin.headers).query({ bookingStatus: 'done' }), 400, 'VALIDATION_FAILED');
      expect(all.body.meta.counts).toMatchObject({ resolved30d: 1, closed30d: 1 });
      await db().getRepository(Dispute).update(f.id, { resolvedAt: new Date(Date.now() - 40 * DAY) });
      await db().getRepository(Dispute).update(g.id, { resolvedAt: new Date(Date.now() - 2 * DAY) });
      expect((await list({})).body.meta.counts).toMatchObject({ resolved: 1, closed: 1, resolved30d: 0, closed30d: 1 });
      expect(ids(await request(t.http).get(BASE).set(admin.headers).query({ userId: hakim.id }).expect(200)).sort()).toEqual([a.id, g.id].sort());
      expect(ids(await list({ q: a.reference }))).toEqual([a.id]);
      expect(ids(await list({ q: 'Hakim Mansouri' })).sort()).toEqual([a.id, g.id].sort());
      const booking = await reloadBooking(c.bookingId);
      expect(ids(await list({ q: booking.reference }))).toEqual([c.id]);
      expect(ids(await list({ createdFrom: new Date(Date.now() - 4 * DAY).toISOString().slice(0, 10) })).sort()).toEqual([c.id, e.id].sort());
      expect(ids(await list({ createdTo: new Date(Date.now() - 25 * DAY).toISOString().slice(0, 10) }))).toEqual([g.id]);
      expect((await list({ sort: 'lastActivityAt:desc' })).body.data).toHaveLength(6);
      const page = await list({ limit: 2, page: 2 });
      expect(page.body.meta).toMatchObject({ page: 2, limit: 2, total: 6, totalPages: 3 });
      expect(ids(page)).toEqual([a.id, b.id]);

      expectError(await request(t.http).get(BASE).set(admin.headers).query({ sort: 'type:asc' }), 400, 'SORT_FIELD_NOT_ALLOWED');
      expectError(await request(t.http).get(BASE).set(admin.headers).query({ tab: 'pending' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).get(BASE).set(admin.headers).query({ assignedAdminId: 'someone' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).get(BASE), 401, 'AUTH_TOKEN_MISSING');
      expectError(await request(t.http).get(BASE).set((await loginAs(t, UserRole.Provider)).headers), 403, 'FORBIDDEN_ROLE');
    });

    it('registers the disputes export', () => {
      const definition = t.get(ExportRegistry).get('disputes');
      expect(definition?.columns.map((c) => c.key)).toEqual(expect.arrayContaining(['reference', 'status', 'booking', 'openedBy', 'against']));
    });
  });

  // ── detail ──────────────────────────────────────────────────

  describe('GET /admin/disputes/:id', () => {
    it('returns both sides with their chat responses, evidence, booking card, history and timeline', async () => {
      const ctx = await disputable();
      await makeInvoice(db(), { bookingId: ctx.booking.id, number: `INV-2026-${uid(2)}` });
      const d = await openFor(ctx);
      await makeMessage(db(), { conversationId: d.conversationId, senderId: ctx.provider.id, body: 'I had a car accident on the way, here is the report.' });
      await makeMessage(db(), { conversationId: d.conversationId, senderId: ctx.client.id, body: 'Nobody told us anything.' });
      await db().query("UPDATE bookings SET cancelled_by = 'client', status = 'cancelled' WHERE id = ?", [(await makeBooking(db(), { clientId: ctx.client.id, providerId: ctx.provider.id, serviceId: ctx.service.id } as never)).id]);
      await db().query('UPDATE provider_profiles SET avg_rating = 3.9 WHERE user_id = ?', [ctx.provider.id]);

      const res = await request(t.http).get(`${BASE}/${d.reference}`).set(admin.headers).expect(200);
      const body = res.body.data;
      expect(Object.keys(body).sort()).toEqual(
        ['against', 'allowedActions', 'assignedAdmin', 'booking', 'bookingOutcome', 'conversationId', 'conversationStatus', 'createdAt', 'decisionNote', 'description', 'evidence', 'id', 'lastActivityAt', 'openedBy', 'reference', 'resolvedAt', 'resolvedBy', 'sides', 'status', 'timeline', 'type', 'updatedAt'].sort(),
      );
      expect(body.sides.provider.responses.map((r: any) => r.body)).toEqual(['I had a car accident on the way, here is the report.']);
      expect(body.sides.client.responses.map((r: any) => r.body)).toEqual(['Nobody told us anything.']);
      expect(body.sides.client.history).toEqual({ disputesCount: 1, cancellationsCount: 1, ratingAvg: null });
      expect(body.sides.provider.history).toEqual({ disputesCount: 1, cancellationsCount: 0, ratingAvg: 3.9 });
      expect(body.booking).toMatchObject({ reference: ctx.booking.reference, invoiceNumber: expect.stringMatching(/^INV-2026-/), total: '45000.00', startTime: '18:00', endTime: '23:00' });
      expect((await request(t.http).get(`${BASE}/${d.id}`).set(admin.headers).expect(200)).body.data.id).toBe(d.id);
    });

    it('404 for unknown ids and references', async () => {
      expectError(await request(t.http).get(`${BASE}/${MISSING}`).set(admin.headers), 404, 'DISPUTE_NOT_FOUND');
      expectError(await request(t.http).get(`${BASE}/DSP-99999999`).set(admin.headers), 404, 'DISPUTE_NOT_FOUND');
      expectError(await request(t.http).get(`${BASE}/not-an-id`).set(admin.headers), 404, 'DISPUTE_NOT_FOUND');
      expectError(await request(t.http).get(`${BASE}/${MISSING}`), 401, 'AUTH_TOKEN_MISSING');
    });
  });

  // ── assign ──────────────────────────────────────────────────

  describe('POST /admin/disputes/:id/assign', () => {
    it('assigns to me by default (open → in_review), then to another admin', async () => {
      const d = await openFor(await disputable());
      const res = await request(t.http).post(`${BASE}/${d.id}/assign`).set(admin.headers).send({}).expect(200);
      expect(res.body.data).toMatchObject({ status: 'in_review', assignedAdmin: { id: admin.user.id } });
      expect(res.body.data.timeline.at(-1)).toMatchObject({ type: 'assigned', data: expect.objectContaining({ adminId: admin.user.id }) });
      expect((await audited('dispute.assigned', d.id))?.changes).toMatchObject({ status: { from: 'open', to: 'in_review' } });

      const other = await makeUser(db(), { role: UserRole.Admin });
      const again = await request(t.http).post(`${BASE}/${d.id}/assign`).set(admin.headers).send({ adminId: other.id }).expect(200);
      expect(again.body.data).toMatchObject({ status: 'in_review', assignedAdmin: { id: other.id } });
      expect(await db().getRepository(ConversationParticipant).findOneBy({ conversationId: d.conversationId, userId: other.id })).toMatchObject({ role: ParticipantRole.Support });
    });

    it('refuses unknown admins, bad bodies and finished disputes', async () => {
      const d = await openFor(await disputable());
      const client = await makeUser(db());
      expectError(await request(t.http).post(`${BASE}/${d.id}/assign`).set(admin.headers).send({ adminId: client.id }), 404, 'ADMIN_NOT_FOUND');
      expectError(await request(t.http).post(`${BASE}/${d.id}/assign`).set(admin.headers).send({ adminId: 'x' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${BASE}/${MISSING}/assign`).set(admin.headers).send({}), 404, 'DISPUTE_NOT_FOUND');
      await request(t.http).post(`${BASE}/${d.id}/close`).set(admin.headers).send({ note: 'Settled by phone.' }).expect(200);
      const res = await request(t.http).post(`${BASE}/${d.id}/assign`).set(admin.headers).send({});
      expectError(res, 409, 'DISPUTE_INVALID_TRANSITION');
      expect(res.body.details).toEqual({ status: 'closed' });
    });
  });

  // ── evidence ────────────────────────────────────────────────

  describe('POST /admin/disputes/:id/evidence', () => {
    it('stores a private file for a party', async () => {
      const ctx = await disputable();
      const d = await openFor(ctx);
      const res = await request(t.http).post(`${BASE}/${d.id}/evidence`).set(admin.headers).field('partyUserId', ctx.provider.id).field('note', 'Accident report').attach('file', await png(), 'report.png').expect(201);
      const item = res.body.data.evidence.find((e: any) => e.kind === 'file');
      expect(item).toMatchObject({ uploadedBy: { id: ctx.provider.id, role: 'provider' }, note: 'Accident report', file: { name: 'report.png', mimeType: 'image/png', url: expect.stringContaining('sig=') } });
      const [file] = await db().query('SELECT purpose, is_private, owner_id FROM files WHERE id = ?', [item.file.id]);
      expect(file).toMatchObject({ purpose: 'evidence', is_private: 1, owner_id: ctx.provider.id });
      expect(res.body.data.sides.provider.evidenceCount).toBe(1);
      expect(res.body.data.timeline.at(-1)).toMatchObject({ type: 'evidence_added' });
      expect(await audited('dispute.evidence_added', d.id)).toBeTruthy();
      // The signed URL serves the file.
      const url = new URL(item.file.url);
      await request(t.http).get(`${url.pathname}${url.search}`).expect(200);
    });

    it('checks the party, size, type, per-party limit and status', async () => {
      const ctx = await disputable();
      const d = await openFor(ctx);
      const stranger = await makeUser(db());
      const upload = (party: string, buffer: Buffer, name = 'a.png') => request(t.http).post(`${BASE}/${d.id}/evidence`).set(admin.headers).field('partyUserId', party).attach('file', buffer, name);
      expectError(await upload(stranger.id, await png()), 422, 'DISPUTE_PARTY_INVALID');
      expectError(await upload(ctx.client.id, Buffer.alloc(5 * 1024 * 1024 + 10, 1)), 413, 'FILE_TOO_LARGE');
      expectError(await upload(ctx.client.id, Buffer.from('plain text, not a document'), 'a.txt'), 415, 'FILE_TYPE_NOT_ALLOWED');
      expectError(await request(t.http).post(`${BASE}/${d.id}/evidence`).set(admin.headers).field('partyUserId', ctx.client.id), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${BASE}/${d.id}/evidence`).set(admin.headers).attach('file', await png(), 'a.png'), 400, 'VALIDATION_FAILED');

      const file = await makeFile(db(), { purpose: FilePurpose.Evidence });
      // Client already has 1 file (none at opening here): fill up to the limit of 10.
      await db().getRepository(DisputeEvidence).save(Array.from({ length: 10 }, () => ({ disputeId: d.id, uploadedById: ctx.client.id, fileId: file.id, kind: DisputeEvidenceKind.File, createdAt: new Date() })));
      const limited = await upload(ctx.client.id, await png());
      expectError(limited, 422, 'DISPUTE_EVIDENCE_LIMIT');
      expect(limited.body.details).toEqual({ max: 10 });
      await upload(ctx.provider.id, await png()).expect(201);

      await request(t.http).post(`${BASE}/${d.id}/resolve`).set(admin.headers).send({ bookingOutcome: 'unchanged', decisionNote: 'No fault found.' }).expect(200);
      expectError(await upload(ctx.provider.id, await png()), 409, 'DISPUTE_INVALID_TRANSITION');
    });
  });

  // ── chat ────────────────────────────────────────────────────

  describe('POST /admin/disputes/:id/messages and /request-evidence', () => {
    it('posts a support message and notifies both parties', async () => {
      const ctx = await disputable();
      const d = await openFor(ctx);
      const res = await request(t.http).post(`${BASE}/${d.id}/messages`).set(admin.headers).send({ body: 'Hello both, please share any proof you have.' }).expect(201);
      expect(res.body.data).toMatchObject({ conversationId: d.conversationId, kind: 'text', body: 'Hello both, please share any proof you have.', senderLabel: 'Eventor support', sender: { id: admin.user.id } });
      const notified = await db().query("SELECT user_id FROM notifications WHERE type = 'dispute.message' AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.messageId')) = ?", [res.body.data.id]);
      expect(notified.map((n: any) => n.user_id).sort()).toEqual([ctx.client.id, ctx.provider.id].sort());
      expect(await audited('dispute.message_sent', d.id)).toBeTruthy();
      expectError(await request(t.http).post(`${BASE}/${d.id}/messages`).set(admin.headers).send({ body: '' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${BASE}/${d.id}/messages`).set(admin.headers).send({ body: 'x', extra: 1 }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${BASE}/${MISSING}/messages`).set(admin.headers).send({ body: 'x' }), 404, 'DISPUTE_NOT_FOUND');

      await db().query("UPDATE conversations SET status = 'closed' WHERE id = ?", [d.conversationId]);
      expectError(await request(t.http).post(`${BASE}/${d.id}/messages`).set(admin.headers).send({ body: 'Still there?' }), 409, 'CONVERSATION_CLOSED');
    });

    it('asks one party for evidence', async () => {
      const ctx = await disputable();
      const d = await openFor(ctx);
      const res = await request(t.http).post(`${BASE}/${d.id}/request-evidence`).set(admin.headers).send({ fromUserId: ctx.provider.id, message: 'Could you send the accident report?' }).expect(200);
      expect(res.body.data.timeline.at(-1)).toMatchObject({ type: 'evidence_requested', data: expect.objectContaining({ fromUserId: ctx.provider.id }) });
      const [message] = await db().query('SELECT body, sender_id FROM messages WHERE conversation_id = ? AND sender_id = ?', [d.conversationId, admin.user.id]);
      expect(message.body).toBe('Could you send the accident report?');
      const notified = await db().query("SELECT user_id FROM notifications WHERE type = 'dispute.evidence_requested' AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.disputeId')) = ?", [d.id]);
      expect(notified.map((n: any) => n.user_id)).toEqual([ctx.provider.id]);

      expectError(await request(t.http).post(`${BASE}/${d.id}/request-evidence`).set(admin.headers).send({ fromUserId: (await makeUser(db())).id, message: 'x' }), 422, 'DISPUTE_PARTY_INVALID');
      expectError(await request(t.http).post(`${BASE}/${d.id}/request-evidence`).set(admin.headers).send({ message: 'x' }), 400, 'VALIDATION_FAILED');
    });
  });

  // ── resolve / close ─────────────────────────────────────────

  describe('POST /admin/disputes/:id/resolve', () => {
    const resolve = (id: string, body: Record<string, unknown>) => request(t.http).post(`${BASE}/${id}/resolve`).set(admin.headers).send(body);

    it('completed: accepted booking completed before the window end, reviews unblocked, both parties emailed', async () => {
      const ctx = await disputable();
      const d = await openFor(ctx);
      const res = await resolve(d.id, { bookingOutcome: 'completed', decisionNote: 'The provider came late but performed the full set.' }).expect(200);
      expect(res.body.data).toMatchObject({
        status: 'resolved',
        bookingOutcome: 'completed',
        decisionNote: 'The provider came late but performed the full set.',
        resolvedBy: { id: admin.user.id },
        assignedAdmin: { id: admin.user.id },
        booking: { status: 'completed', disputeStatus: 'resolved' },
        allowedActions: ['message'],
      });
      const booking = await reloadBooking(ctx.booking.id);
      expect(booking).toMatchObject({ status: BookingStatus.Completed, disputeStatus: BookingDisputeStatus.Resolved });
      const [change] = await db().query("SELECT reason, actor_id FROM booking_status_changes WHERE booking_id = ? AND to_status = 'completed'", [ctx.booking.id]);
      expect(change).toEqual({ reason: 'dispute_resolved', actor_id: admin.user.id });
      expect(await audited('dispute.resolved', d.id)).toMatchObject({ note: 'The provider came late but performed the full set.' });
      expect(lastMailTo(ctx.client.email)?.text).toContain('The provider came late but performed the full set.');
      expect(lastMailTo(ctx.provider.email)?.subject).toContain('resolved');
      expectError(await resolve(d.id, { bookingOutcome: 'unchanged', decisionNote: 'again' }), 409, 'DISPUTE_INVALID_TRANSITION');
    });

    it('cancelled: accepted → cancelled by admin (reason dispute); completed → reopened then cancelled', async () => {
      const accepted = await disputable();
      const d1 = await openFor(accepted);
      await resolve(d1.id, { bookingOutcome: 'cancelled', decisionNote: 'Provider no-show confirmed.' }).expect(200);
      expect(await reloadBooking(accepted.booking.id)).toMatchObject({ status: BookingStatus.Cancelled, cancelledBy: PartyRole.Admin, cancelReason: 'dispute', disputeStatus: BookingDisputeStatus.Resolved });

      const completed = await disputable({ status: BookingStatus.Completed, completedAt: new Date() });
      const d2 = await openFor(completed);
      await resolve(d2.id, { bookingOutcome: 'cancelled', decisionNote: 'Service was not delivered.' }).expect(200);
      expect(await reloadBooking(completed.booking.id)).toMatchObject({ status: BookingStatus.Cancelled, completedAt: null, cancelReason: 'dispute' });
      const moves = await db().query('SELECT from_status, to_status FROM booking_status_changes WHERE booking_id = ? ORDER BY created_at', [completed.booking.id]);
      expect(moves).toEqual([
        { from_status: 'completed', to_status: 'accepted' },
        { from_status: 'accepted', to_status: 'cancelled' },
      ]);
    });

    it('unchanged keeps the booking status; completing a cancelled booking is refused', async () => {
      const ctx = await disputable();
      const d = await openFor(ctx);
      await resolve(d.id, { bookingOutcome: 'unchanged', decisionNote: 'Both sides agreed.' }).expect(200);
      expect(await reloadBooking(ctx.booking.id)).toMatchObject({ status: BookingStatus.Accepted, disputeStatus: BookingDisputeStatus.Resolved });

      const cancelled = await disputable({ status: BookingStatus.Cancelled });
      await db().query("INSERT INTO booking_status_changes (id, created_at, booking_id, from_status, to_status, notified) VALUES (UUID(), ?, ?, 'accepted', 'cancelled', 1)", [new Date(), cancelled.booking.id]);
      const d2 = await openFor(cancelled);
      const res = await resolve(d2.id, { bookingOutcome: 'completed', decisionNote: 'x' });
      expectError(res, 409, 'BOOKING_INVALID_TRANSITION');
      expect((await reloadDispute(d2.id)).status).toBe(DisputeStatus.Open);
      expect((await reloadBooking(cancelled.booking.id)).disputeStatus).toBe(BookingDisputeStatus.Open);
    });

    it('validates', async () => {
      const d = await openFor(await disputable());
      expectError(await resolve(d.id, { bookingOutcome: 'refunded', decisionNote: 'x' }), 400, 'VALIDATION_FAILED');
      expectError(await resolve(d.id, { bookingOutcome: 'completed' }), 400, 'VALIDATION_FAILED');
      expectError(await resolve(MISSING, { bookingOutcome: 'completed', decisionNote: 'x' }), 404, 'DISPUTE_NOT_FOUND');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).post(`${BASE}/${d.id}/resolve`).set(client.headers).send({}), 403, 'FORBIDDEN_ROLE');
    });
  });

  describe('booking freeze, close and jobs', () => {
    it('auto-complete skips a booking with an open dispute; closing resumes it', async () => {
      const ctx = await disputable({ eventDate: addDays(algiersToday(), -10) });
      const d = await openFor(ctx, { ignoreWindow: true, note: 'Reported late by phone.' });
      const jobs = t.get(BookingJobsService);
      await jobs.autoComplete();
      expect((await reloadBooking(ctx.booking.id)).status).toBe(BookingStatus.Accepted);

      const res = await request(t.http).post(`${BASE}/${d.id}/close`).set(admin.headers).send({ note: 'Both parties agreed after a call.' }).expect(200);
      expect(res.body.data).toMatchObject({ status: 'closed', decisionNote: 'Both parties agreed after a call.', booking: { disputeStatus: 'none' }, resolvedBy: { id: admin.user.id }, resolvedAt: expect.any(String) });
      expect(await audited('dispute.closed', d.id)).toBeTruthy();
      const notified = await db().query("SELECT user_id FROM notifications WHERE type = 'dispute.closed' AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.disputeId')) = ?", [d.id]);
      expect(notified).toHaveLength(2);

      await jobs.autoComplete();
      expect((await reloadBooking(ctx.booking.id)).status).toBe(BookingStatus.Completed);
      expectError(await request(t.http).post(`${BASE}/${d.id}/close`).set(admin.headers).send({ note: 'again' }), 409, 'DISPUTE_INVALID_TRANSITION');
      expectError(await request(t.http).post(`${BASE}/${d.id}/close`).set(admin.headers).send({}), 400, 'VALIDATION_FAILED');
    });

    it('closing keeps `resolved` when an earlier dispute on the booking was resolved', async () => {
      const ctx = await disputable();
      const first = await openFor(ctx);
      await request(t.http).post(`${BASE}/${first.id}/resolve`).set(admin.headers).send({ bookingOutcome: 'unchanged', decisionNote: 'Fine.' }).expect(200);
      const second = await openFor(ctx, { openedByRole: 'provider', type: 'client_no_show' });
      await request(t.http).post(`${BASE}/${second.id}/close`).set(admin.headers).send({ note: 'Withdrawn.' }).expect(200);
      expect((await reloadBooking(ctx.booking.id)).disputeStatus).toBe(BookingDisputeStatus.Resolved);
    });

    it('closes the dispute chat 7 days after the decision', async () => {
      const ctx = await disputable();
      const d = await openFor(ctx);
      await request(t.http).post(`${BASE}/${d.id}/resolve`).set(admin.headers).send({ bookingOutcome: 'unchanged', decisionNote: 'Fine.' }).expect(200);
      const service = t.get(DisputesService);
      await service.closeStaleConversations(new Date(Date.now() + 6 * DAY));
      expect((await db().getRepository(Conversation).findOneByOrFail({ id: d.conversationId })).status).toBe(ConversationStatus.Open);
      expect(await service.closeStaleConversations(new Date(Date.now() + 8 * DAY))).toBeGreaterThanOrEqual(1);
      expect(await db().getRepository(Conversation).findOneByOrFail({ id: d.conversationId })).toMatchObject({ status: ConversationStatus.Closed, closedReason: 'dispute_resolved' });
      const detail = await request(t.http).get(`${BASE}/${d.id}`).set(admin.headers).expect(200);
      expect(detail.body.data).toMatchObject({ conversationStatus: 'closed', allowedActions: [] });
      expect(detail.body.data.timeline.at(-1)).toMatchObject({ type: 'conversation_closed', actor: null });
      await service.closeStaleConversations(new Date(Date.now() + 9 * DAY)); // idempotent
    });
  });
});
