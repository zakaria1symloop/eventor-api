import { BookingDisputeStatus, BookingLineKind, BookingStatus, CancelledBy } from '../common/enums/booking.enums.js';
import { PriceType } from '../common/enums/catalog.enums.js';
import {
  addDays,
  allowedTransitions,
  assertEventTimes,
  bookingDays,
  bookingRange,
  canTransition,
  cancelledByOf,
  lastDay,
  computeFee,
  computeLines,
  computeTotals,
  eventEndUtc,
  eventEndsAt,
  eventStartUtc,
  EXPIRED_REASON,
  isDueForAutoComplete,
  isExpired,
  pendingExpiry,
  isNoReply,
  packLines,
  reminderRetryAfter,
  reasonLabel,
  rescheduledLines,
  serviceQuantity,
  STATUS_ACTIONS,
  targetStatus,
  timeSpan,
} from './bookings.policy.js';

describe('booking transitions', () => {
  const matrix: Record<BookingStatus, string[]> = {
    pending: ['accepted', 'declined', 'cancelled'],
    accepted: ['cancelled', 'completed'],
    completed: ['reopen'],
    declined: [],
    cancelled: [],
  };

  it.each(Object.entries(matrix))('from %s allows exactly %j', (from, allowed) => {
    for (const action of STATUS_ACTIONS) {
      expect(canTransition(from as BookingStatus, action)).toBe(allowed.includes(action));
    }
  });

  it('maps reopen to accepted', () => {
    expect(targetStatus('reopen')).toBe(BookingStatus.Accepted);
    expect(targetStatus('declined')).toBe(BookingStatus.Declined);
  });

  it('lists allowed transitions with reason and warnings', () => {
    expect(allowedTransitions({ status: BookingStatus.Pending, eventDate: '2026-12-01', disputeStatus: BookingDisputeStatus.None }, '2026-09-16')).toEqual([
      { action: 'accepted', to: 'accepted', reasonRequired: false, warning: null },
      { action: 'declined', to: 'declined', reasonRequired: true, warning: null },
      { action: 'cancelled', to: 'cancelled', reasonRequired: true, warning: null },
    ]);
    const accepted = allowedTransitions({ status: BookingStatus.Accepted, eventDate: '2026-12-01', disputeStatus: BookingDisputeStatus.None }, '2026-09-16');
    expect(accepted.find((t) => t.action === 'completed')!.warning).toBe('event_not_passed');
    const disputed = allowedTransitions({ status: BookingStatus.Accepted, eventDate: '2026-09-01', disputeStatus: BookingDisputeStatus.Open }, '2026-09-16');
    expect(disputed.find((t) => t.action === 'completed')!.warning).toBe('dispute_open');
  });
});

