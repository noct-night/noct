/**
 * Which three nights "the coming weekend" means.
 *
 * Friday to Sunday in New York's calendar, matching how the app's "This weekend" preset behaves: Monday to
 * Thursday it looks forward to the coming Friday, and on a Friday or Saturday it means the weekend that is
 * already happening rather than the next one. Sunday is the only interesting case -- the weekend is ending,
 * not starting, so drafting a post about it would be drafting a post about last night.
 */
import { localDatePlus, NY_TZ } from '../lib/time.js';

const FRIDAY = 5;

/** Days forward from `dow` to the Friday whose weekend is worth posting about. */
export function daysToFriday(dow: number): number {
  // Sunday (0) is the tail of the weekend that is ending, not the start of one: look to the next Friday.
  if (dow === 0) return 5;
  // Monday to Thursday counts forward to Friday; Friday and Saturday count back to the Friday they are in.
  return FRIDAY - dow;
}

export interface WeekendRange {
  /** YYYY-MM-DD, the Friday. */
  from: string;
  /** YYYY-MM-DD, the Sunday. */
  to: string;
}

export function weekendRange(now: Date = new Date(), tz: string = NY_TZ): WeekendRange {
  // The local date in the target zone, read back as a UTC instant so the weekday is the local one.
  const today = localDatePlus(0, tz, now);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const offset = daysToFriday(dow);
  return { from: localDatePlus(offset, tz, now), to: localDatePlus(offset + 2, tz, now) };
}
