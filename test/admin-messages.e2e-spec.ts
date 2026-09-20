import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { AuditLog } from '../src/admin/entities/audit-log.entity.js';
import { BookingStatus } from '../src/common/enums/booking.enums.js';
import { ConversationKind, MessageKind, MessageStatus, ParticipantRole } from '../src/common/enums/messaging.enums.js';
import { ReportStatus, ReportTargetType } from '../src/common/enums/moderation.enums.js';
import { UserRole } from '../src/common/enums/user.enums.js';
import { ExportRegistry } from '../src/exports/export-registry.js';
import { MailService } from '../src/mail/mail.service.js';
import { ConversationParticipant } from '../src/messaging/entities/conversation-participant.entity.js';
import { Conversation } from '../src/messaging/entities/conversation.entity.js';
import { Message } from '../src/messaging/entities/message.entity.js';
import { MessagingService } from '../src/messaging/messaging.service.js';
import { Report } from '../src/reviews/entities/report.entity.js';
import { runInTransaction } from '../src/database/transaction.js';
import {
  createApp,
  expectError,
  loginAs,
  makeBooking,
  makeConversation,
  makeProvider,
  makeReport,
  makeUser,
  uid,
  type LoggedIn,
  type TestApp,
} from './utils/index.js';

const API = '/api/v1/admin';
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('Admin messages (e2e)', () => {
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
  const lastMailTo = (email: string) => [...t.get(MailService).outbox].reverse().find((m) => m.to === email);

  /** A direct chat between a new client and provider, with messages inserted through the service (masking applied). */
  async function chat(bodies: [who: 'c' | 'p', body: string][], options: { bookingStatus?: BookingStatus; clientName?: string } = {}) {
    const client = await makeUser(db(), options.clientName ? { fullName: options.clientName } : {});
    const { user: provider } = await makeProvider(db());
    const booking = await makeBooking(db(), { clientId: client.id, providerId: provider.id, status: options.bookingStatus ?? BookingStatus.Pending } as never);
    const conversation = await makeConversation(db(), { kind: ConversationKind.Direct, bookingId: booking.id });
    await db().getRepository(ConversationParticipant).save([
      { conversationId: conversation.id, userId: client.id, role: ParticipantRole.Client, canWrite: true },
      { conversationId: conversation.id, userId: provider.id, role: ParticipantRole.Provider, canWrite: true },
    ]);
    const messageIds: string[] = [];
    let at = Date.now() - bodies.length * 60_000;
    for (const [who, body] of bodies) {
      at += 60_000;
      const id = await runInTransaction(db(), (em, afterCommit) =>
        t.get(MessagingService).insertMessage(em, afterCommit, { conversationId: conversation.id, senderId: who === 'c' ? client.id : provider.id, body, createdAt: new Date(at) }),
      );
      messageIds.push(id);
    }
    return { client, provider, booking, conversation, messageIds };
  }

  // ── list ────────────────────────────────────────────────────

  describe('GET /admin/conversations', () => {
    let tag: string;
    let direct: Awaited<ReturnType<typeof chat>>;
    let reported: Awaited<ReturnType<typeof chat>>;
    let support: string;
    let disputeConversation: Conversation;

    beforeAll(async () => {
      tag = uid();
      direct = await chat(
        [
          ['c', `Bonjour, disponible pour la cérémonie ${tag}zz ?`],
          ['p', 'Oui, appelez-moi au 0555 12 34 56'],
        ],
        { clientName: `Amina ${tag}` },
      );
      reported = await chat([['c', 'mon email est karima@gmail.com']], { clientName: `Karima ${tag}` });
      await makeReport(db(), { targetType: ReportTargetType.Message, targetId: reported.messageIds[0], reporterId: reported.provider.id });
      const created = await request(t.http).post(`${API}/conversations`).set(admin.headers).send({ userIds: [direct.client.id], body: `Support ${tag}` }).expect(201);
      support = created.body.data.id;
      disputeConversation = await makeConversation(db(), { kind: ConversationKind.Dispute });
      await db().getRepository(ConversationParticipant).save({ conversationId: disputeConversation.id, userId: direct.client.id, role: ParticipantRole.Client, canWrite: true });
    });

    const list = (query: Record<string, unknown>) => request(t.http).get(`${API}/conversations`).query(query).set(admin.headers);
    const ids = (res: request.Response) => res.body.data.map((r: any) => r.id);

    it('lists conversations of a user with counters and the masked last message', async () => {
      const res = await list({ userId: direct.client.id }).expect(200);
      expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1, counts: { all: 3, reported: 0, aboutBooking: 1, disputes: 1, unread: 0 } });
      const row = res.body.data.find((r: any) => r.id === direct.conversation.id);
      expect(Object.keys(row).sort()).toEqual(['booking', 'disputeId', 'id', 'kind', 'lastMessage', 'lastMessageAt', 'participants', 'reportsOpen', 'status', 'unreadCount'].sort());
      expect(row).toMatchObject({
        kind: 'direct',
        status: 'open',
        participants: [
          { id: direct.client.id, role: 'client', fullName: `Amina ${tag}`, avatarUrl: null },
          { id: direct.provider.id, role: 'provider' },
          { id: admin.user.id, role: 'support' },
        ].slice(0, 2),
        lastMessage: { bodyPreview: 'Oui, appelez-moi au [phone hidden]', senderName: direct.provider.fullName },
        booking: { id: direct.booking.id, reference: direct.booking.reference, status: 'pending' },
        reportsOpen: 0,
        unreadCount: 0,
      });
      const supportRow = res.body.data.find((r: any) => r.id === support);
      expect(supportRow).toMatchObject({ kind: 'support', lastMessage: { senderName: 'Eventor support', bodyPreview: `Support ${tag}` } });
    });

    it('filters by kind, reported, booking, status, unread and search (names and message text)', async () => {
      expect(ids(await list({ userId: direct.client.id, kind: 'support' }))).toEqual([support]);
      expect(ids(await list({ userId: direct.client.id, kind: 'dispute' }))).toEqual([disputeConversation.id]);
      expect(ids(await list({ userId: reported.client.id, reported: true }))).toEqual([reported.conversation.id]);
      expect((await list({ reported: true })).body.data.every((r: any) => r.reportsOpen > 0)).toBe(true);
      expect(ids(await list({ bookingId: direct.booking.id }))).toEqual([direct.conversation.id]);
      expect(ids(await list({ userId: direct.client.id, aboutBooking: true }))).toEqual([direct.conversation.id]);
      expect((await list({ userId: direct.client.id, status: 'closed' })).body.meta.total).toBe(0);
      expect(ids(await list({ q: `Karima ${tag}` }))).toEqual([reported.conversation.id]);
      expect(ids(await list({ q: `cérémonie ${tag}zz` }))).toEqual([direct.conversation.id]);

      // Unread for the current admin: a user writes in the support conversation.
      await runInTransaction(db(), (em, afterCommit) => t.get(MessagingService).insertMessage(em, afterCommit, { conversationId: support, senderId: direct.client.id, body: 'Merci !' }));
      const unread = await list({ userId: direct.client.id, unread: true }).expect(200);
      expect(ids(unread)).toEqual([support]);
      expect(unread.body.data[0].unreadCount).toBe(1);
      expect(unread.body.meta.counts.unread).toBe(1);
      const read = await request(t.http).post(`${API}/conversations/${support}/read`).set(admin.headers).expect(200);
      expect(read.body.data).toEqual({ conversationId: support, unreadCount: 0, lastReadAt: expect.any(String) });
      expect((await list({ userId: direct.client.id, unread: true })).body.meta.total).toBe(0);
      const notMine = await request(t.http).post(`${API}/conversations/${direct.conversation.id}/read`).set(admin.headers).expect(200);
      expect(notMine.body.data.lastReadAt).toBeNull();

      expectError(await list({ kind: 'group' }), 400, 'VALIDATION_FAILED');
      expectError(await list({ sort: 'kind:asc' }), 400, 'SORT_FIELD_NOT_ALLOWED');
      expect(ids(await list({ userId: direct.client.id, sort: 'createdAt:asc', limit: 1, page: 2 }))).toHaveLength(1);
    });

    it('401 without a token, 403 for a provider token; export is registered', async () => {
      expectError(await request(t.http).get(`${API}/conversations`), 401, 'AUTH_TOKEN_MISSING');
      const provider = await loginAs(t, UserRole.Provider);
      expectError(await request(t.http).get(`${API}/conversations`).set(provider.headers), 403, 'FORBIDDEN_ROLE');
      expect(t.get(ExportRegistry).get('conversations')).toBeDefined();
    });
  });

  // ── detail & messages ───────────────────────────────────────

  describe('GET /admin/conversations/:id and /messages', () => {
    it('returns participants, booking card, open reports and unmasking state', async () => {
      const c = await chat([['c', 'whatsapp 0770 11 22 33']]);
      const report = await makeReport(db(), { targetType: ReportTargetType.Message, targetId: c.messageIds[0], reporterId: c.provider.id, note: 'Phone number' });
      const res = await request(t.http).get(`${API}/conversations/${c.conversation.id}`).set(admin.headers).expect(200);
      expect(res.body.data).toMatchObject({
        id: c.conversation.id,
        kind: 'direct',
        status: 'open',
        booking: { id: c.booking.id, reference: c.booking.reference, status: 'pending', eventDate: expect.any(String), total: '45000.00' },
        dispute: null,
        closed: null,
        contactUnmasked: false,
        reports: [{ id: report.id, messageId: c.messageIds[0], reason: 'spam', note: 'Phone number', reporter: { id: c.provider.id } }],
      });
      expect(res.body.data.participants[0]).toMatchObject({ id: c.client.id, role: 'client', userRole: 'client', canWrite: true, blocked: false });

      await db().query("UPDATE bookings SET status = 'accepted' WHERE id = ?", [c.booking.id]);
      expect((await request(t.http).get(`${API}/conversations/${c.conversation.id}`).set(admin.headers)).body.data.contactUnmasked).toBe(true);
      expectError(await request(t.http).get(`${API}/conversations/${MISSING}`).set(admin.headers), 404, 'CONVERSATION_NOT_FOUND');
      expectError(await request(t.http).get(`${API}/conversations/nope`).set(admin.headers), 404, 'CONVERSATION_NOT_FOUND');
    });

    it('pages messages with original and masked text, detected contacts and a cursor', async () => {
      const c = await chat([
        ['c', 'Bonjour'],
        ['p', 'Salam, mon numéro +213 555 12 34 56'],
        ['c', 'écris-moi à amina.b@gmail.com ou insta: @amina_b'],
        ['p', 'OK'],
      ]);
      const first = await request(t.http).get(`${API}/conversations/${c.conversation.id}/messages`).query({ limit: 3 }).set(admin.headers).expect(200);
      expect(first.body.meta).toEqual({ limit: 3, hasMore: true, nextBefore: c.messageIds[1] });
      expect(first.body.data.map((m: any) => m.id)).toEqual(c.messageIds.slice(1));
      expect(first.body.data[0]).toMatchObject({
        body: 'Salam, mon numéro +213 555 12 34 56',
        bodyMasked: 'Salam, mon numéro [phone hidden]',
        masked: true,
        detectedContacts: ['phone'],
        status: 'visible',
        moderation: null,
        senderLabel: c.provider.fullName,
        sender: { id: c.provider.id, role: 'provider' },
      });
      expect(first.body.data[1]).toMatchObject({ bodyMasked: 'écris-moi à [email hidden] ou [handle hidden]', detectedContacts: ['email', 'handle'] });
      expect(first.body.data[2]).toMatchObject({ bodyMasked: null, masked: false, detectedContacts: [] });
      const older = await request(t.http).get(`${API}/conversations/${c.conversation.id}/messages`).query({ limit: 3, before: first.body.meta.nextBefore }).set(admin.headers).expect(200);
      expect(older.body).toEqual({ data: [expect.objectContaining({ id: c.messageIds[0], body: 'Bonjour' })], meta: { limit: 3, hasMore: false, nextBefore: null } });
      expectError(await request(t.http).get(`${API}/conversations/${c.conversation.id}/messages`).query({ before: MISSING }).set(admin.headers), 404, 'MESSAGE_NOT_FOUND');
      expectError(await request(t.http).get(`${API}/conversations/${c.conversation.id}/messages`).query({ limit: 500 }).set(admin.headers), 400, 'VALIDATION_FAILED');
    });
  });

  // ── support messages ────────────────────────────────────────

  describe('POST /admin/conversations and /messages', () => {
    it('creates a support conversation, reuses the open one of a single user, emails a copy', async () => {
      const user = await makeUser(db());
      const res = await request(t.http).post(`${API}/conversations`).set(admin.headers).send({ userIds: [user.id], body: 'Bonjour, appelez le 0555 00 11 22', email: true }).expect(201);
      expect(res.body.data).toMatchObject({ kind: 'support', status: 'open' });
      expect(res.body.data.participants.map((p: any) => [p.id, p.role])).toEqual([
        [user.id, 'client'],
        [admin.user.id, 'support'],
      ]);
      const messages = await request(t.http).get(`${API}/conversations/${res.body.data.id}/messages`).set(admin.headers).expect(200);
      expect(messages.body.data).toEqual([expect.objectContaining({ senderLabel: 'Eventor support', sender: expect.objectContaining({ id: admin.user.id, role: 'admin' }), bodyMasked: 'Bonjour, appelez le [phone hidden]' })]);
      expect(lastMailTo(user.email)).toMatchObject({ subject: 'A message from Eventor support' });
      expect(await audited('conversation.support_message_sent', res.body.data.id)).not.toBeNull();

      const again = await request(t.http).post(`${API}/conversations`).set(admin.headers).send({ userIds: [user.id], body: 'Second message' }).expect(201);
      expect(again.body.data.id).toBe(res.body.data.id);

      // Another admin writing to the same user joins the conversation first.
      const colleague = await loginAs(t, UserRole.Admin);
      const third = await request(t.http).post(`${API}/conversations`).set(colleague.headers).send({ userIds: [user.id], body: 'Third' }).expect(201);
      expect(third.body.data.id).toBe(res.body.data.id);
      const all = await request(t.http).get(`${API}/conversations/${res.body.data.id}/messages`).set(admin.headers);
      expect(all.body.data.map((m: any) => [m.kind, m.body])).toEqual([
        ['text', 'Bonjour, appelez le 0555 00 11 22'],
        ['text', 'Second message'],
        ['system', `${colleague.user.fullName} joined as Eventor support`],
        ['text', 'Third'],
      ]);

      const { user: provider } = await makeProvider(db());
      const group = await request(t.http).post(`${API}/conversations`).set(admin.headers).send({ userIds: [user.id, provider.id], body: 'Group' }).expect(201);
      expect(group.body.data.id).not.toBe(res.body.data.id);
    });

    it('400 / 404 / 422 on create', async () => {
      const user = await makeUser(db());
      expectError(await request(t.http).post(`${API}/conversations`).set(admin.headers).send({ userIds: [], body: 'x' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${API}/conversations`).set(admin.headers).send({ userIds: [user.id] }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${API}/conversations`).set(admin.headers).send({ userIds: [user.id], body: 'x', subject: 'y' }), 400, 'VALIDATION_FAILED');
      const invalid = await request(t.http).post(`${API}/conversations`).set(admin.headers).set('Accept-Language', 'ar').send({ userIds: [MISSING, admin.user.id], body: 'x' });
      expectError(invalid, 422, 'RECIPIENT_INVALID');
      expect(invalid.body.message).toBe('يمكن إرسال الرسائل إلى حسابات العملاء أو مقدمي الخدمات الموجودة فقط.');
      expectError(await request(t.http).post(`${API}/conversations`).set(admin.headers).send({ userIds: [user.id], body: 'x', bookingId: MISSING }), 404, 'BOOKING_NOT_FOUND');
    });

    it('replies as support: joins once with a system message, masks contacts, audit', async () => {
      const c = await chat([['c', 'Le prestataire ne répond pas']]);
      const send = (body: unknown) => request(t.http).post(`${API}/conversations/${c.conversation.id}/messages`).set(admin.headers).send(body);
      const res = await send({ body: 'Nous le relançons. Support: 0770 00 00 00' }).expect(201);
      expect(res.body.data).toMatchObject({ senderLabel: 'Eventor support', bodyMasked: 'Nous le relançons. Support: [phone hidden]', kind: 'text' });
      await send({ body: 'Second reply' }).expect(201);
      const systems = await db().getRepository(Message).countBy({ conversationId: c.conversation.id, kind: MessageKind.System });
      expect(systems).toBe(1);
      expect(await db().getRepository(ConversationParticipant).findOneBy({ conversationId: c.conversation.id, userId: admin.user.id })).toMatchObject({ role: 'support' });
      expect(await audited('message.sent_as_support', c.conversation.id)).not.toBeNull();
      expectError(await send({}), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${API}/conversations/${MISSING}/messages`).set(admin.headers).send({ body: 'x' }), 404, 'CONVERSATION_NOT_FOUND');
    });
  });

  // ── moderation ──────────────────────────────────────────────

  describe('hide / unhide / delete', () => {
    it('moves messages between visible, hidden and deleted (rows kept), with audit', async () => {
      const c = await chat([['p', 'Call 0555 12 34 56']]);
      const [id] = c.messageIds;
      const hide = await request(t.http).post(`${API}/messages/${id}/hide`).set(admin.headers).send({ reason: 'Contact details shared' }).expect(200);
      expect(hide.body.data).toMatchObject({ id, status: 'hidden', moderation: { by: { id: admin.user.id }, at: expect.any(String) } });
      expect((await audited('message.hidden', id!))!.note).toBe('Contact details shared');
      expectError(await request(t.http).post(`${API}/messages/${id}/hide`).set(admin.headers).send({}), 409, 'MESSAGE_INVALID_TRANSITION');

      await request(t.http).post(`${API}/messages/${id}/unhide`).set(admin.headers).send({}).expect(200);
      expectError(await request(t.http).post(`${API}/messages/${id}/unhide`).set(admin.headers).send({}), 409, 'MESSAGE_INVALID_TRANSITION');

      const deleted = await request(t.http).delete(`${API}/messages/${id}`).set(admin.headers).send({ reason: 'Abusive' }).expect(200);
      expect(deleted.body.data).toMatchObject({ status: 'deleted', body: 'Call 0555 12 34 56' });
      expect(await db().getRepository(Message).findOneByOrFail({ id })).toMatchObject({ status: MessageStatus.Deleted });
      expect((await audited('message.deleted', id!))!.level).toBe('sensitive');
      expectError(await request(t.http).delete(`${API}/messages/${id}`).set(admin.headers).send({}), 409, 'MESSAGE_INVALID_TRANSITION');
      expectError(await request(t.http).post(`${API}/messages/${MISSING}/hide`).set(admin.headers).send({}), 404, 'MESSAGE_NOT_FOUND');
      expectError(await request(t.http).post(`${API}/messages/${id}/hide`).set(admin.headers).send({ reason: 'x'.repeat(300) }), 400, 'VALIDATION_FAILED');
      const client = await loginAs(t, UserRole.Client);
      expectError(await request(t.http).post(`${API}/messages/${id}/unhide`).set(client.headers).send({}), 403, 'FORBIDDEN_ROLE');
    });
  });

  // ── close / reopen ──────────────────────────────────────────

  describe('close / reopen', () => {
    const close = (id: string, body: Record<string, unknown>) => request(t.http).post(`${API}/conversations/${id}/close`).set(admin.headers).send(body);

    it('closes for one participant, then everyone; resolves reports; reopens', async () => {
      const c = await chat([['c', 'insulte']]);
      await makeReport(db(), { targetType: ReportTargetType.Message, targetId: c.messageIds[0], reporterId: c.provider.id });

      expectError(await close(c.conversation.id, { scope: 'one_participant', reason: 'harassment' }), 400, 'VALIDATION_FAILED');
      expectError(await close(c.conversation.id, { scope: 'one_participant', userId: MISSING, reason: 'harassment' }), 422, 'PARTICIPANT_NOT_FOUND');

      const one = await close(c.conversation.id, { scope: 'one_participant', userId: c.client.id, reason: 'harassment' }).expect(200);
      expect(one.body.data).toMatchObject({ status: 'closed', closed: { scope: 'one_participant', reason: 'harassment', closedBy: { id: admin.user.id }, mutedUserIds: [c.client.id] }, reports: [expect.any(Object)] });
      // Support can still write when only one participant is muted.
      await request(t.http).post(`${API}/conversations/${c.conversation.id}/messages`).set(admin.headers).send({ body: 'Avertissement' }).expect(201);
      expectError(await close(c.conversation.id, { scope: 'all', reason: 'x' }), 409, 'CONVERSATION_ALREADY_CLOSED');

      await request(t.http).post(`${API}/conversations/${c.conversation.id}/reopen`).set(admin.headers).expect(200);
      expectError(await request(t.http).post(`${API}/conversations/${c.conversation.id}/reopen`).set(admin.headers), 409, 'CONVERSATION_NOT_CLOSED');

      const all = await close(c.conversation.id, { scope: 'all', reason: 'spam', resolveReports: true }).expect(200);
      expect(all.body.data).toMatchObject({ closed: { scope: 'all', mutedUserIds: [c.client.id, c.provider.id] }, reports: [] });
      expect(await db().getRepository(Report).countBy({ targetId: c.messageIds[0], status: ReportStatus.Resolved })).toBe(1);
      expect((await audited('conversation.closed', c.conversation.id))!.level).toBe('sensitive');
      expectError(await request(t.http).post(`${API}/conversations/${c.conversation.id}/messages`).set(admin.headers).send({ body: 'x' }), 409, 'CONVERSATION_CLOSED');

      // Blocked users stay read-only after reopening.
      await db().query("UPDATE users SET status = 'blocked' WHERE id = ?", [c.provider.id]);
      const reopened = await request(t.http).post(`${API}/conversations/${c.conversation.id}/reopen`).set(admin.headers).expect(200);
      expect(reopened.body.data.participants.map((p: any) => [p.role, p.canWrite])).toEqual([
        ['client', true],
        ['provider', false],
        ['support', true],
      ]);
      expect(await audited('conversation.reopened', c.conversation.id)).not.toBeNull();
      expectError(await close(MISSING, { scope: 'all', reason: 'x' }), 404, 'CONVERSATION_NOT_FOUND');
    });
  });

  // ── socket ──────────────────────────────────────────────────

  describe('Socket.IO /admin', () => {
    let url: string;
    const sockets: Socket[] = [];

    beforeAll(async () => {
      await t.app.listen(0, '127.0.0.1');
      const { port } = t.app.getHttpServer().address() as AddressInfo;
      url = `http://127.0.0.1:${port}/admin`;
    });

    afterAll(() => sockets.forEach((s) => s.close()));

    const connect = (auth: Record<string, string>) => {
      const socket = io(url, { auth, transports: ['websocket'], reconnection: false, forceNew: true });
      sockets.push(socket);
      return socket;
    };
    const refused = (socket: Socket) => new Promise<unknown>((resolve) => socket.on('connect_error', (error: Error & { data?: unknown }) => resolve(error.data)));

    it('refuses missing, invalid and non-admin tokens', async () => {
      expect(await refused(connect({}))).toEqual({ code: 'AUTH_TOKEN_MISSING' });
      expect(await refused(connect({ token: 'nope' }))).toEqual({ code: 'AUTH_TOKEN_INVALID' });
      const client = await loginAs(t, UserRole.Client);
      expect(await refused(connect({ token: client.token }))).toEqual({ code: 'FORBIDDEN_ROLE' });
    });

    it('pushes message:new and conversation:updated to admins', async () => {
      const socket = connect({ token: `Bearer ${admin.token}` });
      await new Promise<void>((resolve, reject) => {
        socket.on('ready', () => resolve());
        socket.on('connect_error', reject);
      });
      const c = await chat([['c', 'Salam']]);
      const joined = await socket.emitWithAck('conversation:join', { conversationId: c.conversation.id });
      expect(joined).toEqual({ ok: true, room: `conversation:${c.conversation.id}` });
      const received = new Promise<any>((resolve) => socket.on('message:new', (m: any) => m.conversationId === c.conversation.id && m.kind === 'text' && resolve(m)));
      const updated = new Promise<any>((resolve) => socket.on('conversation:updated', (e: any) => e.conversationId === c.conversation.id && e.reason === 'message' && resolve(e)));
      await request(t.http).post(`${API}/conversations/${c.conversation.id}/messages`).set(admin.headers).send({ body: 'Numéro 0555 12 34 56' }).expect(201);
      expect(await received).toMatchObject({ body: 'Numéro 0555 12 34 56', bodyMasked: 'Numéro [phone hidden]', senderLabel: 'Eventor support' });
      expect(await updated).toEqual({ conversationId: c.conversation.id, reason: 'message' });
    });
  });
});