describe('totals and fees', () => {
  it('computes line amounts, discounts and adjustments in cents', () => {
    const lines = computeLines([
      { kind: BookingLineKind.Service, label: 'Wedding coverage', quantity: 1, unitAmount: '45000.00' },
      { kind: BookingLineKind.Extra, label: 'Drone', quantity: 2, unitAmount: '7500.50' },
      { kind: BookingLineKind.Discount, label: 'Loyalty', quantity: 1, unitAmount: '-3000' },
      { kind: BookingLineKind.Adjustment, label: 'Travel', quantity: 1, unitAmount: '-0.10' },
    ]);
    expect(lines.map((l) => l.amount)).toEqual(['45000.00', '15001.00', '-3000.00', '-0.10']);
    expect(lines[2]!.unitAmount).toBe('3000.00');
    expect(computeTotals(lines)).toEqual({ subtotal: '60001.00', discountTotal: '3000.10', total: '57000.90' });
  });

  it('computes the fee and the provider share', () => {
    expect(computeFee('45000.00', '10.00')).toEqual({ feeAmount: '4500.00', providerAmount: '40500.00' });
    expect(computeFee('333.33', 7.5)).toEqual({ feeAmount: '25.00', providerAmount: '308.33' });
    expect(computeFee('0.00', 10)).toEqual({ feeAmount: '0.00', providerAmount: '0.00' });
  });

  it('derives the service quantity from the price type', () => {
    expect(serviceQuantity(PriceType.PerEvent, { guests: 150 })).toBe(1);
    expect(serviceQuantity(PriceType.PerPerson, { guests: 150 })).toBe(150);
    expect(serviceQuantity(PriceType.PerPerson, {})).toBe(1);
    expect(serviceQuantity(PriceType.PerHour, { startTime: '18:00', endTime: '22:30' })).toBe(5);
    expect(serviceQuantity(PriceType.PerHour, { startTime: '22:00', endTime: '02:00' })).toBe(4);
    expect(serviceQuantity(PriceType.PerHour, { startTime: '20:00', endTime: '02:30' })).toBe(7);
    expect(serviceQuantity(PriceType.PerHour, { startTime: '18:00' })).toBe(1);
  });

  it('reads an end earlier than the start as the next day (#49)', () => {
    expect(timeSpan('18:00', '23:00')).toEqual({ start: 1080, end: 1380 });
    expect(timeSpan('18:00', '02:00')).toEqual({ start: 1080, end: 1560 });
    expect(timeSpan('18:00', null)).toBeNull();
    expect(timeSpan(null, '02:00')).toBeNull();
  });

  it('refuses an end without a start and an end equal to the start (#49)', () => {
    const code = (start: string | undefined, end: string | undefined) => {
      try {
        assertEventTimes(start, end);
        return null;
      } catch (error) {
        return (error as { details: { code: string }[] }).details[0]?.code;
      }
    };
    expect(code(undefined, '02:00')).toBe('REQUIRED_WITH_END');
    expect(code('18:00', '18:00')).toBe('SAME_AS_START');
    expect(code('18:00', '02:00')).toBeNull();
    expect(code('18:00', undefined)).toBeNull();
    expect(code(undefined, undefined)).toBeNull();
  });

  it('builds pack lines down to the pack price', () => {
    const lines = packLines({ price: '380000.00', nameEn: 'Essentiel' }, [
      { serviceId: 'a', titleEn: 'Hall', basePrice: '250000.00' },
      { serviceId: 'b', titleEn: 'Menu', basePrice: '175000.00' },
    ]);
    expect(lines.map((l) => [l.kind, l.unitAmount])).toEqual([
      ['pack_service', '250000.00'],
      ['pack_service', '175000.00'],
      ['discount', '45000.00'],
    ]);
    expect(computeTotals(computeLines(lines)).total).toBe('380000.00');
  });
});

