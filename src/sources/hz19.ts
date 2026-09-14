/**
 * 19hz.info — community-maintained electronic-music listings for 16 North American regions (no New York).
 *
 * One HTML table per region (`eventlisting_<Region>.php`): date/time, "Title @ Venue (City)" with the ticket
 * link, comma-separated genre tags, "price | age", organizers, alternate links, and a hidden ISO date. It is
 * run by volunteers, has no API, feed or terms page; NOCT reads each enabled region once a day and links every
 * row to its ticket page. Its value: genre tags per event and cross-platform ticket links (RA/DICE/Shotgun/
 * Posh/…) that hard-link 19hz rows to RA listings of the same night.
 */
import * as cheerio from 'cheerio';
import { CITIES, enabledCityKeys, getCity } from '../lib/cities.js';
import { fetchText } from '../lib/http.js';
import { cleanText, normText, parseAge, parseMoneyRange, sha1 } from '../lib/normalize.js';
import { iso, nightDate, parseClock, zonedToUtc } from '../lib/time.js';
import type { ExternalRef, FetchContext, FetchResult, NormalizedListing, SourceAdapter } from './types.js';
import { baseListing } from './types.js';

export const HZ_BASE = 'https://19hz.info';
export const regionUrl = (region: string): string => `${HZ_BASE}/eventlisting_${region}.php`;

export interface HzRow {
  isoDate: string | null;          // YYYY-MM-DD from the hidden cell
  dateText: string;                // "Sun: Sep 13" or "Fri: Sep 11-Sun: Sep 13"
  timeText: string;                // "1am-6am", "Fri: 3pm-Sun: 12pm", ""
  title: string;
  ticketUrl: string | null;
  venue: string | null;
  venueCity: string | null;
  tags: string[];
  priceText: string;
  ageText: string;
  organizers: string[];
  links: { label: string; url: string }[];
}

/** Ticket / alternate links reveal the platform id when it is RA or DICE; everything else stays a plain link. */
export function refsFromUrls(urls: string[]): ExternalRef[] {
  const refs: ExternalRef[] = [];
  for (const u of urls) {
    const ra = /ra\.co\/events\/(\d+)/.exec(u);
    if (ra) refs.push({ source: 'ra', id: ra[1] as string });
    const dice = /dice\.fm\/event\/([a-z0-9]{5,8})(?:-|$|\?)/i.exec(u);
    if (dice) refs.push({ source: 'dice', id: (dice[1] as string).toLowerCase() });
    const short = /link\.dice\.fm\/([A-Za-z0-9]+)/.exec(u);
    if (short) refs.push({ source: 'dice_short', id: short[1] as string });
  }
  return refs;
}

/** Parse one regional page into rows. Malformed cells (19hz omits some </td>) are tolerated by cheerio. */
export function parseHzPage(html: string): HzRow[] {
  const $ = cheerio.load(html);
  const rows: HzRow[] = [];
  $('table tbody tr').each((_, tr) => {
    const tds = $(tr).children('td');
    if (tds.length < 3) return;
    const dateCell = $(tds[0]);
    const dateHtml = dateCell.html() ?? '';
    const [datePart, timePart] = dateHtml.split(/<br\s*\/?>/i);
    const dateText = cleanText(datePart ?? '');
    const timeText = cleanText(timePart ?? '').replace(/^\(|\)$/g, '');
    const titleCell = $(tds[1]);
    const a = titleCell.find('a').first();
    const title = cleanText(a.text());
    if (!title) return;
    const ticketUrl = a.attr('href')?.trim() || null;
    // text after the anchor: " @ Venue (City)"
    const after = cleanText(titleCell.text()).slice(cleanText(titleCell.text()).indexOf(title) + title.length);
    const m = /@\s*(.+?)\s*(?:\(([^)]*)\))?\s*$/.exec(after);
    const venue = m ? cleanText(m[1]) || null : null;
    const venueCity = m?.[2] ? cleanText(m[2]) : null;
    const tags = cleanText($(tds[2]).text()).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    const priceAge = cleanText($(tds[3]).text());
    const [priceText = '', ageText = ''] = priceAge.split('|').map((x) => x.trim());
    const organizers = cleanText($(tds[4]).text()).split(',').map((x) => x.trim()).filter(Boolean);
    const links: { label: string; url: string }[] = [];
    $(tds[5]).find('a').each((__, l) => {
      const url = $(l).attr('href')?.trim();
      if (url) links.push({ label: cleanText($(l).text()), url });
    });
    const isoRaw = cleanText($(tds[6]).find('.shrink').text() || $(tds[6]).text());
    const isoDate = /^(\d{4})\/(\d{2})\/(\d{2})$/.test(isoRaw) ? isoRaw.replace(/\//g, '-') : null;
    rows.push({ isoDate, dateText, timeText, title, ticketUrl, venue, venueCity, tags, priceText, ageText, organizers, links });
  });
  return rows;
}

/** "1am-6am" → [{01:00},{06:00}]; "Fri: 3pm-Sun: 12pm" → first clock only (multi-day); "" → nothing. */
export function clocksOf(timeText: string): { start: { hour: number; minute: number } | null; end: { hour: number; minute: number } | null; multiDay: boolean } {
  const multiDay = /\b(mon|tue|wed|thu|fri|sat|sun)\b/i.test(timeText);
  const parts = timeText.split(/\s*[-–]\s*/).map((p) => p.replace(/^[A-Za-z]{3}:\s*/, '').trim()).filter(Boolean);
  const start = parts[0] ? parseClock(parts[0]) : null;
  const end = !multiDay && parts[1] ? parseClock(parts[1]) : null;
  return { start, end, multiDay };
}

