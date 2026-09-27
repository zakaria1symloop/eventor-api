import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BookingDisputeStatus, BookingStatus } from '../src/common/enums/booking.enums.js';
import { DisputeStatus, DisputeType, ReviewStatus } from '../src/common/enums/moderation.enums.js';
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
const COMMENT = 'Wonderful team, the photos arrived in two weeks.';

let t: TestApp;
let client: LoggedIn;
let provider: LoggedIn;
let stranger: LoggedIn;
let serviceId: string;
const db = () => t.dataSource;

/** A completed booking whose review window is already open (completed two days ago). */
async function reviewableBooking(overrides: Record<string, unknown> = {}) {
  const booking = await makeBooking(db(), {
    clientId: client.user.id,
    providerId: provider.user.id,
    serviceId,
    status: BookingStatus.Completed,
    eventDate: '2026-08-01',
    completedAt: new Date(Date.now() - 2 * 86_400_000),
    ...overrides,
  });
  return booking;
}

/** An accepted booking whose event happened yesterday: inside the dispute window. */
async function disputableBooking() {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, serviceId, status: BookingStatus.Accepted, eventDate: yesterday });
}

beforeAll(async () => {
  t = await createApp();
  client = await loginAs(t, UserRole.Client);
  provider = await loginAs(t, UserRole.Provider);
  stranger = await loginAs(t, UserRole.Client);
  const category = await makeCategory(db());
  serviceId = (await makeService(db(), { providerId: provider.user.id, categoryId: category.id })).id;
});

afterAll(async () => {
  await t.close();
});