describe('timing', () => {
  const now = new Date('2026-09-16T12:00:00Z');

  it('flags pending bookings past the reply deadline', () => {
    expect(isNoReply({ status: BookingStatus.Pending, createdAt: new Date('2026-09-14T11:00:00Z') }, 48, now)).toBe(true);
    expect(isNoReply({ status: BookingStatus.Pending, createdAt: new Date('2026-09-14T13:00:00Z') }, 48, now)).toBe(false);
    expect(isNoReply({ status: BookingStatus.Accepted, createdAt: new Date('2026-09-01T00:00:00Z') }, 48, now)).toBe(false);
  });

  it('throttles reminders to one per 12 hours', () => {
    expect(reminderRetryAfter(null, now)).toBe(0);
    expect(reminderRetryAfter(new Date('2026-09-16T02:00:00Z'), now)).toBe(7200);
    expect(reminderRetryAfter(new Date('2026-09-15T23:59:59Z'), now)).toBe(0);
  });

  it('auto-completes after the event end plus the dispute window, never with an open dispute', () => {
    const booking = { status: BookingStatus.Accepted, disputeStatus: BookingDisputeStatus.None, eventDate: '2026-09-12', endTime: '23:00:00' };
    expect(eventEndUtc('2026-09-12', '23:00:00').toISOString()).toBe('2026-09-12T22:00:00.000Z');
    expect(isDueForAutoComplete(booking, 72, new Date('2026-09-15T22:00:00Z'))).toBe(true);
    expect(isDueForAutoComplete(booking, 72, new Date('2026-09-15T21:59:00Z'))).toBe(false);
    expect(isDueForAutoComplete({ ...booking, disputeStatus: BookingDisputeStatus.Open }, 72, now)).toBe(false);
    expect(isDueForAutoComplete({ ...booking, disputeStatus: BookingDisputeStatus.Resolved }, 72, now)).toBe(true);
    expect(isDueForAutoComplete({ ...booking, status: BookingStatus.Pending }, 72, now)).toBe(false);
  });

  it('waits for the real end of an overnight or multi-day event before auto-completing', () => {
    const overnight = { status: BookingStatus.Accepted, disputeStatus: BookingDisputeStatus.None, eventDate: '2026-09-12', startTime: '20:00:00', endTime: '02:00:00' };
    // Ends 13 Sep 02:00 Algiers = 01:00 UTC; + 72 h = 16 Sep 01:00 UTC.
    expect(isDueForAutoComplete(overnight, 72, new Date('2026-09-16T00:59:00Z'))).toBe(false);
    expect(isDueForAutoComplete(overnight, 72, new Date('2026-09-16T01:00:00Z'))).toBe(true);
    const multiDay = { ...overnight, startTime: '10:00:00', endTime: '18:00:00', endDate: '2026-09-14' };
    expect(isDueForAutoComplete(multiDay, 72, new Date('2026-09-17T16:59:00Z'))).toBe(false);
    expect(isDueForAutoComplete(multiDay, 72, new Date('2026-09-17T17:00:00Z'))).toBe(true);
  });

  it('adds days to a date', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('rescheduledLines (BUG-E3: a per-hour price follows the new hours)', () => {
  const SERVICE = 'svc-1';
  const booked = [
    { kind: BookingLineKind.Service, label: 'DJ', quantity: 4, unitAmount: '6000.00', serviceId: SERVICE },
    { kind: BookingLineKind.Extra, label: 'Smoke machine', quantity: 2, unitAmount: '1500.00', serviceId: SERVICE },
    { kind: BookingLineKind.Discount, label: 'Loyalty', quantity: 1, unitAmount: '2000.00', serviceId: null },
  ];

  it('re-counts the hours of the per-hour service line at the agreed unit price, overnight included', () => {
    const lines = rescheduledLines(booked, { serviceId: SERVICE, priceType: PriceType.PerHour, startTime: '20:00', endTime: '01:00' })!;
    expect(lines[0]).toEqual({ ...booked[0], quantity: 5 });
    // Extras and discounts are kept as they are.
    expect(lines.slice(1)).toEqual(booked.slice(1));
    expect(computeTotals(computeLines(lines)).total).toBe('31000.00');
  });

  it('returns null when nothing changes: same length, or not priced per hour', () => {
    expect(rescheduledLines(booked, { serviceId: SERVICE, priceType: PriceType.PerHour, startTime: '10:00', endTime: '14:00' })).toBeNull();
    for (const priceType of [PriceType.PerEvent, PriceType.PerPerson, PriceType.PerDay]) {
      expect(rescheduledLines(booked, { serviceId: SERVICE, priceType, startTime: '18:00', endTime: '23:00' })).toBeNull();
    }
    // A pack (no service of its own) never changes.
    expect(rescheduledLines([{ kind: BookingLineKind.PackService, label: 'DJ', quantity: 1, unitAmount: '6000.00', serviceId: SERVICE }], { serviceId: null, priceType: null, startTime: '18:00', endTime: '23:00' })).toBeNull();
  });

  it('only touches the line of the booked service', () => {
    const other = [{ kind: BookingLineKind.Service, label: 'Other', quantity: 4, unitAmount: '6000.00', serviceId: 'svc-2' }];
    expect(rescheduledLines(other, { serviceId: SERVICE, priceType: PriceType.PerHour, startTime: '18:00', endTime: '23:00' })).toBeNull();
  });
});

describe('eventEndsAt (BUG-E6: when cancel and reschedule stop)', () => {
  const at = (b: Parameters<typeof eventEndsAt>[0]) => eventEndsAt(b).toISOString();

  it('is the end time of the event day, Africa/Algiers (UTC+1)', () => {
    expect(at({ eventDate: '2026-12-03', startTime: '18:00', endTime: '22:00' })).toBe('2026-12-03T21:00:00.000Z');
  });

  it('runs into the next day when the hours pass midnight', () => {
    expect(at({ eventDate: '2026-12-03', startTime: '20:00', endTime: '02:00' })).toBe('2026-12-04T01:00:00.000Z');
    // 00:00 → 00:00 is the whole day.
    expect(at({ eventDate: '2026-12-03', startTime: '00:00', endTime: '00:00' })).toBe('2026-12-03T23:00:00.000Z');
  });

  it('is the end of the last day of a multi-day booking', () => {
    expect(at({ eventDate: '2026-12-03', endDate: '2026-12-05', startTime: null, endTime: null })).toBe('2026-12-05T23:00:00.000Z');
    expect(at({ eventDate: '2026-12-03', endDate: '2026-12-05', startTime: '20:00', endTime: '01:00' })).toBe('2026-12-06T00:00:00.000Z');
  });

  it('is midnight after the event day when there are no hours', () => {
    expect(at({ eventDate: '2026-12-03', startTime: null, endTime: null })).toBe('2026-12-03T23:00:00.000Z');
    expect(at({ eventDate: '2026-12-03', startTime: null, endTime: '17:30:00' })).toBe('2026-12-03T16:30:00.000Z');
  });
});

describe('request expiry (BUG-F1)', () => {
  const pending = (createdAt: string, eventDate: string, startTime: string | null = null) => ({ status: BookingStatus.Pending, createdAt: new Date(createdAt), eventDate, startTime });

  it('starts an event at its start time, or at the start of the day, in Algiers time', () => {
    expect(eventStartUtc('2026-12-03', '18:00:00').toISOString()).toBe('2026-12-03T17:00:00.000Z');
    expect(eventStartUtc('2026-12-03', null).toISOString()).toBe('2026-12-02T23:00:00.000Z');
  });

  it('expires at the reply deadline when the event is further away', () => {
    const booking = pending('2026-11-20T10:00:00Z', '2026-12-20', '18:00');
    expect(pendingExpiry(booking, 48)).toEqual({ at: new Date('2026-11-22T10:00:00Z'), cause: 'reply_deadline' });
    expect(isExpired(booking, 48, new Date('2026-11-22T09:59:59Z'))).toBe(false);
    expect(isExpired(booking, 48, new Date('2026-11-22T10:00:00Z'))).toBe(true);
  });

  it('expires at the event start when it comes before the deadline (EVT-000003: event over, still pending)', () => {
    const booking = pending('2026-11-21T10:00:00Z', '2026-11-22', '12:00');
    expect(pendingExpiry(booking, 48)).toEqual({ at: new Date('2026-11-22T11:00:00Z'), cause: 'event_started' });
    expect(isExpired(booking, 48, new Date('2026-11-22T10:59:00Z'))).toBe(false);
    expect(isExpired(booking, 48, new Date('2026-11-22T11:00:00Z'))).toBe(true);
    // A whole-day event starts at midnight.
    expect(pendingExpiry(pending('2026-11-21T10:00:00Z', '2026-11-22'), 48)!.at.toISOString()).toBe('2026-11-21T23:00:00.000Z');
  });

  it('never expires anything but a pending request', () => {
    for (const status of [BookingStatus.Accepted, BookingStatus.Completed, BookingStatus.Declined, BookingStatus.Cancelled]) {
      const booking = { ...pending('2020-01-01T00:00:00Z', '2020-01-02'), status };
      expect(pendingExpiry(booking, 48)).toBeNull();
      expect(isExpired(booking, 48)).toBe(false);
    }
  });

  it('uses the decline reason code `expired`', () => {
    expect(EXPIRED_REASON).toBe('expired');
  });
});

describe('multi-day bookings (issues 3 #11)', () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
      return null;
    } catch (error) {
      const e = error as { getResponse(): { code: string; details: unknown } };
      return e.getResponse().code;
    }
  };

  it('lists every day of a range, across a month end', () => {
    expect(bookingDays('2027-01-30', '2027-02-02')).toEqual(['2027-01-30', '2027-01-31', '2027-02-01', '2027-02-02']);
    expect(bookingDays('2027-01-30', null)).toEqual(['2027-01-30']);
    expect(lastDay({ eventDate: '2027-01-30', endDate: '2027-02-02' })).toBe('2027-02-02');
    expect(lastDay({ eventDate: '2027-01-30' })).toBe('2027-01-30');
  });

  it('allows a range for per-day services only, up to 30 days, never backwards', () => {
    const perDay = { isPack: false, priceType: PriceType.PerDay };
    expect(bookingRange({ eventDate: '2027-03-01', endDate: '2027-03-03', ...perDay })).toEqual({ endDate: '2027-03-03', days: ['2027-03-01', '2027-03-02', '2027-03-03'] });
    // The same day twice is one day.
    expect(bookingRange({ eventDate: '2027-03-01', endDate: '2027-03-01', ...perDay })).toEqual({ endDate: null, days: ['2027-03-01'] });
    expect(bookingRange({ eventDate: '2027-03-01', endDate: '2027-03-30', ...perDay }).days).toHaveLength(30);
    expect(code(() => bookingRange({ eventDate: '2027-03-01', endDate: '2027-03-31', ...perDay }))).toBe('BOOKING_TOO_LONG');
    expect(code(() => bookingRange({ eventDate: '2027-03-05', endDate: '2027-03-01', ...perDay }))).toBe('VALIDATION_FAILED');
    expect(code(() => bookingRange({ eventDate: '2027-03-01', endDate: '2027-03-02', isPack: false, priceType: PriceType.PerEvent }))).toBe('MULTI_DAY_NOT_ALLOWED');
    expect(code(() => bookingRange({ eventDate: '2027-03-01', endDate: '2027-03-02', isPack: true, priceType: null }))).toBe('MULTI_DAY_NOT_ALLOWED');
  });

  it('prices a per-day service per day', () => {
    expect(serviceQuantity(PriceType.PerDay, { days: 3 })).toBe(3);
    expect(serviceQuantity(PriceType.PerDay, {})).toBe(1);
    expect(serviceQuantity(PriceType.PerEvent, { days: 3 })).toBe(1);
  });
});

describe('who cancelled, and reason labels (BUG-H4 / BUG-M3)', () => {
  const booking = { clientId: 'client-1', providerId: 'provider-1' };

  it('attributes a cancellation to the party who did it, Eventor otherwise, and the system without a person', () => {
    expect(cancelledByOf(booking, 'client-1')).toBe(CancelledBy.Client);
    expect(cancelledByOf(booking, 'provider-1')).toBe(CancelledBy.Provider);
    expect(cancelledByOf(booking, 'admin-9')).toBe(CancelledBy.Admin);
    expect(cancelledByOf(booking, null)).toBe(CancelledBy.System);
  });

  it('translates known codes, keeps typed words, and never returns a raw code', () => {
    expect(reasonLabel('account_blocked', 'en')).toBe('The account was suspended by Eventor');
    expect(reasonLabel('dispute', 'ar')).toBe('تقرر في نزاع');
    expect(reasonLabel('The venue changed our date.', 'ar')).toBe('The venue changed our date.');
    expect(reasonLabel('venue_closed', 'en')).toBe('Venue closed');
    expect(reasonLabel(null, 'en')).toBeNull();
  });
});