export function hzListing(row: HzRow, city: string, region: string): NormalizedListing | null {
  if (!row.isoDate) return null;
  const tz = getCity(city).tz;
  const { start, end, multiDay } = clocksOf(row.timeText);
  const pad = (n: number) => String(n).padStart(2, '0');
  const startsAt = start ? zonedToUtc(`${row.isoDate}T${pad(start.hour)}:${pad(start.minute)}:00`, tz) : null;
  let endsAt = start && end && startsAt ? zonedToUtc(`${row.isoDate}T${pad(end.hour)}:${pad(end.minute)}:00`, tz) : null;
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) endsAt = new Date(endsAt.getTime() + 86_400_000);
  const urls = [row.ticketUrl, ...row.links.map((l) => l.url)].filter((u): u is string => !!u);
  const [priceMin, priceMax] = parseMoneyRange(row.priceText);
  const venueIsTba = !row.venue || /^tba\b|to be announced|secret/i.test(row.venue);
  return baseListing({
    source: '19hz',
    sourceId: sha1(`19hz|${region}|${row.isoDate}|${normText(row.title)}|${normText(row.venue ?? '')}`),
    sourceUrl: row.ticketUrl,
    raw: row,
    city,
    tz,
    title: row.title,
    startsAt: iso(startsAt),
    endsAt: iso(endsAt),
    hasTime: startsAt !== null,
    night: startsAt ? nightDate(startsAt, tz) : row.isoDate,
    venueName: venueIsTba ? `TBA - ${row.venueCity ?? getCity(city).name}` : row.venue,
    venueAddress: row.venueCity ? `${row.venue ?? ''}${row.venue ? ', ' : ''}${row.venueCity}` : null,
    lineup: [],                                         // 19hz folds the line-up into the title; the DB's title matching covers it
    priceMin,
    priceMax,
    priceNote: row.priceText || null,
    ageMin: parseAge(row.ageText),
    genres: row.tags,
    promoters: row.organizers,
    externalRefs: refsFromUrls(urls),
    sourceTags: { hz_region: region, hz_date_text: row.dateText, hz_time_text: row.timeText, multi_day: multiDay, links: row.links, venue_city: row.venueCity },
  });
}

export function buildHzListings(rows: HzRow[], city: string, region: string, fromDate: string, toDate: string, limit?: number): { listings: NormalizedListing[]; dropped: number } {
  const out: NormalizedListing[] = [];
  let dropped = 0;
  for (const r of rows) {
    const l = hzListing(r, city, region);
    if (!l) { dropped++; continue; }
    const night = l.night as string;
    if (night < fromDate || night > toDate) { dropped++; continue; }
    out.push(l);
    if (limit && out.length >= limit) break;
  }
  return { listings: out, dropped };
}

/** Enabled cities that 19hz has a regional list for. */
export function hzTargets(e: FetchContext['env']): { city: string; region: string }[] {
  return enabledCityKeys(e)
    .map((key) => CITIES.find((c) => c.key === key))
    .filter((c): c is NonNullable<typeof c> => !!c && !!c.hzRegion)
    .map((c) => ({ city: c.key, region: c.hzRegion as string }));
}

async function fetchHz(ctx: FetchContext): Promise<FetchResult> {
  const targets = hzTargets(ctx.env);
  const warnings: string[] = [];
  const listings: NormalizedListing[] = [];
  let truncated = false;
  for (const t of targets) {
    const html = await fetchText(regionUrl(t.region), { minIntervalMs: 3_000, signal: ctx.signal });
    const rows = parseHzPage(html);
    if (!rows.length) { warnings.push(`19hz ${t.region}: no rows parsed — page layout changed?`); continue; }
    const remaining = ctx.limit ? ctx.limit - listings.length : undefined;
    const { listings: ls, dropped } = buildHzListings(rows, t.city, t.region, ctx.fromDate, ctx.toDate, remaining);
    listings.push(...ls);
    ctx.log.info('19hz region parsed', { region: t.region, city: t.city, rows: rows.length, kept: ls.length, dropped });
    if (ctx.limit && listings.length >= ctx.limit) { truncated = true; break; }
  }
  if (!targets.length) warnings.push('19hz: none of the enabled cities has a 19hz region (New York has none)');
  return { listings, window: truncated || !targets.length ? null : { start: ctx.fromDate, end: ctx.toDate }, warnings };
}

export const hz19: SourceAdapter = {
  key: '19hz',
  displayName: '19hz',
  kind: 'scrape',
  priority: 45,
  feesIncludedDefault: false,
  tosNote:
    'Community-run listings site (volunteers; no API, feed or published terms; robots.txt absent). NOCT reads one regional page per enabled city ' +
    'once a day, links every row back to its ticket page and shows 19hz as the source. New York is not covered by 19hz.',
  enabled: (e) => (hzTargets(e).length ? { ok: true } : { ok: false, reason: 'no enabled city has a 19hz regional list (set NOCT_CITIES to include la, sf, chi, mia, dc, det or tor)' }),
  fetch: fetchHz,
};