describe('App reviews and disputes (e2e)', () => {
  describe('POST /app/bookings/:id/review', () => {
    it('reviews a completed booking and recomputes the ratings', async () => {
      const booking = await reviewableBooking();

      const res = await request(t.http).post(`${BASE}/bookings/${booking.id}/review`).set(client.headers).send({ rating: 5, comment: COMMENT });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ rating: 5, comment: COMMENT, bookingId: booking.id, status: ReviewStatus.Published, editable: true });
      const [service] = await db().query('SELECT avg_rating, rating_count FROM services WHERE id = ?', [serviceId]);
      expect(Number(service.rating_count)).toBeGreaterThan(0);
      const [profile] = await db().query('SELECT rating_count FROM provider_profiles WHERE user_id = ?', [provider.user.id]);
      expect(Number(profile.rating_count)).toBeGreaterThan(0);
    });

    it('publishes a flagged comment and opens an automatic report', async () => {
      const booking = await reviewableBooking();

      const res = await request(t.http)
        .post(`${BASE}/bookings/${booking.id}/review`)
        .set(client.headers)
        .send({ rating: 4, comment: 'Good work, reach me on 0551234567 next time.' });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe(ReviewStatus.Published);
      const reports = await db().query("SELECT reporter_id FROM reports WHERE target_type = 'review' AND target_id = ? AND status = 'open'", [res.body.data.id]);
      expect(reports).toHaveLength(1);
      expect(reports[0].reporter_id).toBeNull();
    });

    it('refuses a second review on the same booking', async () => {
      const booking = await reviewableBooking();
      await request(t.http).post(`${BASE}/bookings/${booking.id}/review`).set(client.headers).send({ rating: 5, comment: COMMENT }).expect(201);

      expectError(await request(t.http).post(`${BASE}/bookings/${booking.id}/review`).set(client.headers).send({ rating: 3, comment: COMMENT }), 409, 'REVIEW_EXISTS');
    });

    it('refuses a booking that is not completed', async () => {
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, serviceId, status: BookingStatus.Accepted });
      expectError(await request(t.http).post(`${BASE}/bookings/${booking.id}/review`).set(client.headers).send({ rating: 5, comment: COMMENT }), 422, 'REVIEW_NOT_ALLOWED');
    });

    it('refuses while a dispute is open', async () => {
      const booking = await reviewableBooking({ disputeStatus: BookingDisputeStatus.Open });
      expectError(await request(t.http).post(`${BASE}/bookings/${booking.id}/review`).set(client.headers).send({ rating: 5, comment: COMMENT }), 422, 'REVIEW_NOT_ALLOWED');
    });

    it('refuses before the window opens and after it closes', async () => {
      const tooEarly = await reviewableBooking({ completedAt: new Date() });
      expectError(await request(t.http).post(`${BASE}/bookings/${tooEarly.id}/review`).set(client.headers).send({ rating: 5, comment: COMMENT }), 422, 'REVIEW_WINDOW_CLOSED');

      const tooLate = await reviewableBooking({ completedAt: new Date(Date.now() - 90 * 86_400_000) });
      expectError(await request(t.http).post(`${BASE}/bookings/${tooLate.id}/review`).set(client.headers).send({ rating: 5, comment: COMMENT }), 422, 'REVIEW_WINDOW_CLOSED');
    });

    it('refuses somebody else’s booking and the provider', async () => {
      const booking = await reviewableBooking();
      expectError(await request(t.http).post(`${BASE}/bookings/${booking.id}/review`).set(stranger.headers).send({ rating: 5, comment: COMMENT }), 403, 'NOT_OWNER');
      expectError(await request(t.http).post(`${BASE}/bookings/${booking.id}/review`).set(provider.headers).send({ rating: 5, comment: COMMENT }), 403, 'FORBIDDEN_ROLE');
    });

    it('validates the rating and the comment', async () => {
      const booking = await reviewableBooking();
      for (const body of [{ rating: 6, comment: COMMENT }, { rating: 5, comment: 'short' }, { comment: COMMENT }, { rating: 5, comment: COMMENT, nope: 1 }]) {
        expectError(await request(t.http).post(`${BASE}/bookings/${booking.id}/review`).set(client.headers).send(body), 400, 'VALIDATION_FAILED');
      }
    });

    it('404s on an unknown booking and needs a token', async () => {
      expectError(
        await request(t.http).post(`${BASE}/bookings/11111111-1111-4111-8111-111111111111/review`).set(client.headers).send({ rating: 5, comment: COMMENT }),
        404,
        'BOOKING_NOT_FOUND',
      );
      expect((await request(t.http).post(`${BASE}/bookings/11111111-1111-4111-8111-111111111111/review`).send({ rating: 5, comment: COMMENT })).status).toBe(401);
    });

    it('answers in Arabic', async () => {
      const booking = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, serviceId, status: BookingStatus.Accepted });
      const res = await request(t.http).post(`${BASE}/bookings/${booking.id}/review`).set(client.headers).set('Accept-Language', 'ar').send({ rating: 5, comment: COMMENT });
      expectError(res, 422, 'REVIEW_NOT_ALLOWED');
      expect(res.body.message).toMatch(/[؀-ۿ]/);
    });
  });

  describe('PATCH /app/reviews/:id and GET /app/me/reviews', () => {
    it('edits my review inside the 48-hour window and lists it', async () => {
      const booking = await reviewableBooking();
      const created = await request(t.http).post(`${BASE}/bookings/${booking.id}/review`).set(client.headers).send({ rating: 3, comment: COMMENT });

      const edited = await request(t.http).patch(`${BASE}/reviews/${created.body.data.id}`).set(client.headers).send({ rating: 5, comment: 'Updated: the album arrived after all.' });
      expect(edited.status).toBe(200);
      expect(edited.body.data).toMatchObject({ rating: 5, comment: 'Updated: the album arrived after all.' });

      const mine = await request(t.http).get(`${BASE}/me/reviews?limit=100`).set(client.headers);
      expect(mine.status).toBe(200);
      expect(mine.body.meta).toMatchObject({ page: 1 });
      expect(mine.body.data.map((r: { id: string }) => r.id)).toContain(created.body.data.id);
    });

    it('refuses an edit after 48 hours, an empty edit and somebody else’s review', async () => {
      const booking = await reviewableBooking();
      const created = await request(t.http).post(`${BASE}/bookings/${booking.id}/review`).set(client.headers).send({ rating: 4, comment: COMMENT });

      expectError(await request(t.http).patch(`${BASE}/reviews/${created.body.data.id}`).set(client.headers).send({}), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).patch(`${BASE}/reviews/${created.body.data.id}`).set(stranger.headers).send({ rating: 1 }), 403, 'NOT_OWNER');

      await db().query('UPDATE reviews SET created_at = DATE_SUB(NOW(6), INTERVAL 3 DAY) WHERE id = ?', [created.body.data.id]);
      expectError(await request(t.http).patch(`${BASE}/reviews/${created.body.data.id}`).set(client.headers).send({ rating: 1 }), 422, 'REVIEW_EDIT_WINDOW_CLOSED');
    });

    it('lists only my own reviews and 404s on an unknown one', async () => {
      const res = await request(t.http).get(`${BASE}/me/reviews?limit=100`).set(stranger.headers);
      expect(res.body.data).toHaveLength(0);
      expectError(await request(t.http).patch(`${BASE}/reviews/11111111-1111-4111-8111-111111111111`).set(client.headers).send({ rating: 1 }), 404, 'REVIEW_NOT_FOUND');
    });
  });

  describe('disputes', () => {
    it('opens a dispute, pauses the booking and attaches the chat snapshot', async () => {
      const booking = await disputableBooking();

      const res = await request(t.http)
        .post(`${BASE}/bookings/${booking.id}/disputes`)
        .set(client.headers)
        .send({ type: DisputeType.IncompleteOrLate, description: 'The team arrived three hours late and left before the cake.' });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ status: DisputeStatus.Open, openedByMe: true, bookingId: booking.id });
      expect(res.body.data.reference).toMatch(/^DSP-/);
      expect(res.body.data.conversationId).toEqual(expect.any(String));
      expect(res.body.data.active).toBe(true);

      const [row] = await db().query('SELECT dispute_status FROM bookings WHERE id = ?', [booking.id]);
      expect(row.dispute_status).toBe('open');

      // #27: the other party's notification carries the typed ids, conversationId included.
      const [notification] = await db().query(
        "SELECT data FROM notifications WHERE user_id = ? AND type = 'dispute.opened' ORDER BY created_at DESC LIMIT 1",
        [provider.user.id],
      );
      const data = typeof notification.data === 'string' ? JSON.parse(notification.data) : notification.data;
      expect(data).toMatchObject({ disputeId: res.body.data.id, bookingId: booking.id, conversationId: res.body.data.conversationId });
    });

    it('refuses a second open dispute on the same booking', async () => {
      const booking = await disputableBooking();
      const body = { type: DisputeType.Behaviour, description: 'The provider was rude to our guests all evening long.' };
      await request(t.http).post(`${BASE}/bookings/${booking.id}/disputes`).set(client.headers).send(body).expect(201);

      expectError(await request(t.http).post(`${BASE}/bookings/${booking.id}/disputes`).set(provider.headers).send(body), 409, 'DISPUTE_ALREADY_OPEN');
    });

    it('refuses outside the window and on a pending booking', async () => {
      const future = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, serviceId, status: BookingStatus.Accepted, eventDate: '2027-12-31' });
      expectError(
        await request(t.http).post(`${BASE}/bookings/${future.id}/disputes`).set(client.headers).send({ type: DisputeType.Other, description: 'It has not even happened yet, but still.' }),
        422,
        'DISPUTE_WINDOW_CLOSED',
      );

      const pending = await makeBooking(db(), { clientId: client.user.id, providerId: provider.user.id, serviceId, status: BookingStatus.Pending });
      expectError(
        await request(t.http).post(`${BASE}/bookings/${pending.id}/disputes`).set(client.headers).send({ type: DisputeType.Other, description: 'Nothing has happened here at all yet.' }),
        422,
        'BOOKING_NOT_DISPUTABLE',
      );
    });

    it('refuses a booking that is not mine, and validates the description', async () => {
      const booking = await disputableBooking();
      expectError(
        await request(t.http).post(`${BASE}/bookings/${booking.id}/disputes`).set(stranger.headers).send({ type: DisputeType.Other, description: 'I am not part of this booking at all.' }),
        403,
        'NOT_OWNER',
      );
      expectError(await request(t.http).post(`${BASE}/bookings/${booking.id}/disputes`).set(client.headers).send({ type: DisputeType.Other, description: 'Too short' }), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${BASE}/bookings/${booking.id}/disputes`).set(client.headers).send({ description: 'A long enough description of the problem.' }), 400, 'VALIDATION_FAILED');
    });

    it('lets the provider open one too, and both sides read it', async () => {
      const booking = await disputableBooking();
      const opened = await request(t.http)
        .post(`${BASE}/bookings/${booking.id}/disputes`)
        .set(provider.headers)
        .send({ type: DisputeType.ClientNoShow, description: 'Nobody was at the venue when the team arrived at 18:00.' });

      expect(opened.body.data.openedByRole).toBe('provider');
      expect(opened.body.data.openedByMe).toBe(true);

      const asClient = await request(t.http).get(`${BASE}/disputes/${opened.body.data.id}`).set(client.headers);
      expect(asClient.status).toBe(200);
      expect(asClient.body.data.openedByMe).toBe(false);

      expectError(await request(t.http).get(`${BASE}/disputes/${opened.body.data.id}`).set(stranger.headers), 403, 'NOT_OWNER');
      expectError(await request(t.http).get(`${BASE}/disputes/11111111-1111-4111-8111-111111111111`).set(client.headers), 404, 'DISPUTE_NOT_FOUND');
    });

    it('lists only my disputes', async () => {
      const booking = await disputableBooking();
      const opened = await request(t.http)
        .post(`${BASE}/bookings/${booking.id}/disputes`)
        .set(client.headers)
        .send({ type: DisputeType.Other, description: 'Something went wrong that evening and we need help.' });

      const mine = await request(t.http).get(`${BASE}/disputes?limit=100`).set(client.headers);
      expect(mine.body.data.map((d: { id: string }) => d.id)).toContain(opened.body.data.id);

      const theirs = await request(t.http).get(`${BASE}/disputes?limit=100`).set(stranger.headers);
      expect(theirs.body.data).toHaveLength(0);
    });

    it('posts a message in the dispute chat and adds evidence', async () => {
      const booking = await disputableBooking();
      const opened = await request(t.http)
        .post(`${BASE}/bookings/${booking.id}/disputes`)
        .set(client.headers)
        .send({ type: DisputeType.DamageOrSafety, description: 'A speaker fell over and broke part of the decoration.' });
      const id = opened.body.data.id;

      const message = await request(t.http).post(`${BASE}/disputes/${id}/messages`).set(client.headers).send({ body: 'Here is what happened.' });
      expect(message.status).toBe(201);
      expect(message.body.data.body).toBe('Here is what happened.');

      const evidence = await request(t.http).post(`${BASE}/disputes/${id}/evidence`).set(client.headers).field('note', 'Photo of the damage').attach('file', PNG, 'damage.png');
      expect(evidence.status).toBe(201);
      expect(evidence.body.data.evidence.some((e: { kind: string; mine: boolean }) => e.kind === 'file' && e.mine)).toBe(true);

      expectError(await request(t.http).post(`${BASE}/disputes/${id}/evidence`).set(client.headers), 400, 'VALIDATION_FAILED');
      expectError(await request(t.http).post(`${BASE}/disputes/${id}/messages`).set(stranger.headers).send({ body: 'Not mine' }), 403, 'NOT_OWNER');
    });

    it('answers the dispute text route with the app message shape (mine, removed, masked)', async () => {
      const booking = await disputableBooking();
      const opened = await request(t.http)
        .post(`${BASE}/bookings/${booking.id}/disputes`)
        .set(client.headers)
        .send({ type: DisputeType.Other, description: 'The message shape matters to the chat screen.' });

      const message = await request(t.http).post(`${BASE}/disputes/${opened.body.data.id}/messages`).set(client.headers).send({ body: 'Shape check.' });
      expect(message.status).toBe(201);
      expect(message.body.data).toMatchObject({
        conversationId: opened.body.data.conversationId,
        body: 'Shape check.',
        kind: 'text',
        mine: true,
        removed: false,
        senderId: client.user.id,
      });
    });

    it('accepts the normal conversation route in an open dispute chat, images included (#41)', async () => {
      const booking = await disputableBooking();
      const opened = await request(t.http)
        .post(`${BASE}/bookings/${booking.id}/disputes`)
        .set(client.headers)
        .send({ type: DisputeType.Other, description: 'We will keep talking in the normal chat route.' });
      const conversationId = opened.body.data.conversationId;
      expect(conversationId).toEqual(expect.any(String));

      // Text from the other party, through the generic route.
      const text = await request(t.http).post(`/api/v1/app/conversations/${conversationId}/messages`).set(provider.headers).send({ body: 'Answering in the dispute chat.' });
      expect(text.status).toBe(201);

      // A photo, multipart — the dispute text route cannot do this.
      const image = await request(t.http).post(`/api/v1/app/conversations/${conversationId}/messages`).set(client.headers).attach('file', PNG, 'proof.png');
      expect(image.status).toBe(201);
      expect(image.body.data.kind).toBe('attachment');

      const page = await request(t.http).get(`/api/v1/app/conversations/${conversationId}/messages`).set(client.headers);
      const bodies = page.body.data.map((m: { body: string }) => m.body);
      expect(bodies).toContain('Answering in the dispute chat.');

      // A stranger is still shut out, and a closed chat refuses with 409.
      expectError(await request(t.http).post(`/api/v1/app/conversations/${conversationId}/messages`).set(stranger.headers).send({ body: 'Hi' }), 403, 'NOT_A_PARTICIPANT');
      await db().query("UPDATE conversations SET status = 'closed', closed_scope = 'all' WHERE id = ?", [conversationId]);
      const closed = await request(t.http).post(`/api/v1/app/conversations/${conversationId}/messages`).set(client.headers).send({ body: 'Too late' }).set('Accept-Language', 'ar');
      expectError(closed, 409, 'CONVERSATION_CLOSED');
      expect(closed.body.message).toMatch(/[؀-ۿ]/);
      expectError(await request(t.http).post(`${BASE}/disputes/${opened.body.data.id}/messages`).set(client.headers).send({ body: 'Too late here too' }), 409, 'CONVERSATION_CLOSED');
    });

    it('lets the opener withdraw, and nobody else', async () => {
      const booking = await disputableBooking();
      const opened = await request(t.http)
        .post(`${BASE}/bookings/${booking.id}/disputes`)
        .set(client.headers)
        .send({ type: DisputeType.Other, description: 'We opened this one but then sorted it out ourselves.' });
      const id = opened.body.data.id;

      expectError(await request(t.http).post(`${BASE}/disputes/${id}/withdraw`).set(provider.headers).send({ note: 'Not mine to withdraw' }), 409, 'DISPUTE_NOT_WITHDRAWABLE');
      expectError(await request(t.http).post(`${BASE}/disputes/${id}/withdraw`).set(client.headers).send({}), 400, 'VALIDATION_FAILED');

      const res = await request(t.http).post(`${BASE}/disputes/${id}/withdraw`).set(client.headers).send({ note: 'We settled it directly.' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: DisputeStatus.Closed, active: false });
      const [row] = await db().query('SELECT dispute_status FROM bookings WHERE id = ?', [booking.id]);
      expect(row.dispute_status).toBe('none');

      expectError(await request(t.http).post(`${BASE}/disputes/${id}/withdraw`).set(client.headers).send({ note: 'Again' }), 409, 'DISPUTE_NOT_WITHDRAWABLE');
    });
  });
});
