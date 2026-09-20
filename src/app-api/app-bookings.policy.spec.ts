import { describe, expect, it } from 'vitest';
import { BookingDisputeStatus, BookingStatus } from '../common/enums/booking.enums.js';
import { AppException } from '../common/errors/app.exception.js';
import {
  appBookingActions,
  assertOwner,
  bookingTabSql,
  checkInOutcome,
  checkInRefusal,
  EDIT_WINDOW_HOURS,
  REVIEW_WINDOW_DAYS,
  reviewWindow,
  withinEditWindow,
  type AppBookingState,
} from './app-bookings.policy.js';

const TODAY = '2026-11-20';

function state(overrides: Partial<AppBookingState> = {}): AppBookingState {
  return {
    status: BookingStatus.Accepted,
    disputeStatus: BookingDisputeStatus.None,
    eventDate: '2026-12-01',
    today: TODAY,
    pendingRescheduleForMe: false,
    checkedIn: false,
    hasReview: false,
    disputeWindowOpen: false,
    reviewWindowOpen: false,
    ...overrides,
  };
}

describe('bookingTabSql', () => {
  it('puts a booking in exactly one client tab', () => {
    const tabs = (['upcoming', 'pending', 'past', 'cancelled'] as const).map((tab) => bookingTabSql(tab).sql);
    expect(new Set(tabs).size).toBe(4);
  });

  it('only the date-sensitive tabs take today as a parameter', () => {
    expect(bookingTabSql('pending').params(TODAY)).toEqual([]);
    expect(bookingTabSql('cancelled').params(TODAY)).toEqual([]);
    expect(bookingTabSql('upcoming').params(TODAY)).toEqual([TODAY]);
    expect(bookingTabSql('past').params(TODAY)).toEqual([TODAY]);
  });

  it('treats a declined booking as cancelled, as the Bookings tab does', () => {
    expect(bookingTabSql('cancelled').sql).toContain("'declined'");
  });

  it('gives the provider Requests tab the same pending clause as the client one', () => {
    expect(bookingTabSql('requests').sql).toBe(bookingTabSql('pending').sql);
  });
});

describe('appBookingActions', () => {
  it('lets a client cancel or reschedule a pending booking, but never accept it', () => {
    const actions = appBookingActions('client', state({ status: BookingStatus.Pending }));
    expect(actions).toEqual(expect.arrayContaining(['cancel', 'reschedule', 'message']));
    expect(actions).not.toContain('accept');
    expect(actions).not.toContain('decline');
  });

  it('gives the provider Accept and Decline on a pending booking', () => {
    expect(appBookingActions('provider', state({ status: BookingStatus.Pending }))).toEqual(expect.arrayContaining(['accept', 'decline']));
  });

  it('offers the invoice only from acceptance on', () => {
    expect(appBookingActions('client', state({ status: BookingStatus.Pending }))).not.toContain('invoice');
    expect(appBookingActions('client', state())).toContain('invoice');
    expect(appBookingActions('client', state({ status: BookingStatus.Completed }))).toContain('invoice');
  });

  it('offers "All good" only after the event and only once', () => {
    expect(appBookingActions('client', state({ eventDate: '2026-12-01' }))).not.toContain('check_in');
    expect(appBookingActions('client', state({ eventDate: TODAY }))).toContain('check_in');
    expect(appBookingActions('client', state({ eventDate: TODAY, checkedIn: true }))).not.toContain('check_in');
  });

  it('hides "All good" while a dispute is open', () => {
    expect(appBookingActions('client', state({ eventDate: TODAY, disputeStatus: BookingDisputeStatus.Open }))).not.toContain('check_in');
  });

  it('only the provider completes, and only after the event', () => {
    expect(appBookingActions('provider', state({ eventDate: TODAY }))).toContain('complete');
    expect(appBookingActions('provider', state({ eventDate: '2026-12-01' }))).not.toContain('complete');
    expect(appBookingActions('client', state({ eventDate: TODAY }))).not.toContain('complete');
  });

  it('offers a review to the client of a completed booking inside the window, once', () => {
    const completed = state({ status: BookingStatus.Completed, reviewWindowOpen: true });
    expect(appBookingActions('client', completed)).toContain('review');
    expect(appBookingActions('provider', completed)).not.toContain('review');
    expect(appBookingActions('client', { ...completed, hasReview: true })).not.toContain('review');
    expect(appBookingActions('client', { ...completed, reviewWindowOpen: false })).not.toContain('review');
    expect(appBookingActions('client', { ...completed, disputeStatus: BookingDisputeStatus.Open })).not.toContain('review');
  });

  it('offers a dispute only while the window is open and none is already running', () => {
    expect(appBookingActions('client', state({ disputeWindowOpen: true }))).toContain('dispute');
    expect(appBookingActions('client', state({ disputeWindowOpen: true, disputeStatus: BookingDisputeStatus.Open }))).not.toContain('dispute');
  });

  it('offers to answer a reschedule only when it is my turn', () => {
    expect(appBookingActions('client', state({ pendingRescheduleForMe: true }))).toContain('respond_reschedule');
    expect(appBookingActions('client', state())).not.toContain('respond_reschedule');
  });

  it('never repeats an action and always allows messaging', () => {
    const actions = appBookingActions('provider', state({ eventDate: TODAY, disputeWindowOpen: true, pendingRescheduleForMe: true }));
    expect(new Set(actions).size).toBe(actions.length);
    expect(actions).toContain('message');
  });

  it('leaves a cancelled booking with nothing but the chat', () => {
    expect(appBookingActions('client', state({ status: BookingStatus.Cancelled }))).toEqual(['message']);
  });
});

