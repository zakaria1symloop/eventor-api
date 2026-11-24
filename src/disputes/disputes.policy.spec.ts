import { BookingStatus } from '../common/enums/booking.enums.js';
import { DisputeBookingOutcome, DisputeStatus } from '../common/enums/moderation.enums.js';
import { allowedActions, disputeWindow, isDisputable, outcomeActions } from './disputes.policy.js';

describe('disputes policy', () => {
  describe('disputeWindow', () => {
    const accepted = { status: BookingStatus.Accepted, eventDate: '2026-09-20', startTime: '18:00:00', endTime: '23:00:00', cancelledAt: null };

    it('opens at the event start (Algiers) and closes at event end + window hours', () => {
      expect(disputeWindow(accepted, 72, new Date('2026-09-20T16:59:00Z')).open).toBe(false);
      expect(disputeWindow(accepted, 72, new Date('2026-09-20T17:00:00Z')).open).toBe(true);
      const w = disputeWindow(accepted, 72, new Date('2026-09-23T22:00:00Z'));
      expect(w.open).toBe(true);
      expect(w.closesAt?.toISOString()).toBe('2026-09-23T22:00:00.000Z');
      expect(disputeWindow(accepted, 72, new Date('2026-09-23T22:00:01Z')).open).toBe(false);
    });

    it('uses the start of the day and midnight after it without times (same end as cancel / reschedule, BUG-E6)', () => {
      const w = disputeWindow({ ...accepted, startTime: null, endTime: null }, 24, new Date('2026-09-19T23:00:00Z'));
      expect(w.open).toBe(true);
      expect(w.opensAt?.toISOString()).toBe('2026-09-19T23:00:00.000Z');
      expect(w.closesAt?.toISOString()).toBe('2026-09-21T23:00:00.000Z');
    });

    it('counts from the real end of an overnight or multi-day event', () => {
      // 20:00 → 02:00 ends on the 21st at 02:00 Algiers (01:00 UTC), not on the 20th.
      const overnight = disputeWindow({ ...accepted, startTime: '20:00:00', endTime: '02:00:00' }, 72, new Date('2026-09-20T20:00:00Z'));
      expect(overnight.closesAt?.toISOString()).toBe('2026-09-24T01:00:00.000Z');
      const threeDays = disputeWindow({ ...accepted, endDate: '2026-09-22' }, 72, new Date('2026-09-20T20:00:00Z'));
      expect(threeDays.closesAt?.toISOString()).toBe('2026-09-25T22:00:00.000Z');
    });

    it('allows a cancelled booking within 7 days of the cancellation', () => {
      const cancelled = { ...accepted, status: BookingStatus.Cancelled, cancelledAt: new Date('2026-09-01T10:00:00Z') };
      expect(disputeWindow(cancelled, 72, new Date('2026-09-08T10:00:00Z')).open).toBe(true);
      expect(disputeWindow(cancelled, 72, new Date('2026-09-08T10:00:01Z')).open).toBe(false);
      expect(disputeWindow({ ...cancelled, cancelledAt: null }, 72).open).toBe(false);
    });

    it('never opens for pending or declined bookings', () => {
      expect(isDisputable(BookingStatus.Pending)).toBe(false);
      expect(isDisputable(BookingStatus.Declined)).toBe(false);
      expect(disputeWindow({ ...accepted, status: BookingStatus.Pending }, 72, new Date('2026-09-21T00:00:00Z')).open).toBe(false);
    });
  });

  describe('outcomeActions', () => {
    it('maps outcomes to booking status actions', () => {
      expect(outcomeActions(DisputeBookingOutcome.Unchanged, BookingStatus.Accepted)).toEqual([]);
      expect(outcomeActions(DisputeBookingOutcome.Completed, BookingStatus.Accepted)).toEqual(['completed']);
      expect(outcomeActions(DisputeBookingOutcome.Completed, BookingStatus.Completed)).toEqual([]);
      expect(outcomeActions(DisputeBookingOutcome.Completed, BookingStatus.Cancelled)).toBeNull();
      expect(outcomeActions(DisputeBookingOutcome.Cancelled, BookingStatus.Accepted)).toEqual(['cancelled']);
      expect(outcomeActions(DisputeBookingOutcome.Cancelled, BookingStatus.Completed)).toEqual(['reopen', 'cancelled']);
      expect(outcomeActions(DisputeBookingOutcome.Cancelled, BookingStatus.Cancelled)).toEqual([]);
    });
  });

  it('lists the allowed actions per status', () => {
    expect(allowedActions(DisputeStatus.Open, true)).toEqual(['assign', 'message', 'request_evidence', 'add_evidence', 'resolve', 'close']);
    expect(allowedActions(DisputeStatus.Resolved, true)).toEqual(['message']);
    expect(allowedActions(DisputeStatus.Closed, false)).toEqual([]);
  });
});
