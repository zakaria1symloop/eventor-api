import { timeSpan } from '../bookings/bookings.policy.js';
import { AppException } from '../common/errors/app.exception.js';

/**
 * When a service can be booked (issues 3 #6, #7, #8, #10): weekly hours, the
 * period of event dates, and how many clients may book overlapping hours.
 * Pure functions; BookingsService and the availability endpoints call them.
 *
 * Times are `HH:mm` (Africa/Algiers). An end at or before the start runs past
 * midnight; spans are minutes from midnight of the event date (`timeSpan`).
 */

/** ISO weekday: 1 = Monday … 7 = Sunday (Dart's `DateTime.weekday`). */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface HourRange {
  weekday: number;
  startTime: string;
  endTime: string;
}

export interface Span {
  start: number;
  end: number;
}

const hhmm = (minutes: number): string => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** Weekday of a `YYYY-MM-DD` date. */
export function weekdayOf(date: string): Weekday {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return (day === 0 ? 7 : day) as Weekday;
}

/** The ranges of one weekday as spans, in start order. */
export function dayRanges(hours: HourRange[], date: string): Span[] {
  const weekday = weekdayOf(date);
  return hours
    .filter((h) => h.weekday === weekday)
    .map((h) => timeSpan(h.startTime, h.endTime)!)
    .sort((a, b) => a.start - b.start);
}

/**
 * The hours a provider saves: start ≠ end, and ranges of the same weekday don't
 * overlap. 400 VALIDATION_FAILED (`hours`, codes `SAME_AS_START` / `OVERLAP`).
 */
export function assertValidHours(hours: HourRange[]): void {
  hours.forEach((h, index) => {
    if (h.startTime === h.endTime) {
      throw new AppException(400, 'VALIDATION_FAILED', [{ field: `hours.${index}.endTime`, code: 'SAME_AS_START', message: 'endTime must differ from startTime' }]);
    }
  });
  for (let weekday = 1; weekday <= 7; weekday++) {
    const spans = hours
      .map((h, index) => ({ index, h }))
      .filter(({ h }) => h.weekday === weekday)
      .map(({ index, h }) => ({ index, ...timeSpan(h.startTime, h.endTime)! }))
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) {
      if (spans[i]!.start < spans[i - 1]!.end) {
        throw new AppException(400, 'VALIDATION_FAILED', [
          { field: `hours.${spans[i]!.index}`, code: 'OVERLAP', message: 'Ranges of the same weekday must not overlap' },
        ]);
      }
    }
  }
}

/** `availableFrom` ≤ date ≤ `availableUntil`, either bound optional. */
export function inPeriod(date: string, from: string | null, until: string | null): boolean {
  return (!from || date >= from) && (!until || date <= until);
}

/** True when the booked span sits entirely inside one range of that weekday. No hours = any time. */
export function fitsHours(hours: HourRange[], date: string, booked: Span | null): boolean {
  if (hours.length === 0) return true;
  if (!booked) return false;
  return dayRanges(hours, date).some((range) => range.start <= booked.start && booked.end <= range.end);
}

/** How many of `others` overlap `span` (only timed bookings compare; whole-day ones count against the daily limit). */
export function overlapping(span: Span | null, others: (Span | null)[]): number {
  if (!span) return 0;
  return others.filter((o) => o !== null && o.start < span.end && span.start < o.end).length;
}

/**
 * The free time of one day: the service's hours that weekday (all day when it has
 * none) minus partial blocks and minus the moments already booked by
 * `capacity` clients. Returned as `HH:mm` pairs; an end at or before the start
 * runs past midnight. Empty = nothing free.
 */
export function freeRanges(input: { hours: HourRange[]; date: string; blocks: Span[]; booked: Span[]; capacity: number }): { startTime: string; endTime: string }[] {
  let free: Span[] = input.hours.length > 0 ? dayRanges(input.hours, input.date) : [{ start: 0, end: 1440 }];

  // Moments where `capacity` timed bookings already overlap.
  const edges = input.booked.flatMap((b) => [
    { at: b.start, delta: 1 },
    { at: b.end, delta: -1 },
  ]);
  edges.sort((a, b) => a.at - b.at || a.delta - b.delta);
  const full: Span[] = [];
  let open = 0;
  let fullSince: number | null = null;
  for (const edge of edges) {
    open += edge.delta;
    if (open >= Math.max(1, input.capacity) && fullSince === null) fullSince = edge.at;
    if (open < Math.max(1, input.capacity) && fullSince !== null) {
      if (edge.at > fullSince) full.push({ start: fullSince, end: edge.at });
      fullSince = null;
    }
  }

  for (const taken of [...input.blocks, ...full]) {
    free = free.flatMap((range) => {
      if (taken.end <= range.start || range.end <= taken.start) return [range];
      const parts: Span[] = [];
      if (taken.start > range.start) parts.push({ start: range.start, end: taken.start });
      if (taken.end < range.end) parts.push({ start: taken.end, end: range.end });
      return parts;
    });
  }
  return free.filter((r) => r.end > r.start).map((r) => ({ startTime: hhmm(r.start), endTime: hhmm(r.end) }));
}