describe('checkInOutcome', () => {
  const base = { status: BookingStatus.Accepted, disputeStatus: BookingDisputeStatus.None, eventDate: '2026-11-19', today: TODAY, otherCheckedIn: false };

  it('records the first tap and completes on the second', () => {
    expect(checkInOutcome(base)).toBe('recorded');
    expect(checkInOutcome({ ...base, otherCheckedIn: true })).toBe('complete');
  });

  it('refuses before the event', () => {
    expect(checkInOutcome({ ...base, eventDate: '2026-11-21' })).toBe('refused_too_early');
  });

  it('accepts on the day of the event', () => {
    expect(checkInOutcome({ ...base, eventDate: TODAY })).toBe('recorded');
  });

  it('refuses on a booking that is not accepted', () => {
    expect(checkInOutcome({ ...base, status: BookingStatus.Pending })).toBe('refused_status');
    expect(checkInOutcome({ ...base, status: BookingStatus.Completed })).toBe('refused_status');
  });

  it('refuses while a dispute is open', () => {
    expect(checkInOutcome({ ...base, disputeStatus: BookingDisputeStatus.Open })).toBe('refused_dispute');
  });

  it('maps each refusal to its own error code', () => {
    expect((checkInRefusal('refused_status') as AppException).code).toBe('CHECK_IN_NOT_ALLOWED');
    expect((checkInRefusal('refused_dispute') as AppException).code).toBe('CHECK_IN_DISPUTED');
    expect((checkInRefusal('refused_too_early') as AppException).code).toBe('CHECK_IN_TOO_EARLY');
    expect(checkInRefusal('recorded')).toBeNull();
    expect(checkInRefusal('complete')).toBeNull();
  });
});

describe('reviewWindow', () => {
  const completedAt = new Date('2026-11-01T10:00:00Z');

  it('has no window at all before the booking completes', () => {
    expect(reviewWindow(null, 24)).toEqual({ open: false, opensAt: null, closesAt: null });
  });

  it('opens `review_open_after_hours` after the completion', () => {
    expect(reviewWindow(completedAt, 24, new Date('2026-11-02T09:59:00Z')).open).toBe(false);
    expect(reviewWindow(completedAt, 24, new Date('2026-11-02T10:00:01Z')).open).toBe(true);
  });

  it(`closes ${REVIEW_WINDOW_DAYS} days after the completion`, () => {
    const closesAt = new Date(completedAt.getTime() + REVIEW_WINDOW_DAYS * 86_400_000);
    expect(reviewWindow(completedAt, 24, new Date(closesAt.getTime() - 1000)).open).toBe(true);
    expect(reviewWindow(completedAt, 24, new Date(closesAt.getTime() + 1000)).open).toBe(false);
  });

  it('reports both bounds as ISO timestamps', () => {
    const window = reviewWindow(completedAt, 24);
    expect(window.opensAt).toBe('2026-11-02T10:00:00.000Z');
    expect(window.closesAt).toMatch(/^2026-12-31T10:00:00/);
  });
});

describe('withinEditWindow', () => {
  const created = new Date('2026-11-01T10:00:00Z');

  it(`lasts exactly ${EDIT_WINDOW_HOURS} hours`, () => {
    expect(withinEditWindow(created, new Date(created.getTime() + EDIT_WINDOW_HOURS * 3_600_000))).toBe(true);
    expect(withinEditWindow(created, new Date(created.getTime() + EDIT_WINDOW_HOURS * 3_600_000 + 1))).toBe(false);
  });
});

describe('assertOwner', () => {
  it('passes for the owner and refuses everybody else with NOT_OWNER', () => {
    expect(() => assertOwner('u1', 'u1')).not.toThrow();
    expect(() => assertOwner('u2', 'u1')).toThrow(expect.objectContaining({ code: 'NOT_OWNER' }));
    expect(() => assertOwner(null, 'u1')).toThrow(expect.objectContaining({ code: 'NOT_OWNER' }));
  });
});
