/**
 * Time helpers. Everything NOCT stores is UTC (timestamptz); everything NOCT reasons about
 * ("tonight", "day party", "afters") is New York local time. No date library — Intl is enough.
 */

export const NY_TZ = 'America/New_York';

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm */
  time: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Break a UTC instant into wall-clock parts for a time zone. */
export function toLocalParts(d: Date, tz: string = NY_TZ): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of dtf(tz).formatToParts(d)) if (p.type !== 'literal') parts[p.type] = p.value;
  const year = Number(parts.year), month = Number(parts.month), day = Number(parts.day);
  const hour = Number(parts.hour) % 24, minute = Number(parts.minute), second = Number(parts.second);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    year, month, day, hour, minute, second,
    weekday: WEEKDAYS.indexOf(parts.weekday ?? 'Sun'),
    date: `${year}-${pad(month)}-${pad(day)}`,
    time: `${pad(hour)}:${pad(minute)}`,
  };
}

/** Offset (minutes east of UTC) of `tz` at the given instant. New York is -300 or -240. */
export function tzOffsetMinutes(atUtcMs: number, tz: string = NY_TZ): number {
  const p = toLocalParts(new Date(atUtcMs), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - atUtcMs) / 60_000);
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

/**
 * Interpret a wall-clock string WITHOUT an offset ("2026-09-13T15:00:00.000", as RA returns) as `tz` local time.
 * Returns null for unparsable input. Strings that already carry an offset/Z should go through `new Date()` instead.
 */
export function zonedToUtc(local: string, tz: string = NY_TZ): Date | null {
  const m = LOCAL_RE.exec(local.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const h = Number(m[4] ?? '0'), mi = Number(m[5] ?? '0'), s = Number(m[6] ?? '0');
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let utc = guess - tzOffsetMinutes(guess, tz) * 60_000;
  // DST edge: re-evaluate the offset at the corrected instant
  const off2 = tzOffsetMinutes(utc, tz);
  const utc2 = guess - off2 * 60_000;
  if (utc2 !== utc) utc = utc2;
  return new Date(utc);
}

/** Parse anything an adapter may hand us: ISO with offset/Z -> Date; offset-less -> tz local; else null. */
export function parseWhen(value: string | null | undefined, tz: string = NY_TZ): Date | null {
  if (!value) return null;
  const v = value.trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return zonedToUtc(v, tz);
}

/**
 * "Nightlife date": anything before 06:00 local belongs to the previous calendar night, so a 1am show
 * on Sunday morning is a Saturday-night event. Mirrors night_date() in SQL.
 */
export function nightDate(d: Date, tz: string = NY_TZ): string {
  return toLocalParts(new Date(d.getTime() - 6 * 3_600_000), tz).date;
}

/** Local calendar date (YYYY-MM-DD) for an instant. */
export function localDate(d: Date, tz: string = NY_TZ): string {
  return toLocalParts(d, tz).date;
}

/** Midnight (00:00 local) of a YYYY-MM-DD in `tz`, as a UTC Date. */
export function localMidnight(date: string, tz: string = NY_TZ): Date {
  return zonedToUtc(`${date}T00:00:00`, tz) as Date;
}

/** YYYY-MM-DD for today in `tz`, plus N days. */
export function localDatePlus(days: number, tz: string = NY_TZ, now: Date = new Date()): string {
  const base = localMidnight(localDate(now, tz), tz);
  return localDate(new Date(base.getTime() + days * 86_400_000 + 12 * 3_600_000), tz);
}

export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** Parse "11:00 PM" / "3:00 pm" / "23:00" into {hour, minute}; null when unparsable. */
export function parseClock(text: string): { hour: number; minute: number } | null {
  const m = /(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(text.trim());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase().replace(/\./g, '');
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Venue calendars print "9/18" or "Sun 9.13" with no year. Pick the occurrence nearest to fromDate:
 * the first one on/after (fromDate - 1 day), unless that is more than ~300 days out — then it is really a
 * date that just passed (e.g. "12/31" scraped on Jan 2), and we return the past one so the caller drops it
 * instead of ingesting a phantom event a year ahead. Returns YYYY-MM-DD.
 */
export function nextMonthDay(month: number, day: number, fromDate: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const fromYear = Number(fromDate.slice(0, 4));
  const floorMs = Date.UTC(fromYear, Number(fromDate.slice(5, 7)) - 1, Number(fromDate.slice(8, 10)) - 1);
  const floor = new Date(floorMs).toISOString().slice(0, 10);
  const years = [fromYear - 1, fromYear, fromYear + 1];
  for (let i = 0; i < years.length; i++) {
    const year = years[i] as number;
    const candidate = `${year}-${pad(month)}-${pad(day)}`;
    if (candidate < floor) continue;
    const daysOut = (Date.UTC(year, month - 1, day) - floorMs) / 86_400_000;
    if (daysOut > 300 && i > 0) return `${year - 1}-${pad(month)}-${pad(day)}`;
    return candidate;
  }
  return `${fromYear + 1}-${pad(month)}-${pad(day)}`;
}
