/**
 * Public Records (Gowanus) — venue homepage.
 *
 * The WordPress site hard-renders the whole upcoming calendar on the homepage as
 *   <a class="event table-row" href="https://link.dice.fm/<code>" data-id="<n>">
 *     <div class="table-cell date">Sun 9.13<br>Club, 3:00 pm,<br><span class="location">The Nursery</span></div>
 *     <div class="table-cell title">The Nursery: Benji B, Nabihah Iqbal [DJ]</div>
 * No year is printed anywhere, no JSON, no REST route for events. Tickets are DICE short links, so DICE is the
 * authority for prices/age/lineup; this adapter carries the venue's own rooms, series names and Club/Live/Etc
 * typing, and keeps the venue covered when DICE is unavailable. Wordfence is installed: a few polls a day, 2s apart.
 */
import { load } from 'cheerio';
import { fetchText, type HttpOptions } from '../lib/http.js';
import { cleanText, sha1 } from '../lib/normalize.js';
import { iso, nextMonthDay, nightDate, parseClock, zonedToUtc } from '../lib/time.js';
import { baseListing, type FetchContext, type FetchResult, type FetchWindow, type NormalizedListing, type SourceAdapter } from './types.js';

export const PUBLICRECORDS_HOME = 'https://publicrecords.nyc/';
const PUBLICRECORDS_ADDRESS = '233 Butler St, Brooklyn, NY 11217';
const HTTP: HttpOptions = { minIntervalMs: 2_000 };
/** below this many rows the page is clearly truncated/broken and must not drive tombstoning */
const MIN_ROWS_FOR_WINDOW = 20;

export interface PublicRecordsRow {
  siteId: string | null;
  href: string | null;
  /** "Sun" as printed */
  weekday: string | null;
  month: number;
  day: number;
  /** "Club" | "Live" | "Etc" | "Festival" — a row can carry several ("Club, Live") */
  types: string[];
  /** "3:00 pm" as printed, null when absent */
  clock: string | null;
  rooms: string[];
  title: string;
  html: string;
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * "9.13" carries no year: nextMonthDay() picks the occurrence nearest fromDate (yesterday still counts for a run
 * after midnight; a date that just passed stays in the past and is dropped). It trusts its input, so a garbled
 * "2.30" is rejected here rather than becoming a night Postgres refuses.
 */
function monthDayToDate(month: number, day: number, fromDate: string): string | null {
  const date = nextMonthDay(month, day, fromDate);
  const t = new Date(Date.UTC(Number(date.slice(0, 4)), month - 1, day));
  return t.getUTCMonth() === month - 1 && t.getUTCDate() === day ? date : null;
}

/** 0 = Sunday … 6 = Saturday for a YYYY-MM-DD (calendar weekday, no time zone involved). */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Extract one <a class="event table-row"> into its printed parts. Null when the date cell is not "Ddd M.D ...". */
export function parseRow(html: string): PublicRecordsRow | null {
  const $ = load(html);
  const a = $('a.event.table-row').first();
  if (!a.length) return null;
  const dateCell = a.find('.table-cell.date').first();
  const rooms = dateCell.find('span.location').toArray().map((s) => cleanText($(s).text())).filter(Boolean);
  // The cell is "<date><br><types>, <clock>, <br><rooms>": split on <br> after dropping the room spans.
  dateCell.find('span.location').remove();
  const [dateText = '', metaText = ''] = (dateCell.html() ?? '').split(/<br\s*\/?>/i).map((s) => cleanText(s));
  const m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})\.(\d{1,2})$/i.exec(dateText);
  if (!m) return null;
  const types: string[] = [];
  let clock: string | null = null;
  for (const token of metaText.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (/^\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?$/i.test(token)) clock = token;
    else types.push(token.replace(/\.$/, ''));
  }
  const titleCell = a.find('.table-cell.title').first();
  titleCell.find('.get-tickets-mobile').remove();
  return {
    siteId: a.attr('data-id')?.trim() || null,
    href: a.attr('href')?.trim() || null,
    weekday: m[1]!,
    month: Number(m[2]),
    day: Number(m[3]),
    types,
    clock,
    rooms,
    title: cleanText(titleCell.text()),
    html,
  };
}

