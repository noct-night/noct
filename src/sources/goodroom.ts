/**
 * Good Room (Greenpoint) — venue WordPress site, two plain-HTTP reads.
 *
 *  - Homepage: every upcoming night is an <article class="type-events post-<id>"> with a full date in
 *    .event-day p[title] ("Friday, September 18, 2026"), per-room lineup lines ("Good Room:" / "Bad Room:"),
 *    one ticket link (RA, DICE or Eventbrite) and a flyer. No times are published → date-only listings.
 *  - Events RSS feed: only adds permalinks and the post title ("9.18 – Eli Escobar") for the 10 most recently
 *    published posts; description/content are empty. Matched to articles by WordPress post id (guid ?p=<id>).
 *
 * HTTPS is broken on this host (self-signed, expired certificate): everything stays on http:// and is never
 * upgraded. WordPress 4.9 on shared hosting — poll once or twice a day, one request per 2s.
 */
import { load } from 'cheerio';
import { BlockedError, fetchText, type HttpOptions } from '../lib/http.js';
import { cleanText, normText, sha1 } from '../lib/normalize.js';
import { nextMonthDay } from '../lib/time.js';
import { baseListing, type ExternalRef, type FetchContext, type FetchResult, type NormalizedListing, type SourceAdapter } from './types.js';

export const GOODROOM_HOME = 'http://www.goodroombk.com/';
export const GOODROOM_FEED = 'http://www.goodroombk.com/?post_type=events&feed=rss2';
const GOODROOM_ADDRESS = '98 Meserole Avenue, Brooklyn, NY 11222';
const HTTP: HttpOptions = { minIntervalMs: 2_000 };

export interface GoodRoomRoom {
  /** "Good Room" | "Bad Room" (label as printed, minus the colon) */
  room: string;
  /** lineup line as printed, e.g. "FIXED with James Axon b2b JDH (all night)" */
  text: string;
}

export interface GoodRoomArticle {
  postId: string | null;
  /** YYYY-MM-DD */
  date: string | null;
  /** "Friday, September 18, 2026" when present */
  dateLabel: string | null;
  ticketUrl: string | null;
  flyer: string | null;
  rooms: GoodRoomRoom[];
  html: string;
}

