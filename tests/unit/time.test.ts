import { describe, expect, it } from 'vitest';
import { localDatePlus, nightDate, parseClock, parseWhen, toLocalParts, tzOffsetMinutes, zonedToUtc } from '../../src/lib/time.js';

describe('time helpers (America/New_York)', () => {
  it('converts offset-less RA local times to UTC across DST', () => {
    // EDT (UTC-4): 2026-09-13 15:00 New York = 19:00Z
    expect(zonedToUtc('2026-09-13T15:00:00.000')?.toISOString()).toBe('2026-09-13T19:00:00.000Z');
    // EST (UTC-5): 2026-12-05 23:00 New York = 04:00Z next day
    expect(zonedToUtc('2026-12-05T23:00:00')?.toISOString()).toBe('2026-12-06T04:00:00.000Z');
    // date only -> local midnight
    expect(zonedToUtc('2026-09-13')?.toISOString()).toBe('2026-09-13T04:00:00.000Z');
    expect(zonedToUtc('garbage')).toBeNull();
  });
  it('reports the correct UTC offset', () => {
    expect(tzOffsetMinutes(Date.UTC(2026, 6, 1))).toBe(-240);
    expect(tzOffsetMinutes(Date.UTC(2026, 0, 15))).toBe(-300);
  });
  it('parseWhen accepts ISO with offset and offset-less strings', () => {
    expect(parseWhen('2026-09-26T03:00:00Z')?.toISOString()).toBe('2026-09-26T03:00:00.000Z');
    expect(parseWhen('2026-08-29T15:00:00-04:00')?.toISOString()).toBe('2026-08-29T19:00:00.000Z');
    expect(parseWhen('2026-09-13T22:00:00')?.toISOString()).toBe('2026-09-14T02:00:00.000Z');
    expect(parseWhen(null)).toBeNull();
  });
  it('nightDate assigns pre-06:00 starts to the previous night', () => {
    // Sunday 01:30 New York (= 05:30Z) is Saturday night
    expect(nightDate(new Date('2026-09-13T05:30:00Z'))).toBe('2026-09-12');
    // 15:00 Sunday stays Sunday
    expect(nightDate(new Date('2026-09-13T19:00:00Z'))).toBe('2026-09-13');
    // 06:00 exactly is the new day
    expect(nightDate(new Date('2026-09-13T10:00:00Z'))).toBe('2026-09-13');
  });
  it('toLocalParts gives weekday and HH:mm', () => {
    const p = toLocalParts(new Date('2026-09-13T19:00:00Z'));
    expect(p).toMatchObject({ date: '2026-09-13', time: '15:00', weekday: 0, hour: 15 });
  });
  it('localDatePlus walks calendar days', () => {
    const now = new Date('2026-09-13T03:00:00Z'); // Sat 23:00 New York
    expect(localDatePlus(0, undefined, now)).toBe('2026-09-12');
    expect(localDatePlus(1, undefined, now)).toBe('2026-09-13');
    expect(localDatePlus(30, undefined, now)).toBe('2026-10-12');
  });
  it('parseClock handles 12h and 24h', () => {
    expect(parseClock('11:00 PM')).toEqual({ hour: 23, minute: 0 });
    expect(parseClock('3:00 pm')).toEqual({ hour: 15, minute: 0 });
    expect(parseClock('12:30 am')).toEqual({ hour: 0, minute: 30 });
    expect(parseClock('22:15')).toEqual({ hour: 22, minute: 15 });
    expect(parseClock('doors')).toBeNull();
  });
});

describe('nextMonthDay', () => {
  it('picks the next occurrence on/after fromDate-1', async () => {
    const { nextMonthDay } = await import('../../src/lib/time.js');
    expect(nextMonthDay(9, 18, '2026-09-13')).toBe('2026-09-18');
    expect(nextMonthDay(9, 12, '2026-09-13')).toBe('2026-09-12'); // yesterday still counts (late-night rows)
    expect(nextMonthDay(9, 11, '2026-09-13')).toBe('2026-09-11'); // two days ago: stays in the past, caller drops it
    expect(nextMonthDay(12, 31, '2027-01-02')).toBe('2026-12-31');
    expect(nextMonthDay(1, 3, '2026-12-30')).toBe('2027-01-03');
  });
});