/** Tokens that are billing filler, not artists. */
const JUNK_ITEM = /^(?:\+?\s*more|and more|tba|tbc|tbd|special guests?|guests?|friends|an evening|residents?)$/i;
const LEAD_FILLER = /^(?:an evening with|performance by|special guests?|with special guests?|feat\.?|ft\.?|featuring)\s+/i;

/**
 * Drop " – Album Title"/" - Tour Name" subtitles. A subtitle runs to the next top-level separator ("," or " / "),
 * so "Nate Mercereau – FANTASTIC THOUGHTS with special guests, Carlos Niño" keeps Carlos Niño. "&" only ends a
 * subtitle when the title carries several dashes ("A – X & B – Y"); otherwise "Live Film & Score" is one subtitle.
 */
export function stripSubtitles(text: string): string {
  const many = (text.match(/\s[-–—]\s/g) ?? []).length > 1;
  const re = many ? /\s+[-–—]\s+[^,/&]*?(?=\s*(?:,|\/\s|&\s)|$)/g : /\s+[-–—]\s+[^,/]*?(?=\s*(?:,|\/\s)|$)/g;
  return text.replace(re, '');
}

/**
 * Titles are "Series: acts" or "Label presents acts"; club nights separate rooms with " / ". Only Club/Live rows
 * carry a lineup — Etc/Festival rows are talks, listening sessions and umbrella entries. Items stay as billing
 * lines ("A b2b B", "X Open To Close"); the DB splits and strips those. "[Live]" becomes "(live)" so it reads it.
 */
export function parseTitleLineup(title: string, types: string[]): { series: string | null; promoter: string | null; items: string[] } {
  const isMusic = types.some((t) => /^(club|live)$/i.test(t));
  if (!isMusic) return { series: null, promoter: null, items: [] };
  const t = cleanText(title);
  // the LAST colon separates nested series ("DURATIONS: Ballet: buttechno, ...") from the acts
  const colon = t.lastIndexOf(': ');
  const presents = /^(.{1,80}?)\s+presents\s+(.+)$/i.exec(t);
  let series: string | null = null;
  let promoter: string | null = null;
  let rest = t;
  if (colon > 0) { series = t.slice(0, colon).trim(); rest = t.slice(colon + 2); }
  else if (presents) { promoter = presents[1]!.trim(); rest = presents[2]!; }
  const items = stripSubtitles(rest)
    .replace(/\s*\[(live|live set|hybrid(?: set)?|live pa)\]/gi, ' (live)')
    .replace(/([^\s,/&+])\s*\[[^\]]*\]/g, '$1') // "Name [DJ]", "[DJ Set]", "[Avey Tare and ...]" are descriptors; a bare "[g]" is an act
    .split(/\s*,\s*|\s+\/\s+|\s+&\s+|\s+\+\s+|\s+(?:with|ft\.?|feat\.?|featuring)\s+/i)
    .map((s) => s.replace(LEAD_FILLER, '').trim())
    .filter((s) => s && !JUNK_ITEM.test(s));
  return { series, promoter, items };
}

