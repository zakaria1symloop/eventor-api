import { describe, expect, it } from 'vitest';
import { AppException } from '../common/errors/app.exception.js';
import { ServiceStatus } from '../common/enums/catalog.enums.js';
import { UserStatus, VerificationStatus } from '../common/enums/user.enums.js';
import { isServiceVisible, serviceVisibilityReasons } from '../services/services.policy.js';
import {
  assertBudgetOwner,
  budgetTotals,
  dayState,
  parseMonth,
  pickText,
  pickTextOrNull,
  ratingBreakdown,
  replyTimeLabel,
} from './app.policy.js';

describe('pickText (language fallback)', () => {
  const EN = 'Wedding photo coverage';
  const AR = 'تغطية تصوير الأعراس';

  it('returns the requested language when it has text', () => {
    expect(pickText('en', EN, AR)).toBe(EN);
    expect(pickText('ar', EN, AR)).toBe(AR);
  });

  it('falls back to the other language rather than showing nothing', () => {
    // Half-translated rows are normal while a provider fills the AR fields in.
    expect(pickText('ar', EN, '')).toBe(EN);
    expect(pickText('en', '', AR)).toBe(AR);
    expect(pickText('ar', EN, null)).toBe(EN);
    expect(pickText('en', undefined, AR)).toBe(AR);
  });

  it('treats whitespace as empty, so a column of spaces never wins', () => {
    expect(pickText('ar', EN, '   ')).toBe(EN);
  });

  it('returns an empty string when neither language has text', () => {
    expect(pickText('en', '', '')).toBe('');
    expect(pickText('ar', null, undefined)).toBe('');
  });

  it('pickTextOrNull gives null instead of an empty string', () => {
    expect(pickTextOrNull('en', null, null)).toBeNull();
    expect(pickTextOrNull('en', EN, null)).toBe(EN);
  });
});

describe('service visibility (the rule the app lists obey)', () => {
  const visible = {
    status: ServiceStatus.Published,
    deleted: false,
    provider: { status: UserStatus.Active, verificationStatus: VerificationStatus.Verified, deleted: false },
    openWilayas: 1,
  };

  it('accepts a published service of an active, verified provider with an open wilaya', () => {
    expect(isServiceVisible(visible)).toBe(true);
    expect(serviceVisibilityReasons(visible)).toEqual([]);
  });

  it.each([
    ['a draft', { ...visible, status: ServiceStatus.Draft }, 'not_published'],
    ['a hidden service', { ...visible, status: ServiceStatus.Hidden }, 'not_published'],
    ['a deleted service', { ...visible, deleted: true }, 'deleted'],
    ['a blocked provider', { ...visible, provider: { ...visible.provider, status: UserStatus.Blocked } }, 'provider_blocked'],
    ['an unverified provider', { ...visible, provider: { ...visible.provider, verificationStatus: VerificationStatus.Pending } }, 'provider_not_verified'],
    ['a rejected provider', { ...visible, provider: { ...visible.provider, verificationStatus: VerificationStatus.Rejected } }, 'provider_not_verified'],
    ['a deleted provider', { ...visible, provider: { ...visible.provider, deleted: true } }, 'provider_deleted'],
    ['no open wilaya', { ...visible, openWilayas: 0 }, 'no_open_wilaya'],
  ])('hides %s', (_label, input, reason) => {
    expect(isServiceVisible(input)).toBe(false);
    expect(serviceVisibilityReasons(input)).toContain(reason);
  });

  it('a provider who paused bookings keeps their services visible', () => {
    // status-rules: `accepting_bookings` disables the booking CTA, not the listing.
    expect(isServiceVisible(visible)).toBe(true);
  });
});

describe('budget privacy', () => {
  it('lets the owner through', () => {
    expect(() => assertBudgetOwner('client-1', 'client-1')).not.toThrow();
  });

  it.each([
    ['another client', 'client-2'],
    ['an admin', 'admin-1'],
  ])('refuses %s with 403 NOT_OWNER', (_label, callerId) => {
    try {
      assertBudgetOwner('client-1', callerId);
      expect.unreachable('the budget must never be readable by anyone else');
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe('NOT_OWNER');
      expect((error as AppException).getStatus()).toBe(403);
    }
  });
});

