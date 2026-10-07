import { describe, expect, it, vi } from 'vitest';
import { APP_NOTIFICATION_TYPES, APP_PUSH_ONLY_TYPES, NotificationsService, pushData, pushPreferenceOf } from './notifications.service.js';

describe('pushPreferenceOf', () => {
  it('maps each push to the Profile · Notifications switch that mutes it', () => {
    expect(pushPreferenceOf('booking.accepted')).toBe('push_bookings');
    expect(pushPreferenceOf('dispute.resolved')).toBe('push_bookings');
    expect(pushPreferenceOf('academic_request.cancelled')).toBe('push_bookings');
    expect(pushPreferenceOf('message.new')).toBe('push_messages');
    expect(pushPreferenceOf('dispute.message')).toBe('push_messages');
    expect(pushPreferenceOf('review.new')).toBe('push_reviews');
    expect(pushPreferenceOf('review_reply.hidden')).toBe('push_reviews');
    expect(pushPreferenceOf('verification.approved')).toBeNull();
    expect(pushPreferenceOf('test')).toBeNull();
  });

  it('covers every documented type', () => {
    for (const type of [...APP_NOTIFICATION_TYPES, ...APP_PUSH_ONLY_TYPES]) {
      const switchName = pushPreferenceOf(type);
      if (type.startsWith('report.') || type.startsWith('verification.') || type === 'test') expect(switchName).toBeNull();
      else expect(switchName).not.toBeNull();
    }
  });
});

describe('pushData', () => {
  it('turns values into strings and leaves empty ones out', () => {
    expect(pushData({ bookingId: 'b-1', rating: 5, paid: false, replyId: null })).toEqual({ bookingId: 'b-1', rating: '5', paid: 'false' });
    expect(pushData(undefined)).toEqual({});
  });
});

describe('NotificationsService push', () => {
  function setup(devices: { user_id: string; language: string; token: string; platform: string }[]) {
    const queries: { sql: string; params: unknown[] }[] = [];
    const dataSource = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return sql.trimStart().startsWith('SELECT d.user_id') ? devices : undefined;
      }),
    };
    const pushService = { dispatch: vi.fn() };
    const emitter = { emitAsync: vi.fn(async () => []) };
    const service = new NotificationsService(dataSource as any, pushService as any, emitter as any);
    return { service, queries, dispatched: () => pushService.dispatch.mock.calls as any[][], emitter };
  }

  it('notify writes the rows, then pushes each user with the row id and the type', async () => {
    const t = setup([
      { user_id: 'u-1', language: 'en', token: 'tok-a', platform: 'android' },
      { user_id: 'u-1', language: 'en', token: 'tok-b', platform: 'ios' },
    ]);
    await t.service.notify(['u-1', 'u-1'], { type: 'booking.accepted', title: 'Booking confirmed', body: 'See you', data: { bookingId: 'b-1', note: null } }, { push: true });
    const inserts = t.queries.filter((q) => q.sql.startsWith('INSERT INTO notifications'));
    expect(inserts).toHaveLength(1);
    expect(t.emitter.emitAsync).toHaveBeenCalledOnce();
    const devicesQuery = t.queries.find((q) => q.sql.trimStart().startsWith('SELECT d.user_id'))!;
    expect(devicesQuery.sql).toContain('COALESCE(p.push_bookings, 1) = 1');
    expect(t.dispatched()).toEqual([
      [
        [
          { token: 'tok-a', platform: 'android' },
          { token: 'tok-b', platform: 'ios' },
        ],
        { title: 'Booking confirmed', body: 'See you', data: { bookingId: 'b-1', notificationId: inserts[0]!.params[0], type: 'booking.accepted' } },
      ],
    ]);
  });

  it('notify without push writes the row only', async () => {
    const t = setup([{ user_id: 'u-1', language: 'en', token: 'tok-a', platform: 'android' }]);
    await t.service.notify(['u-1'], { type: 'review.hidden', title: 't', body: 'b' });
    expect(t.queries.some((q) => q.sql.trimStart().startsWith('SELECT d.user_id'))).toBe(false);
    expect(t.dispatched()).toEqual([]);
  });

  it('push builds each message in the recipient language; account news ignores the switches', async () => {
    const t = setup([
      { user_id: 'u-en', language: 'en', token: 'tok-en', platform: 'android' },
      { user_id: 'u-ar', language: 'ar', token: 'tok-ar', platform: 'ios' },
    ]);
    await t.service.push(['u-en', 'u-ar'], 'verification.approved', (_userId, lang) => ({ title: lang, body: lang }));
    expect(t.queries[0]!.sql).not.toContain('COALESCE(p.');
    expect(t.dispatched().map(([targets, message]) => [targets[0].token, message.title, message.data.type])).toEqual([
      ['tok-en', 'en', 'verification.approved'],
      ['tok-ar', 'ar', 'verification.approved'],
    ]);
  });
});