/** One printed row → listing; `warnings` receives weekday mismatches (a wrong-year guess would show up there). */
export function rowToListing(row: PublicRecordsRow, fromDate: string, warnings: string[]): NormalizedListing | null {
  const date = monthDayToDate(row.month, row.day, fromDate);
  if (!date) { warnings.push(`row ${row.siteId ?? '?'}: impossible date ${row.month}.${row.day}`); return null; }
  const wd = row.weekday ? WEEKDAYS.indexOf(row.weekday.slice(0, 3).toLowerCase()) : -1;
  if (wd >= 0 && wd !== weekdayOf(date)) {
    warnings.push(`row ${row.siteId ?? '?'} "${row.title}": printed ${row.weekday} ${row.month}.${row.day} but ${date} is a ${WEEKDAYS[weekdayOf(date)]}`);
  }
  const { series, promoter, items } = parseTitleLineup(row.title, row.types);
  let clock = row.clock ? parseClock(row.clock) : null;
  // The site occasionally prints "7:00 am" for an evening show (a pm typo). Nothing at Public Records starts
  // between 5 and 10 in the morning, so a Club/Live row with such a clock is kept date-only rather than stored
  // as a wrong instant; Etc rows (meditations, talks) legitimately start at 11 am and are left alone.
  const isMusic = row.types.some((t) => /^(club|live)$/i.test(t));
  if (clock && isMusic && clock.hour >= 5 && clock.hour < 10) {
    warnings.push(`row ${row.siteId ?? '?'} "${row.title}": implausible start ${row.clock}, kept date-only`);
    clock = null;
  }
  const start = clock ? zonedToUtc(`${date}T${pad(clock.hour)}:${pad(clock.minute)}:00`) : null;
  const code = row.href ? /link\.dice\.fm\/([A-Za-z0-9]+)/.exec(row.href)?.[1] : undefined;
  const key = row.siteId ?? row.href;
  if (!key) { warnings.push(`row "${row.title}" has neither data-id nor href, skipped`); return null; }
  return baseListing({
    source: 'publicrecords',
    sourceId: sha1(`publicrecords|${key}`),
    title: row.title,
    raw: { ...row },
    sourceUrl: row.href,
    startsAt: iso(start),
    hasTime: start !== null,
    night: start ? nightDate(start) : date,
    venueName: 'Public Records',
    venueAddress: PUBLICRECORDS_ADDRESS,
    lineup: items,
    promoters: promoter ? [promoter] : [],
    externalRefs: code ? [{ source: 'dice_short', id: code }] : [],
    sourceTags: {
      room: row.rooms.length ? row.rooms.join(' / ') : null,
      rooms: row.rooms,
      pr_type: row.types.join('/') || null,
      pr_types: row.types,
      series,
      site_event_id: row.siteId,
      date_label: `${row.weekday ?? ''} ${row.month}.${row.day}`.trim(),
      clock: row.clock,
    },
  });
}

/** Pure: homepage HTML → listings within [fromDate, toDate] plus what the window rule needs. */
export function parsePublicRecordsHome(
  html: string,
  opts: { fromDate: string; toDate: string },
): { listings: NormalizedListing[]; warnings: string[]; rowCount: number; maxDate: string | null } {
  const $ = load(html);
  const warnings: string[] = [];
  const listings: NormalizedListing[] = [];
  let rowCount = 0;
  let maxDate: string | null = null;
  for (const el of $('a.event.table-row').toArray()) {
    const row = parseRow($.html(el));
    if (!row) { warnings.push(`unparsable row: ${cleanText($(el).text()).slice(0, 80)}`); continue; }
    rowCount++;
    const listing = rowToListing(row, opts.fromDate, warnings);
    if (!listing) continue;
    const night = listing.night!;
    if (!maxDate || night > maxDate) maxDate = night;
    if (night < opts.fromDate || night > opts.toDate) continue;
    listings.push(listing);
  }
  return { listings, warnings, rowCount, maxDate };
}

/** Full enumeration is only credible when the page is populated, runs past the requested range, and nothing was capped. */
export function publicRecordsWindow(
  parsed: { rowCount: number; maxDate: string | null },
  opts: { fromDate: string; toDate: string; capped: boolean },
): FetchWindow | null {
  const complete = parsed.rowCount >= MIN_ROWS_FOR_WINDOW && parsed.maxDate !== null && parsed.maxDate >= opts.toDate;
  return complete && !opts.capped ? { start: opts.fromDate, end: opts.toDate } : null;
}

export const publicrecords: SourceAdapter = {
  key: 'publicrecords',
  displayName: 'Public Records',
  kind: 'scrape',
  priority: 65,
  feesIncludedDefault: false,
  tosNote:
    'One plain GET of the venue\'s public homepage (robots.txt: allow all), a few times a day, 2s between requests. No key, no login. ' +
    'No prices or ages are printed; tickets are DICE short links recorded as external refs.',
  enabled: () => ({ ok: true }),
  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const html = await fetchText(PUBLICRECORDS_HOME, { ...HTTP, signal: ctx.signal });
    const parsed = parsePublicRecordsHome(html, { fromDate: ctx.fromDate, toDate: ctx.toDate });
    ctx.log.info(`${parsed.rowCount} rows on homepage, ${parsed.listings.length} in range`, { maxDate: parsed.maxDate });
    const listings = ctx.limit !== undefined ? parsed.listings.slice(0, ctx.limit) : parsed.listings;
    const window = publicRecordsWindow(parsed, { fromDate: ctx.fromDate, toDate: ctx.toDate, capped: listings.length < parsed.listings.length });
    return { listings, window, warnings: parsed.warnings };
  },
};
