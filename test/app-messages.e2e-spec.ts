import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BookingStatus } from '../src/common/enums/booking.enums.js';
import { ConversationStatus } from '../src/common/enums/messaging.enums.js';
import { ReportReason, ReportTargetType } from '../src/common/enums/moderation.enums.js';
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

const BASE = '/api/v1/app';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f80f00010101005e2f2f0000000049454e44ae426082', 'hex');

let t: TestApp;
let client: LoggedIn;
let provider: LoggedIn;
let stranger: LoggedIn;
let admin: LoggedIn;
const db = () => t.dataSource;

/** Opens the client ↔ provider chat and returns its id. */
async function chat(body = 'Hello, are you free on 14 November?') {
  const res = await request(t.http).post(`${BASE}/conversations`).set(client.headers).send({ userId: provider.user.id, body });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

beforeAll(async () => {
  t = await createApp();
  client = await loginAs(t, UserRole.Client);
  provider = await loginAs(t, UserRole.Provider);
  stranger = await loginAs(t, UserRole.Client);
  admin = await loginAs(t, UserRole.Admin);
});

afterAll(async () => {
  await t.close();
});

describe('App messages (e2e)', () => {
  describe('POST /app/conversations', () => {
    it('opens one direct chat per pair and reuses it', async () => {
      const first = await chat('First message');
      const second = await request(t.http).post(`${BASE}/conversations`).set(client.headers).send({ userId: provider.user.id, body: 'Second message' });

      expect(second.body.data.id).toBe(first);
      const rows = await db().query("SELECT id FROM conversations WHERE kind = 'direct' AND id = ?", [first]);
      expect(rows).toHaveLength(1);
      expect(second.body.data.participants).toHaveLength(2);
    });

    it('never exposes the other person’s email or phone', async () => {
      const id = await chat();
      const res = await request(t.http).get(`${BASE}/conversations/${id}`).set(client.headers);
      expect(JSON.stringify(res.body)).not.toContain(provider.user.email);
      expect(res.body.data.participants[0]).not.toHaveProperty('email');
    });

    it('refuses to write to the same role, to an admin and to myself', async () => {
      expectError(await request(t.http).post(`${BASE}/conversations`).set(client.headers).send({ userId: stranger.user.id, body: 'Hi' }), 422, 'RECIPIENT_INVALID');
      expectError(await request(t.http).post(`${BASE}/conversations`).set(client.headers).send({ userId: admin.user.id, body: 'Hi' }), 422, 'RECIPIENT_INVALID');
      expectError(await request(t.http).post(`${BASE}/conversations`).set(client.headers).send({ userId: client.user.id, body: 'Hi' }), 422, 'RECIPIENT_INVALID');
    });

    it('refuses a booking the two of us do not share', async () => {
      const other = await makeBooking(db(), { clientId: stranger.user.id, providerId: provider.user.id });
      expectError(await request(t.http).post(`${BASE}/conversations`).set(client.headers).send({ userId: provider.user.id, bookingId: other.id, body: 'Hi' }), 403, 'NOT_OWNER');
    });

    it('validates the body and 404s on an unknown user', async () => {
      expectError(await request(t.http).post(`${BASE}/conversations`).set(client.headers).send({ userId: provider.user.id }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${BASE}/conversations`).set(client.headers).send({ userId: provider.user.id, body: 'Hi', nope: 1 }), 400, 'VALIDATION_FAILED');
      expectError(
        await request(t.http).post(`${BASE}/conversations`).set(client.headers).send({ userId: '11111111-1111-4111-8111-111111111111', body: 'Hi' }),
        404,
        'USER_NOT_FOUND',
      );
    });

    it('needs a token', async () => {
      expect((await request(t.http).post(`${BASE}/conversations`).send({ userId: provider.user.id, body: 'Hi' })).status).toBe(401);
    });
  });

  describe('GET /app/conversations', () => {
    it('lists my chats with the other person, the last message and the unread count', async () => {
      const id = await chat('The last thing I said');

      const res = await request(t.http).get(`${BASE}/conversations`).set(provider.headers);

      expect(res.status).toBe(200);
      expect(res.body.meta).toMatchObject({ page: 1 });
      const row = res.body.data.find((c: { id: string }) => c.id === id);
      expect(row).toBeDefined();
      expect(row.other.id).toBe(client.user.id);
      expect(row.lastMessage).toBe('The last thing I said');
      expect(row.unreadCount).toBeGreaterThan(0);
    });

    it('filters on unread and on booking', async () => {
      const id = await chat();
      const unread = await request(t.http).get(`${BASE}/conversations?filter=unread`).set(provider.headers);
      expect(unread.body.data.map((c: { id: string }) => c.id)).toContain(id);

      await request(t.http).post(`${BASE}/conversations/${id}/read`).set(provider.headers).expect(200);
      const after = await request(t.http).get(`${BASE}/conversations?filter=unread`).set(provider.headers);
      expect(after.body.data.map((c: { id: string }) => c.id)).not.toContain(id);

      const booking = await request(t.http).get(`${BASE}/conversations?filter=booking`).set(provider.headers);
      expect(booking.body.data.every((c: { booking: unknown }) => c.booking !== null)).toBe(true);
    });

    it('never lists a chat I am not in', async () => {
      const id = await chat();
      const res = await request(t.http).get(`${BASE}/conversations?limit=100`).set(stranger.headers);
      expect(res.body.data.map((c: { id: string }) => c.id)).not.toContain(id);
    });

    it('rejects an unknown filter', async () => {
      expectError(await request(t.http).get(`${BASE}/conversations?filter=nope`).set(client.headers), 400, 'VALIDATION_FAILED');
    });
  });

  describe('GET /app/conversations/:id', () => {
    it('refuses a chat I am not part of, and 404s on an unknown one', async () => {
      const id = await chat();
      expectError(await request(t.http).get(`${BASE}/conversations/${id}`).set(stranger.headers), 403, 'NOT_A_PARTICIPANT');
      expectError(await request(t.http).get(`${BASE}/conversations/11111111-1111-4111-8111-111111111111`).set(client.headers), 404, 'CONVERSATION_NOT_FOUND');
    });

    it('answers a refusal in Arabic', async () => {
      const id = await chat();
      const res = await request(t.http).get(`${BASE}/conversations/${id}`).set(stranger.headers).set('Accept-Language', 'ar');
      expectError(res, 403, 'NOT_A_PARTICIPANT');
      expect(res.body.message).toMatch(/[؀-ۿ]/);
    });
  });

  describe('messages', () => {
    it('sends a message, pages backwards and marks the chat read', async () => {
      const id = await chat('one');
      for (const body of ['two', 'three', 'four']) {
        await request(t.http).post(`${BASE}/conversations/${id}/messages`).set(client.headers).send({ body }).expect(201);
      }

      const page = await request(t.http).get(`${BASE}/conversations/${id}/messages?limit=2`).set(provider.headers);
      expect(page.status).toBe(200);
      expect(page.body.data).toHaveLength(2);
      expect(page.body.data.map((m: { body: string }) => m.body)).toEqual(['three', 'four']);
      expect(page.body.meta.hasMore).toBe(true);

      const older = await request(t.http).get(`${BASE}/conversations/${id}/messages?limit=2&before=${page.body.meta.nextBefore}`).set(provider.headers);
      expect(older.body.data.map((m: { body: string }) => m.body)).toEqual(['one', 'two']);

      const read = await request(t.http).post(`${BASE}/conversations/${id}/read`).set(provider.headers);
      expect(read.body.data).toMatchObject({ conversationId: id, unreadCount: 0 });
    });

    it('marks who wrote each message', async () => {
      const id = await chat('mine');
      const mine = await request(t.http).get(`${BASE}/conversations/${id}/messages`).set(client.headers);
      expect(mine.body.data.at(-1).mine).toBe(true);
      const theirs = await request(t.http).get(`${BASE}/conversations/${id}/messages`).set(provider.headers);
      expect(theirs.body.data.at(-1).mine).toBe(false);
    });

    it('masks contact details until the pair share an accepted booking', async () => {
      const id = await chat('Call me on 0551234567');

      const masked = await request(t.http).get(`${BASE}/conversations/${id}/messages`).set(provider.headers);
      const last = masked.body.data.at(-1);
      expect(last.masked).toBe(true);
      expect(last.body).not.toContain('0551234567');
      expect(last.body).toContain('[phone hidden]');

      const category = await makeCategory(db());
      const service = await makeService(db(), { providerId: provider.user.id, categoryId: category.id });
      await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, serviceId: service.id, status: BookingStatus.Accepted, eventDate: '2027-04-04' });
      await db().query('UPDATE conversations SET booking_id = booking_id WHERE id = ?', [id]);

      const unmasked = await request(t.http).get(`${BASE}/conversations/${id}/messages`).set(provider.headers);
      expect(unmasked.body.data.at(-1).masked).toBe(false);
      expect(unmasked.body.data.at(-1).body).toContain('0551234567');
      const header = await request(t.http).get(`${BASE}/conversations/${id}`).set(provider.headers);
      expect(header.body.data.contactUnmasked).toBe(true);
    });

    it('accepts an image as multipart', async () => {
      const id = await chat();
      const res = await request(t.http).post(`${BASE}/conversations/${id}/messages`).set(client.headers).attach('file', PNG, 'photo.png');

      expect(res.status).toBe(201);
      expect(res.body.data.kind).toBe('attachment');
      expect(res.body.data.imageUrl).toEqual(expect.any(String));
    });

    it('refuses an empty message, a chat I am not in and a closed chat', async () => {
      const id = await chat();
      expectError(await request(t.http).post(`${BASE}/conversations/${id}/messages`).set(client.headers).send({}), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${BASE}/conversations/${id}/messages`).set(stranger.headers).send({ body: 'Hi' }), 403, 'NOT_A_PARTICIPANT');

      await db().query('UPDATE conversations SET status = ?, closed_scope = ? WHERE id = ?', [ConversationStatus.Closed, 'all', id]);
      expectError(await request(t.http).post(`${BASE}/conversations/${id}/messages`).set(client.headers).send({ body: 'Hi' }), 409, 'CONVERSATION_CLOSED');
      await db().query('UPDATE conversations SET status = ?, closed_scope = NULL WHERE id = ?', [ConversationStatus.Open, id]);
    });

    it('404s on an unknown cursor', async () => {
      const id = await chat();
      expectError(
        await request(t.http).get(`${BASE}/conversations/${id}/messages?before=11111111-1111-4111-8111-111111111111`).set(client.headers),
        404,
        'MESSAGE_NOT_FOUND',
      );
    });
  });

  describe('reports', () => {
    it('reports a message once, idempotently', async () => {
      const id = await chat('Contact me elsewhere');
      const messages = await request(t.http).get(`${BASE}/conversations/${id}/messages`).set(provider.headers);
      const messageId = messages.body.data[0].id;

      const first = await request(t.http).post(`${BASE}/messages/${messageId}/report`).set(provider.headers).send({ reason: ReportReason.ContactOutside, note: 'Asked for WhatsApp' });
      expect(first.status).toBe(201);
      expect(first.body.data.created).toBe(true);

      const again = await request(t.http).post(`${BASE}/messages/${messageId}/report`).set(provider.headers).send({ reason: ReportReason.ContactOutside });
      expect(again.body.data).toMatchObject({ id: first.body.data.id, created: false });

      const rows = await db().query("SELECT id FROM reports WHERE target_type = 'message' AND target_id = ? AND status = 'open'", [messageId]);
      expect(rows).toHaveLength(1);
    });

    it('refuses to report a message from a chat I am not in', async () => {
      const id = await chat();
      const messages = await request(t.http).get(`${BASE}/conversations/${id}/messages`).set(client.headers);
      expectError(
        await request(t.http).post(`${BASE}/messages/${messages.body.data[0].id}/report`).set(stranger.headers).send({ reason: ReportReason.Spam }),
        403,
        'NOT_A_PARTICIPANT',
      );
    });

    it('reports a service and a user, and refuses an unknown target or myself', async () => {
      const category = await makeCategory(db());
      const service = await makeService(db(), { providerId: provider.user.id, categoryId: category.id });

      const res = await request(t.http)
        .post(`${BASE}/reports`)
        .set(client.headers)
        .send({ targetType: ReportTargetType.Service, targetId: service.id, reason: ReportReason.Fake, note: 'Photos stolen' });
      expect(res.status).toBe(201);
      expect(res.body.data.created).toBe(true);

      const user = await request(t.http).post(`${BASE}/reports`).set(client.headers).send({ targetType: ReportTargetType.User, targetId: provider.user.id, reason: ReportReason.Harassment });
      expect(user.status).toBe(201);

      expectError(
        await request(t.http).post(`${BASE}/reports`).set(client.headers).send({ targetType: ReportTargetType.Service, targetId: '11111111-1111-4111-8111-111111111111', reason: ReportReason.Spam }),
        404,
        'REPORT_TARGET_NOT_FOUND',
      );
      expectError(
        await request(t.http).post(`${BASE}/reports`).set(client.headers).send({ targetType: ReportTargetType.User, targetId: client.user.id, reason: ReportReason.Spam }),
        400,
        'VALIDATION_FAILED',
      );
    });

    it('validates the report body', async () => {
      expectError(await request(t.http).post(`${BASE}/reports`).set(client.headers).send({ targetType: 'planet', targetId: provider.user.id, reason: ReportReason.Spam }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${BASE}/reports`).set(client.headers).send({ targetType: ReportTargetType.User, targetId: provider.user.id }), 400, 'VALIDATION_FAILED');
    });
  });

  describe('the /app socket', () => {
    let url: string;
    const sockets: Socket[] = [];

    const connect = (token?: string) =>
      new Promise<Socket>((resolve, reject) => {
        const socket = io(`${url}/app`, { transports: ['websocket'], auth: token ? { token } : {}, reconnection: false });
        sockets.push(socket);
        socket.on('ready', () => resolve(socket));
        socket.on('connect_error', (error) => reject(error));
      });

    beforeAll(async () => {
      await t.app.listen(0);
      const address = t.app.getHttpServer().address() as AddressInfo;
      url = `http://127.0.0.1:${address.port}`;
    });

    afterAll(() => {
      for (const socket of sockets) socket.disconnect();
    });

    it('refuses a handshake with no token', async () => {
      await expect(connect()).rejects.toMatchObject({ data: { code: 'AUTH_TOKEN_MISSING' } });
    });

    it('refuses a dashboard token with FORBIDDEN_AUDIENCE', async () => {
      await expect(connect(admin.token)).rejects.toMatchObject({ data: { code: 'FORBIDDEN_AUDIENCE' } });
    });

    it('refuses a made-up token', async () => {
      await expect(connect('not.a.token')).rejects.toMatchObject({ data: { code: 'AUTH_TOKEN_INVALID' } });
    });

    it('delivers message:new and conversation:updated to the other party', async () => {
      const socket = await connect(provider.token);
      const arrived = new Promise<{ conversationId: string; body: string; mine: boolean }>((resolve) => socket.once('message:new', resolve));
      const id = await chat('Socket hello');

      expect(await arrived).toMatchObject({ conversationId: id, body: 'Socket hello', mine: false });

      const updated = new Promise((resolve) => socket.once('conversation:updated', resolve));
      await request(t.http).post(`${BASE}/conversations/${id}/messages`).set(client.headers).send({ body: 'And again' });
      await expect(updated).resolves.toMatchObject({ conversationId: id });
    });

    it('refuses to join a conversation I am not part of', async () => {
      const socket = await connect(stranger.token);
      const id = await chat();

      const answer = await socket.emitWithAck('conversation:join', { conversationId: id });
      expect(answer).toMatchObject({ ok: false, code: 'NOT_A_PARTICIPANT' });
    });

    it('lets a participant join and leave its own room', async () => {
      const socket = await connect(client.token);
      const id = await chat();

      expect(await socket.emitWithAck('conversation:join', { conversationId: id })).toMatchObject({ ok: true });
      expect(await socket.emitWithAck('conversation:leave', { conversationId: id })).toMatchObject({ ok: true });
    });

    it('pushes booking:updated to both parties', async () => {
      const socket = await connect(client.token);
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, status: BookingStatus.Pending, eventDate: '2027-08-20' });

      const event = new Promise((resolve) => socket.once('booking:updated', resolve));
      await request(t.http).post(`/api/v1/app/provider/bookings/${booking.id}/accept`).set(provider.headers).expect(200);

      await expect(event).resolves.toMatchObject({ bookingId: booking.id, reference: booking.reference });
    });
  });
});
