import { AppException } from '../common/errors/app.exception.js';
import { algiersDay, buildDailyRows, dayBoundsUtc, daysBetween, deltaPercent, resolveRange, totals } from './stats.policy.js';

describe('Algiers days', () => {
  it('maps instants to the Africa/Algiers day (UTC+1)', () => {
    expect(algiersDay(new Date('2026-09-15T22:59:59Z'))).toBe('2026-09-15');
    expect(algiersDay(new Date('2026-09-15T23:00:00Z'))).toBe('2026-09-16');
  });

  it('gives UTC bounds and day lists', () => {
    expect(dayBoundsUtc('2026-09-01', '2026-09-02')).toEqual({ start: new Date('2026-08-31T23:00:00Z'), end: new Date('2026-09-02T23:00:00Z') });
    expect(daysBetween('2026-02-27', '2026-03-02')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  });
});

describe('buildDailyRows (stats rollup)', () => {
  it('fills zeros for every day and role, keeps avg_rating only on days with reviews', () => {
    const rows = buildDailyRows(
      ['2026-09-14', '2026-09-15'],
      [
        { day: '2026-09-15', metric: 'bookings_created', value: 3 },
        { day: new Date('2026-09-15T00:00:00Z'), metric: 'booking_value', value: '120000.5' },
        { day: '2026-09-15', metric: 'users_new', dimension: 'provider', value: 1 },
        { day: '2026-09-15', metric: 'reviews_new', value: 2 },
        { day: '2026-09-15', metric: 'avg_rating', value: '4.5000' },
        { day: '2026-09-14', metric: 'avg_rating', value: 5 },
      ],
    );
    const on = (day: string) => Object.fromEntries(rows.filter((r) => r.day === day).map((r) => [`${r.metric}${r.dimension ? `:${r.dimension}` : ''}`, r.value]));
    expect(on('2026-09-14')).toEqual({ bookings_created: '0.00', bookings_completed: '0.00', booking_value: '0.00', 'users_new:client': '0.00', 'users_new:provider': '0.00', reviews_new: '0.00' });
    expect(on('2026-09-15')).toEqual({
      bookings_created: '3.00',
      bookings_completed: '0.00',
      booking_value: '120000.50',
      'users_new:client': '0.00',
      'users_new:provider': '1.00',
      reviews_new: '2.00',
      avg_rating: '4.50',
    });
  });

  it('sums a period with a review-weighted average rating', () => {
    const rows = buildDailyRows(
      ['2026-09-14', '2026-09-15'],
      [
        { day: '2026-09-14', metric: 'bookings_created', value: 2 },
        { day: '2026-09-15', metric: 'bookings_created', value: 3 },
        { day: '2026-09-14', metric: 'users_new', dimension: 'client', value: 4 },
        { day: '2026-09-15', metric: 'users_new', dimension: 'provider', value: 1 },
        { day: '2026-09-14', metric: 'reviews_new', value: 1 },
        { day: '2026-09-14', metric: 'avg_rating', value: 2 },
        { day: '2026-09-15', metric: 'reviews_new', value: 3 },
        { day: '2026-09-15', metric: 'avg_rating', value: 5 },
        { day: '2026-09-15', metric: 'booking_value', value: 45000 },
      ],
    );
    expect(totals(rows)).toEqual({ bookingsCreated: 5, bookingsCompleted: 0, bookingValue: 45000, usersNew: 5, reviewsNew: 4, avgRating: 4.25 });
    expect(totals([]).avgRating).toBeNull();
  });

  it('computes deltas', () => {
    expect(deltaPercent(12, 10)).toBe(20);
    expect(deltaPercent(5, 0)).toBeNull();
    expect(deltaPercent(null, 3)).toBeNull();
  });
});

describe('resolveRange', () => {
  const now = new Date('2026-09-16T10:00:00Z');

  it('today, 7d, 30d', () => {
    expect(resolveRange('today', undefined, undefined, now)).toMatchObject({ current: { from: '2026-09-16', to: '2026-09-16' }, previous: { from: '2026-09-15', to: '2026-09-15' } });
    expect(resolveRange('7d', undefined, undefined, now)).toMatchObject({ current: { from: '2026-09-10', to: '2026-09-16' }, previous: { from: '2026-09-03', to: '2026-09-09' } });
    expect(resolveRange('30d', undefined, undefined, now)).toMatchObject({ current: { from: '2026-08-18', to: '2026-09-16' }, previous: { from: '2026-07-19', to: '2026-08-17' } });
  });

  it('this_month compares with the same days of the previous month', () => {
    expect(resolveRange('this_month', undefined, undefined, new Date('2026-03-31T12:00:00Z'))).toMatchObject({ current: { from: '2026-03-01', to: '2026-03-31' }, previous: { from: '2026-02-01', to: '2026-02-28' } });
    expect(resolveRange('this_month', undefined, undefined, new Date('2026-01-05T12:00:00Z'))).toMatchObject({ previous: { from: '2025-12-01', to: '2025-12-05' } });
  });

  it('custom needs from <= to within 366 days', () => {
    expect(resolveRange('custom', '2026-09-01', '2026-09-10', now)).toMatchObject({ current: { from: '2026-09-01', to: '2026-09-10' }, previous: { from: '2026-08-22', to: '2026-08-31' } });
    expect(() => resolveRange('custom', '2026-09-10', '2026-09-01', now)).toThrow(AppException);
    expect(() => resolveRange('custom', undefined, '2026-09-01', now)).toThrow(AppException);
    expect(() => resolveRange('custom', '2024-01-01', '2026-09-01', now)).toThrow(AppException);
  });
});
