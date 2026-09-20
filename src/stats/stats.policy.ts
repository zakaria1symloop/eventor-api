import { addDays } from '../bookings/bookings.policy.js';
import { AppException } from '../common/errors/app.exception.js';

/**
 * `stats_daily` metrics (db-schema §11), one row per Africa/Algiers day
 * (UTC+1, no DST). `users_new` has one row per role (dimension `client` /
 * `provider`); the others use the empty dimension.
 */
export const STATS_METRICS = ['bookings_created', 'bookings_completed', 'booking_value', 'users_new', 'reviews_new', 'avg_rating'] as const;
export type StatsMetric = (typeof STATS_METRICS)[number];

export const USER_ROLES_TRACKED = ['client', 'provider'] as const;

/** Algiers is UTC+1 all year. */
export const ALGIERS_OFFSET_HOURS = 1;

/** The Africa/Algiers calendar day of an instant, `YYYY-MM-DD`. */
export function algiersDay(instant: Date): string {
  return new Date(instant.getTime() + ALGIERS_OFFSET_HOURS * 3_600_000).toISOString().slice(0, 10);
}

/** UTC bounds `[start, end)` of Algiers days `from`..`to` inclusive. */
export function dayBoundsUtc(from: string, to: string): { start: Date; end: Date } {
  return {
    start: new Date(`${from}T00:00:00+01:00`),
    end: new Date(`${addDays(to, 1)}T00:00:00+01:00`),
  };
}

/** Every day from `from` to `to` inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

export interface RawMetricRow {
  day: string | Date;
  metric: StatsMetric;
  dimension?: string | null;
  value: number | string | null;
}

export interface StatsRow {
  day: string;
  metric: StatsMetric;
  dimension: string;
  value: string;
}

const toDay = (value: string | Date): string => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

/**
 * The `stats_daily` rows for a set of days from grouped query results: counts
 * and value default to 0 for every day (and every tracked role for
 * `users_new`), `avg_rating` only exists on days with reviews. Values have 2 decimals.
 */
export function buildDailyRows(days: readonly string[], raw: readonly RawMetricRow[]): StatsRow[] {
  const found = new Map<string, number>();
  for (const r of raw) found.set(`${toDay(r.day)}|${r.metric}|${r.dimension ?? ''}`, Number(r.value ?? 0));
  const rows: StatsRow[] = [];
  const push = (day: string, metric: StatsMetric, dimension = '') => {
    const value = found.get(`${day}|${metric}|${dimension}`) ?? 0;
    rows.push({ day, metric, dimension, value: value.toFixed(2) });
  };
  for (const day of days) {
    push(day, 'bookings_created');
    push(day, 'bookings_completed');
    push(day, 'booking_value');
    for (const role of USER_ROLES_TRACKED) push(day, 'users_new', role);
    push(day, 'reviews_new');
    if (found.has(`${day}|avg_rating|`) && (found.get(`${day}|reviews_new|`) ?? 0) > 0) push(day, 'avg_rating');
  }
  return rows;
}

export interface PeriodTotals {
  bookingsCreated: number;
  bookingsCompleted: number;
  bookingValue: number;
  usersNew: number;
  reviewsNew: number;
  /** Weighted by the number of reviews per day; null without reviews. */
  avgRating: number | null;
}

/** Sums daily rows (from `stats_daily` or computed live) over a period. */
export function totals(rows: readonly StatsRow[]): PeriodTotals {
  const byDay = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const day = byDay.get(r.day) ?? new Map<string, number>();
    const key = `${r.metric}|${r.dimension}`;
    day.set(key, (day.get(key) ?? 0) + Number(r.value));
    byDay.set(r.day, day);
  }
  const out: PeriodTotals = { bookingsCreated: 0, bookingsCompleted: 0, bookingValue: 0, usersNew: 0, reviewsNew: 0, avgRating: null };
  let ratingWeighted = 0;
  for (const day of byDay.values()) {
    out.bookingsCreated += day.get('bookings_created|') ?? 0;
    out.bookingsCompleted += day.get('bookings_completed|') ?? 0;
    out.bookingValue += day.get('booking_value|') ?? 0;
    for (const role of USER_ROLES_TRACKED) out.usersNew += day.get(`users_new|${role}`) ?? 0;
    const reviews = day.get('reviews_new|') ?? 0;
    out.reviewsNew += reviews;
    if (reviews > 0) ratingWeighted += (day.get('avg_rating|') ?? 0) * reviews;
  }
  out.bookingValue = Math.round(out.bookingValue * 100) / 100;
  out.avgRating = out.reviewsNew > 0 ? Math.round((ratingWeighted / out.reviewsNew) * 100) / 100 : null;
  return out;
}

/** Percentage change, one decimal; null when there is no previous value to compare with. */
export function deltaPercent(value: number | null, previous: number | null): number | null {
  if (value === null || previous === null || previous === 0) return null;
  return Math.round(((value - previous) / previous) * 1000) / 10;
}

// ── overview ranges ─────────────────────────────────────────────

export const OVERVIEW_RANGES = ['today', '7d', '30d', 'this_month', 'custom'] as const;
export type OverviewRange = (typeof OVERVIEW_RANGES)[number];
export const MAX_RANGE_DAYS = 366;

export interface Period {
  from: string;
  to: string;
}

export interface ResolvedRange {
  range: OverviewRange;
  current: Period;
  /** The period compared with for `previousValue` / `deltaPercent`. */
  previous: Period;
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * Current and previous periods (Algiers days). today: today vs yesterday;
 * 7d / 30d: the last N days including today vs the N days before;
 * this_month: 1st → today vs the same days of the previous month (capped at
 * its length); custom: from → to vs the same number of days just before.
 */
export function resolveRange(range: OverviewRange, from: string | undefined, to: string | undefined, now = new Date()): ResolvedRange {
  const today = algiersDay(now);
  const span = (current: Period): Period => {
    const length = daysBetween(current.from, current.to).length;
    return { from: addDays(current.from, -length), to: addDays(current.from, -1) };
  };
  switch (range) {
    case 'today':
      return { range, current: { from: today, to: today }, previous: { from: addDays(today, -1), to: addDays(today, -1) } };
    case '7d':
    case '30d': {
      const n = range === '7d' ? 7 : 30;
      const current = { from: addDays(today, -(n - 1)), to: today };
      return { range, current, previous: span(current) };
    }
    case 'this_month': {
      const [y, m, d] = today.split('-').map(Number) as [number, number, number];
      const current = { from: `${today.slice(0, 7)}-01`, to: today };
      const prevYear = m === 1 ? y - 1 : y;
      const prevMonth = m === 1 ? 12 : m - 1;
      const prefix = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
      return { range, current, previous: { from: `${prefix}-01`, to: `${prefix}-${String(Math.min(d, daysInMonth(prevYear, prevMonth))).padStart(2, '0')}` } };
    }
    case 'custom': {
      if (!from || !to || from > to || daysBetween(from, to).length > MAX_RANGE_DAYS) throw AppException.of('OVERVIEW_RANGE_INVALID', { from: from ?? null, to: to ?? null });
      const current = { from, to };
      return { range, current, previous: span(current) };
    }
  }
}