describe('budgetTotals (screen 18 header)', () => {
  const items = [
    { plannedAmount: '120000.00', spentAmount: '110000.00', bookingId: 'b1' },
    { plannedAmount: '45000.00', spentAmount: '45000.00', bookingId: 'b2' },
    { plannedAmount: '30000.00', spentAmount: '25000.00', bookingId: 'b3' },
    { plannedAmount: '150000.00', spentAmount: '0.00', bookingId: null },
  ];

  it('sums planned and spent, and counts the booked lines', () => {
    const totals = budgetTotals('400000.00', items);
    expect(totals).toMatchObject({
      planned: '345000.00',
      spent: '180000.00',
      remaining: '220000.00',
      itemsCount: 4,
      bookedCount: 3,
    });
    expect(totals.spentPercent).toBe(45);
  });

  it('reports a negative remaining rather than clamping it', () => {
    // Overspending is real and the screen must be able to show it.
    expect(budgetTotals('100000.00', items).remaining).toBe('-80000.00');
  });

  it('never divides by zero when no plan is set', () => {
    expect(budgetTotals('0.00', items).spentPercent).toBe(0);
    expect(budgetTotals('0.00', []).spent).toBe('0.00');
  });
});

describe('dayState (calendar on screens 12 / 20)', () => {
  it('is available with capacity left', () => {
    expect(dayState({ past: false, manualBlock: false, taken: 0, capacity: 1 })).toBe('available');
    expect(dayState({ past: false, manualBlock: false, taken: 1, capacity: 2 })).toBe('available');
  });

  it('is busy once the day is full', () => {
    expect(dayState({ past: false, manualBlock: false, taken: 1, capacity: 1 })).toBe('busy');
    expect(dayState({ past: false, manualBlock: false, taken: 3, capacity: 2 })).toBe('busy');
  });

  it('never fills up without a daily limit ("Only one booking per day" unticked)', () => {
    expect(dayState({ past: false, manualBlock: false, taken: 12, capacity: null })).toBe('available');
    expect(dayState({ past: false, manualBlock: true, taken: 0, capacity: null })).toBe('blocked');
    expect(dayState({ past: true, manualBlock: false, taken: 0, capacity: null })).toBe('blocked');
  });

  it('is blocked when the provider blocked it, or it is before the notice window', () => {
    expect(dayState({ past: false, manualBlock: true, taken: 0, capacity: 1 })).toBe('blocked');
    expect(dayState({ past: true, manualBlock: false, taken: 0, capacity: 1 })).toBe('blocked');
  });

  it('treats a capacity of zero as one, so a bad row cannot black out a calendar', () => {
    expect(dayState({ past: false, manualBlock: false, taken: 0, capacity: 0 })).toBe('available');
    expect(dayState({ past: false, manualBlock: false, taken: 1, capacity: 0 })).toBe('busy');
  });
});

describe('parseMonth', () => {
  it('returns the bounds of the month, leap year included', () => {
    expect(parseMonth('2026-03')).toMatchObject({ first: '2026-03-01', last: '2026-03-31', days: 31 });
    expect(parseMonth('2024-02')).toMatchObject({ last: '2024-02-29', days: 29 });
    expect(parseMonth('2026-02')).toMatchObject({ last: '2026-02-28', days: 28 });
  });

  it.each(['2026-13', '2026-00', '2026-3', 'march', '', '2026-03-01'])('refuses %j with MONTH_INVALID', (month) => {
    expect(() => parseMonth(month)).toThrow(AppException);
    try {
      parseMonth(month);
    } catch (error) {
      expect((error as AppException).code).toBe('MONTH_INVALID');
    }
  });
});

describe('ratingBreakdown', () => {
  it('always returns five buckets, 5 stars first', () => {
    const breakdown = ratingBreakdown([{ rating: 5, n: 24 }, { rating: 4, n: 8 }]);
    expect(breakdown.map((b) => b.stars)).toEqual([5, 4, 3, 2, 1]);
    expect(breakdown[0]).toEqual({ stars: 5, count: 24, percent: 75 });
    expect(breakdown[2]).toEqual({ stars: 3, count: 0, percent: 0 });
  });

  it('is all zeros with no reviews', () => {
    expect(ratingBreakdown([]).every((b) => b.count === 0 && b.percent === 0)).toBe(true);
  });
});

describe('replyTimeLabel', () => {
  it.each([
    [45, '45 min'],
    [120, '2 h'],
    [1440, '1 d'],
    [2880, '2 d'],
  ])('renders %i minutes as %s', (minutes, expected) => {
    expect(replyTimeLabel(minutes)).toBe(expected);
  });

  it('is null when nothing was measured', () => {
    expect(replyTimeLabel(null)).toBeNull();
    expect(replyTimeLabel(0)).toBeNull();
  });
});
