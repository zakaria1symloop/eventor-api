/**
 * Who gets the 🔔📱 notification (and the ✉️ email) for each booking event,
 * in which language. The database, mail queue and NotificationsService are
 * fakes: these tests pin the recipients and texts, not the SQL.
 */
import { describe, expect, it, vi } from 'vitest';
import { BookingsMailListener } from './bookings-mail.listener.js';
import type { BookingCancelledEvent, BookingEvent, BookingRescheduledEvent, BookingStatusChangedEvent } from './bookings.events.js';

const CLIENT = 'client-1';
const PROVIDER = 'provider-1';
const ADMIN = 'admin-1';

function setup(overrides: { clientLang?: 'en' | 'ar'; clientEmails?: 0 | 1 } = {}) {
  const row = {
    c_id: CLIENT, c_email: 'client@example.com', c_name: 'Client', c_lang: overrides.clientLang ?? 'en', c_deleted: null, c_emails: overrides.clientEmails ?? 1,
    p_id: PROVIDER, p_email: 'provider@example.com', p_name: 'Provider', p_lang: 'en', p_deleted: null, p_emails: 1,
    title_en: 'Wedding photos', title_ar: 'تصوير الأعراس', event_date: '2026-11-14',
  };
  const mail = { enqueue: vi.fn(async () => undefined) };
  const notifications = { notify: vi.fn(async () => undefined) };
  const listener = new BookingsMailListener({ query: vi.fn(async () => [row]) } as any, mail as any, notifications as any);
  const notified = () =>
    notifications.notify.mock.calls.map((call: any[]) => ({ to: call[0][0], type: call[1].type, title: call[1].title, body: call[1].body, data: call[1].data, push: call[2]?.push }));
  const emailed = () => mail.enqueue.mock.calls.map((call: any[]) => call[0].to);
  return { listener, notified, emailed };
}

const base: BookingEvent = { bookingId: 'b-1', reference: 'EVT-1', clientId: CLIENT, providerId: PROVIDER, notify: true };
const status = (extra: Partial<BookingStatusChangedEvent> = {}): BookingStatusChangedEvent => ({ ...base, from: 'pending' as any, to: 'accepted' as any, reason: null, note: null, actorId: PROVIDER, ...extra });
const moved = (extra: Partial<BookingRescheduledEvent>): BookingRescheduledEvent => ({ ...base, oldDate: '2026-11-14', newDate: '2026-11-21', applied: false, actorId: null, ...extra });

describe('booking notifications', () => {
  it('a new request tells the provider, with the booking id to open', async () => {
    const t = setup();
    await t.listener.onCreated(base);
    expect(t.notified()).toEqual([
      { to: PROVIDER, type: 'booking.requested', title: 'New booking request', body: '"Wedding photos" on 2026-11-14. Accept or decline it in the app.', data: { bookingId: 'b-1', reference: 'EVT-1' }, push: true },
    ]);
  });

  it('acceptance tells the client in their language', async () => {
    const t = setup({ clientLang: 'ar' });
    await t.listener.onAccepted(status());
    expect(t.notified()).toEqual([expect.objectContaining({ to: CLIENT, type: 'booking.accepted', title: 'تم تأكيد الحجز', push: true })]);
    expect(t.notified()[0]!.body).toContain('«تصوير الأعراس»');
  });

  it('a decline tells the client', async () => {
    const t = setup();
    await t.listener.onDeclined(status({ to: 'declined' as any }));
    expect(t.notified().map((n) => [n.to, n.type])).toEqual([[CLIENT, 'booking.declined']]);
  });

  it('a cancellation tells only the other party', async () => {
    const byClient = setup();
    await byClient.listener.onCancelled({ ...base, cancelledBy: 'client', reason: 'x', causedByUserId: null } satisfies BookingCancelledEvent);
    expect(byClient.notified().map((n) => [n.to, n.type])).toEqual([[PROVIDER, 'booking.cancelled']]);
    expect(byClient.emailed()).toEqual(['provider@example.com']);

    const byAdmin = setup();
    await byAdmin.listener.onCancelled({ ...base, cancelledBy: 'admin', reason: 'x', causedByUserId: null });
    expect(byAdmin.notified().map((n) => n.to)).toEqual([CLIENT, PROVIDER]);
  });

  it('completion tells both parties except the one who confirmed last', async () => {
    const t = setup();
    await t.listener.onCompleted(status({ to: 'completed' as any, actorId: CLIENT }));
    expect(t.notified().map((n) => [n.to, n.type])).toEqual([[PROVIDER, 'booking.completed']]);
    const job = setup();
    await job.listener.onCompleted(status({ to: 'completed' as any, actorId: null }));
    expect(job.notified().map((n) => n.to)).toEqual([CLIENT, PROVIDER]);
  });

  it('a proposed date goes to the other party and names who proposed it', async () => {
    const t = setup();
    await t.listener.onRescheduleProposed(moved({ actorId: CLIENT }));
    expect(t.notified()).toEqual([expect.objectContaining({ to: PROVIDER, type: 'booking.reschedule_proposed', title: 'New date proposed' })]);
    expect(t.notified()[0]!.body).toBe('The client proposed to move "Wedding photos" from 2026-11-14 to 2026-11-21. Accept or decline it in the app.');
    expect(t.emailed()).toEqual(['provider@example.com']);

    const byEventor = setup();
    await byEventor.listener.onRescheduleProposed(moved({ actorId: ADMIN }));
    expect(byEventor.notified().map((n) => n.to)).toEqual([CLIENT, PROVIDER]);
    expect(byEventor.notified()[0]!.body).toMatch(/^Eventor proposed/);
  });

  it('an accepted or rejected date tells the other side, never asks to confirm again', async () => {
    const accepted = setup();
    await accepted.listener.onRescheduled(moved({ applied: true, actorId: PROVIDER }));
    expect(accepted.notified().map((n) => [n.to, n.type])).toEqual([[CLIENT, 'booking.rescheduled']]);

    const rejected = setup();
    await rejected.listener.onRescheduleRejected(moved({ actorId: PROVIDER }));
    expect(rejected.notified()).toEqual([expect.objectContaining({ to: CLIENT, type: 'booking.reschedule_rejected', title: 'New date declined' })]);
    expect(rejected.notified()[0]!.body).toBe('The proposal to move "Wedding photos" to 2026-11-21 was declined. The booking stays on 2026-11-14.');
  });

  it('price changes, reminders and review requests reach the right party', async () => {
    const t = setup();
    await t.listener.onPriceChanged({ ...base, oldTotal: '10000.00', newTotal: '12000.00' });
    await t.listener.onReminder({ ...base, automatic: true });
    await t.listener.onReviewRequested(base);
    expect(t.notified().map((n) => [n.to, n.type])).toEqual([
      [CLIENT, 'booking.price_changed'],
      [PROVIDER, 'booking.reminder'],
      [CLIENT, 'booking.review_requested'],
    ]);
  });

  it('"Booking emails" off stops the email, not the notification', async () => {
    const t = setup({ clientEmails: 0 });
    await t.listener.onAccepted(status());
    expect(t.emailed()).toEqual(['provider@example.com']);
    expect(t.notified().map((n) => n.to)).toEqual([CLIENT]);
  });

  it('an admin change with "Notify" unticked sends nothing', async () => {
    const t = setup();
    await t.listener.onAccepted(status({ notify: false }));
    await t.listener.onCancelled({ ...base, notify: false, cancelledBy: 'admin', reason: 'x', causedByUserId: null });
    expect(t.notified()).toEqual([]);
    expect(t.emailed()).toEqual([]);
  });
});
