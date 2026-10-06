import { BookingDisputeStatus, BookingLineKind, BookingStatus } from '../common/enums/booking.enums.js';
import { PriceType } from '../common/enums/catalog.enums.js';
import {
  addDays,
  allowedTransitions,
  assertEventTimes,
  bookingDays,
  bookingRange,
  canTransition,
  lastDay,
  computeFee,
  computeLines,
  computeTotals,
  eventEndUtc,
  isDueForAutoComplete,
  isNoReply,
  packLines,
  reminderRetryAfter,
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

  it('adds days to a date', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
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
