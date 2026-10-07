import { describe, expect, it } from 'vitest';
import { timeSpan } from '../bookings/bookings.policy.js';
import { assertValidHours, fitsHours, freeRanges, inPeriod, overlapping, weekdayOf, type HourRange } from './scheduling.policy.js';

// 2027-03-05 is a Friday, 2027-03-06 a Saturday, 2027-03-07 a Sunday.
const FRI = '2027-03-05';
const SAT = '2027-03-06';
const SUN = '2027-03-07';

const hours: HourRange[] = [
  { weekday: 5, startTime: '20:00', endTime: '00:00' },
  { weekday: 6, startTime: '10:00', endTime: '13:00' },
  { weekday: 6, startTime: '18:00', endTime: '02:00' },
];
const span = (start: string, end: string) => timeSpan(start, end);

describe('scheduling policy', () => {
  it('numbers weekdays from Monday = 1 to Sunday = 7', () => {
    expect([weekdayOf('2027-03-01'), weekdayOf(FRI), weekdayOf(SAT), weekdayOf(SUN)]).toEqual([1, 5, 6, 7]);
  });

  it('fits a booking inside one range of its weekday, overnight included', () => {
    expect(fitsHours(hours, FRI, span('20:00', '23:30'))).toBe(true);
    expect(fitsHours(hours, FRI, span('21:00', '00:00'))).toBe(true);
    expect(fitsHours(hours, FRI, span('19:00', '22:00'))).toBe(false);
    expect(fitsHours(hours, SAT, span('19:00', '01:30'))).toBe(true);
    // Across two ranges of the day is refused.
    expect(fitsHours(hours, SAT, span('11:00', '19:00'))).toBe(false);
    // A closed weekday, and a booking without times on a service with hours.
    expect(fitsHours(hours, SUN, span('10:00', '11:00'))).toBe(false);
    expect(fitsHours(hours, FRI, null)).toBe(false);
    // No hours at all: any time, or no time.
    expect(fitsHours([], SUN, span('03:00', '04:00'))).toBe(true);
    expect(fitsHours([], SUN, null)).toBe(true);
  });

  it('checks the period of event dates, with open bounds', () => {
    expect(inPeriod(FRI, '2027-03-01', '2027-03-31')).toBe(true);
    expect(inPeriod('2027-04-01', '2027-03-01', '2027-03-31')).toBe(false);
    expect(inPeriod('2027-02-28', '2027-03-01', null)).toBe(false);
    expect(inPeriod('2030-01-01', null, null)).toBe(true);
  });

  it('counts only timed bookings that overlap', () => {
    const others = [span('18:00', '20:00'), span('19:30', '23:00'), null, span('23:00', '01:00')];
    expect(overlapping(span('19:00', '21:00'), others)).toBe(2);
    expect(overlapping(span('20:00', '22:00'), others)).toBe(1);
    expect(overlapping(null, others)).toBe(0);
  });

  it('refuses equal times and overlapping ranges in the hours a provider saves', () => {
    expect(() => assertValidHours(hours)).not.toThrow();
    expect(() => assertValidHours([{ weekday: 1, startTime: '10:00', endTime: '10:00' }])).toThrow();
    expect(() =>
      assertValidHours([
        { weekday: 1, startTime: '10:00', endTime: '14:00' },
        { weekday: 1, startTime: '13:00', endTime: '18:00' },
      ]),
    ).toThrow();
    // The same hours on different weekdays are fine.
    expect(() =>
      assertValidHours([
        { weekday: 1, startTime: '10:00', endTime: '14:00' },
        { weekday: 2, startTime: '10:00', endTime: '14:00' },
      ]),
    ).not.toThrow();
  });

  it('lists the free time of a day: hours minus blocks minus moments already full', () => {
    // Saturday 10–13 and 18–02, a block 11–12, one client booked 19–21, capacity 1.
    expect(freeRanges({ hours, date: SAT, blocks: [span('11:00', '12:00')!], booked: [span('19:00', '21:00')!], capacity: 1 })).toEqual([
      { startTime: '10:00', endTime: '11:00' },
      { startTime: '12:00', endTime: '13:00' },
      { startTime: '18:00', endTime: '19:00' },
      { startTime: '21:00', endTime: '02:00' },
    ]);
    // Capacity 2: only the moment two bookings overlap (20–21) is full.
    expect(freeRanges({ hours: [], date: SUN, blocks: [], booked: [span('19:00', '21:00')!, span('20:00', '22:00')!], capacity: 2 })).toEqual([
      { startTime: '00:00', endTime: '20:00' },
      { startTime: '21:00', endTime: '00:00' },
    ]);
    // A closed weekday has nothing free.
    expect(freeRanges({ hours, date: SUN, blocks: [], booked: [], capacity: 1 })).toEqual([]);
    // No limit ("Allow several clients at the same time"): bookings never take a moment away.
    expect(freeRanges({ hours: [], date: SUN, blocks: [], booked: [span('19:00', '21:00')!, span('19:00', '21:00')!], capacity: null })).toEqual([
      { startTime: '00:00', endTime: '00:00' },
    ]);
  });
});