export interface GoodRoomFeedItem {
  title: string;
  link: string;
  postId: string | null;
  month: number | null;
  day: number | null;
  /** "9.26 – Denham Audio" → "Denham Audio" */
  headliner: string | null;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "Friday, September 18, 2026" → { date: "2026-09-18", weekday: 5 }; null when it is not that shape. */
export function parseLongDate(label: string | null | undefined): { date: string; weekday: number | null } | null {
  if (!label) return null;
  const m = /^(?:([a-z]+),?\s+)?([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i.exec(label.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]!.toLowerCase());
  if (month < 0) return null;
  const weekday = m[1] ? WEEKDAYS.indexOf(m[1].toLowerCase()) : -1;
  return { date: `${m[4]}-${pad(month + 1)}-${pad(Number(m[3]))}`, weekday: weekday < 0 ? null : weekday };
}

/**
 * "9/18" carries no year: nextMonthDay() picks the occurrence nearest fromDate (a date that just passed stays in
 * the past and is dropped by the range filter). It trusts its input, so a garbled "2/30" is rejected here rather
 * than becoming a night Postgres refuses.
 */
function monthDayToDate(month: number, day: number, fromDate: string): string | null {
  const date = nextMonthDay(month, day, fromDate);
  const t = new Date(Date.UTC(Number(date.slice(0, 4)), month - 1, day));
  return t.getUTCMonth() === month - 1 && t.getUTCDate() === day ? date : null;
}

/** Homepage → one record per <article class="type-events">. Pure; the year fallback needs fromDate. */
export function parseGoodRoomHome(html: string, opts: { fromDate: string }): { articles: GoodRoomArticle[]; warnings: string[] } {
  const $ = load(html);
  const warnings: string[] = [];
  const articles = $('article.type-events').toArray().map((el) => {
    const a = $(el);
    const postId = /\bpost-(\d+)\b/.exec(`${a.attr('id') ?? ''} ${a.attr('class') ?? ''}`)?.[1] ?? null;
    const dateLabel = a.find('.event-day p[title], .event-date p[title]').first().attr('title')?.trim() || null;
    const long = parseLongDate(dateLabel);
    let date = long?.date ?? null;
    const md = date ? null : /^(\d{1,2})\/(\d{1,2})$/.exec(a.find('.b_date').first().text().trim());
    if (md) {
      date = monthDayToDate(Number(md[1]), Number(md[2]), opts.fromDate);
      warnings.push(`post ${postId ?? '?'}: no full date label, inferred ${date ?? 'nothing'} from ${md[0]}`);
    }
    const rooms: GoodRoomRoom[] = a.find('.lineup-title').toArray().map((t) => {
      const title = $(t);
      const room = cleanText(title.text()).replace(/:\s*$/, '').trim();
      const text = cleanText(title.next('.lineup').find('.c_lineup').text() || title.next('.lineup').attr('title'));
      return { room, text };
    }).filter((r) => r.text);
    const ticketUrl = a.find('.event-ticket-link a[href]').first().attr('href')?.trim() || null;
    const flyer = a.find('.post-thumbnail img[src]').first().attr('src')?.trim() || null;
    return { postId, date, dateLabel, ticketUrl, flyer, rooms, html: $.html(a) };
  });
  return { articles, warnings };
}

/** Events RSS → items. Titles are "M.D – Headliner"; the guid carries the WordPress post id. */
export function parseGoodRoomFeed(xml: string): GoodRoomFeedItem[] {
  const $ = load(xml, { xml: true });
  return $('item').toArray().map((el) => {
    const it = $(el);
    const title = cleanText(it.find('title').first().text());
    const link = it.find('link').first().text().trim();
    const postId = /[?&]p=(\d+)/.exec(it.find('guid').first().text())?.[1] ?? null;
    const m = /^(\d{1,2})\.(\d{1,2})\s*[–—-]\s*(.+)$/.exec(title);
    return {
      title,
      link,
      postId,
      month: m ? Number(m[1]) : null,
      day: m ? Number(m[2]) : null,
      headliner: m ? m[3]!.trim() : null,
    };
  }).filter((it) => it.link);
}

/** Cross-source ids from the ticket link: ra.co/events/<id>, dice.fm/.../<hash>-<slug>, eventbrite.com/e/...-<id>. */
export function ticketRef(url: string | null | undefined): ExternalRef | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (/(^|\.)ra\.co$/.test(host)) {
    const id = /\/events\/(\d+)/.exec(u.pathname)?.[1];
    return id ? { source: 'ra', id } : null;
  }
  if (/(^|\.)dice\.fm$/.test(host)) {
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (!last) return null;
    // DICE event paths are <hash>-<perm_name>; the 6-char hash is what the DICE adapter keys on
    const hash = /^([a-z0-9]{4,10})(?:-|$)/i.exec(last)?.[1];
    return { source: 'dice', id: hash ?? last };
  }
  if (/(^|\.)eventbrite\.[a-z.]+$/.test(host)) {
    // org subdomains (otha.eventbrite.com) link to a page, not an event: no id to record
    const id = /\/e\/(?:[^/?#]*?-)?(\d+)(?:[/?#]|$)/.exec(u.pathname)?.[1];
    return id ? { source: 'eventbrite', id } : null;
  }
  return null;
}

/** Tokens that are billing filler, not artists. */
const JUNK_ITEM = /^(?:\+?\s*more|and more|tba|tbc|tbd|special guests?|guests?|friends|nyc|residents?)$/i;
/** "Love Games: ...", "FIXED with ...", "Synthicide Halloween ft ..." — the left side is a party/series, not an act. */
const SERIES_SPLIT = /^(.{1,80}?)(:\s+|\s+(?:with|w\/|ft\.?|feat\.?|featuring|presents?|invites?)\s+)(.+)$/i;

/**
 * One room line → series / promoter label (if any) + billing items. "Elsewhere Presents: X" and "St Vitus presents X"
 * name a promoter, "Love Games: X" / "FIXED with X" name the party. Items keep "(all night)" and "A b2b B": the DB splits those.
 */
export function parseRoomLine(text: string): { series: string | null; promoter: string | null; items: string[] } {
  const line = cleanText(text);
  const m = SERIES_SPLIT.exec(line);
  const left = m ? m[1]!.trim() : null;
  const sep = m ? m[2]!.trim().toLowerCase() : '';
  const rest = m ? m[3]! : line;
  const promoter = left ? (/^(.+?)\s+presents?$/i.exec(left)?.[1] ?? (/^presents?$/.test(sep) ? left : null)) : null;
  const items = rest
    .split(/\s*,\s*|\s+\/\s+|\s+\+\s+|\s+&\s+/)
    .map((s) => s.replace(/\s+[-–—]\s+.*$/, '').trim()) // "Otha - Club 20 Tour 2026" → "Otha"
    .filter((s) => s && !JUNK_ITEM.test(s));
  return { series: promoter ? null : left, promoter, items };
}

/** Homepage articles + feed items → listings within [fromDate, toDate]. */
export function buildGoodRoomListings(
  articles: GoodRoomArticle[],
  feed: GoodRoomFeedItem[],
  opts: { fromDate: string; toDate: string },
): { listings: NormalizedListing[]; warnings: string[] } {
  const listings: NormalizedListing[] = [];
  const warnings: string[] = [];
  const byPost = new Map(feed.filter((f) => f.postId).map((f) => [f.postId!, f]));
  const byMonthDay = new Map(feed.filter((f) => f.month && f.day).map((f) => [`${f.month}-${f.day}`, f]));

  for (const a of articles) {
    if (!a.date) { warnings.push(`post ${a.postId ?? '?'}: no date, skipped`); continue; }
    if (a.date < opts.fromDate || a.date > opts.toDate) continue;
    const [, mm, dd] = a.date.split('-').map(Number);
    const feedItem = (a.postId && byPost.get(a.postId)) || byMonthDay.get(`${mm}-${dd}`) || null;

    const parsedRooms = a.rooms.map((r) => ({ ...r, ...parseRoomLine(r.text) }));
    const main = parsedRooms.find((r) => /good room/i.test(r.room)) ?? parsedRooms[0];
    // Title is the main-room line as printed: the feed's "Headliner" is only known while the post is among the 10
    // newest, so keying the title on it would make listings flip once they age out of the feed.
    const title = main?.text ?? null;
    if (!title) { warnings.push(`post ${a.postId ?? '?'} on ${a.date}: no lineup text, skipped`); continue; }

    const seen = new Set<string>();
    const lineup: string[] = [];
    for (const item of parsedRooms.flatMap((r) => r.items)) {
      const k = normText(item);
      if (k && !seen.has(k)) { seen.add(k); lineup.push(item); }
    }
    const ref = ticketRef(a.ticketUrl);
    // The WordPress post id is the only key that survives the feed's 10-item horizon; permalink/date+title are fallbacks.
    const sourceId = a.postId
      ? sha1(`goodroom|post|${a.postId}`)
      : feedItem ? sha1(`goodroom|${feedItem.link}`) : sha1(`goodroom|${a.date}|${normText(title)}`);

    listings.push(baseListing({
      source: 'goodroom',
      sourceId,
      title,
      raw: { ...a, feed: feedItem },
      sourceUrl: feedItem?.link ?? a.ticketUrl ?? GOODROOM_HOME,
      hasTime: false,
      night: a.date,
      venueName: 'Good Room',
      venueAddress: GOODROOM_ADDRESS,
      lineup,
      promoters: main?.promoter ? [main.promoter] : [],
      externalRefs: ref ? [ref] : [],
      imageUrl: a.flyer,
      sourceTags: {
        rooms: parsedRooms.map((r) => ({ room: r.room, lineup: r.text, artists: r.items })),
        series: main?.series ?? null,
        headliner: feedItem?.headliner ?? null,
        post_id: a.postId,
        ticket_url: a.ticketUrl,
        permalink: feedItem?.link ?? null,
        feed_title: feedItem?.title ?? null,
        date_label: a.dateLabel,
      },
    }));
  }
  return { listings, warnings };
}

export const goodroom: SourceAdapter = {
  key: 'goodroom',
  displayName: 'Good Room',
  kind: 'feed',
  priority: 60,
  feesIncludedDefault: false,
  tosNote:
    'Two plain-HTTP GETs of the venue\'s public WordPress site (homepage + events RSS), one request per 2s, once or twice a day. ' +
    'No key. HTTPS is broken on the host, so http:// is used as published. No prices or times are published; tickets are on RA/DICE/Eventbrite.',
  enabled: () => ({ ok: true }),
  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const http: HttpOptions = { ...HTTP, signal: ctx.signal };
    const home = parseGoodRoomHome(await fetchText(GOODROOM_HOME, http), { fromDate: ctx.fromDate });
    const warnings = [...home.warnings];
    let feed: GoodRoomFeedItem[] = [];
    try {
      feed = parseGoodRoomFeed(await fetchText(GOODROOM_FEED, http));
    } catch (err) {
      // The feed only adds permalinks/titles; a fragile 2018-era WordPress should not fail the whole run over it.
      if (err instanceof BlockedError) throw err;
      warnings.push(`feed unavailable, continuing with homepage only: ${err instanceof Error ? err.message : String(err)}`);
    }
    ctx.log.info(`homepage ${home.articles.length} articles, feed ${feed.length} items`);
    const built = buildGoodRoomListings(home.articles, feed, { fromDate: ctx.fromDate, toDate: ctx.toDate });
    const listings = ctx.limit !== undefined ? built.listings.slice(0, ctx.limit) : built.listings;
    // The homepage is the venue's full upcoming list today, but nothing documents how far ahead it goes: never tombstone from it.
    return { listings, window: null, warnings: [...warnings, ...built.warnings] };
  },
};
