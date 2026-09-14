/**
 * Elsewhere (Bushwick) — venue-owned calendar.
 *
 * elsewhere.club is a Next.js site whose /events page is rendered from an Eventbrite-backed feed. The same
 * page data is served as JSON at /_next/data/<buildId>/events.json?page=N (36 events per page, date-ascending).
 * The buildId rotates on every deploy and a stale one 404s, so each run re-reads it from the
 * <script id="__NEXT_DATA__"> block of /events. That block already embeds page 1, so it is not fetched twice.
 * No key; robots.txt has no Disallow; the JSON is the site's own page data. Vercel-hosted, no challenge seen.
 */
import { HttpError, fetchJson, fetchText, type HttpOptions } from '../lib/http.js';
import { cents, parseAge, uniq } from '../lib/normalize.js';
import { iso, nightDate, parseWhen } from '../lib/time.js';
import { baseListing, type FetchContext, type FetchResult, type NormalizedListing, type PriceTier, type SourceAdapter } from './types.js';

export const ELSEWHERE_BASE = 'https://www.elsewhere.club';
/** small venue site: never more than one request every 2s */
const HTTP: HttpOptions = { minIntervalMs: 2_000 };
/** hard stop so a broken hasNextPage can never loop forever (25 pages ≈ 900 events ≈ a year of programming) */
const MAX_PAGES = 25;

export interface ElsewhereTicket {
  name?: string | null;
  face_value?: number | null;
  fees?: number | null;
  total?: number | null;
}

/** One entry of pageProps.initialEventData.events[] — fields as observed 2026-09-13; everything optional but id/name/start_date. */
export interface ElsewhereEvent {
  id: number | string;
  new_id?: string | null;
  slug?: string | null;
  provider?: string | null;
  status?: string | null;
  name: string;
  description?: string | null;
  type?: string | null;
  genres?: string[] | null;
  artists?: string[] | null;
  venues?: string[] | null;
  start_date: string;
  end_date?: string | null;
  door_time?: string | null;
  curfew_time?: string | null;
  announcement_date?: string | null;
  sale_start_date?: string | null;
  age_restriction?: string | null;
  address?: string | null;
  ticket_url?: string | null;
  sold_out?: boolean | null;
  representative_ticket_price?: number | null;
  tickets?: ElsewhereTicket[] | null;
  presented_by?: string | null;
  elsewhere_presents?: boolean | null;
  highlight?: boolean | null;
  image_urls?: string[] | null;
}

export interface ElsewhereEventsPage {
  events: ElsewhereEvent[];
  pageNumber: number;
  hasNextPage: boolean;
}

/** Elsewhere's rooms → the venue names the venue seed aliases into one Elsewhere family. */
const ROOM_VENUE = new Map<string, string>([
  ['the hall', 'Elsewhere Hall'],
  ['zone one', 'Elsewhere Zone One'],
  ['the rooftop', 'Elsewhere Rooftop'],
  ['the loft', 'Elsewhere Loft'],
  ['full venue', 'Elsewhere'],
]);

/** Pull buildId (and the embedded page props) out of the /events HTML. */
export function extractNextData(html: string): { buildId: string; props: unknown } {
  const m = /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('elsewhere: no __NEXT_DATA__ block on /events (site markup changed?)');
  const data = JSON.parse(m[1]!) as { buildId?: unknown; props?: unknown };
  if (typeof data.buildId !== 'string' || !data.buildId) throw new Error('elsewhere: __NEXT_DATA__ has no buildId');
  return { buildId: data.buildId, props: data.props };
}

/** Accepts either an events.json body or __NEXT_DATA__.props — both carry pageProps.initialEventData. */
export function readEventsPage(payload: unknown): ElsewhereEventsPage | null {
  const data = (payload as { pageProps?: { initialEventData?: Partial<ElsewhereEventsPage> } } | null)?.pageProps?.initialEventData;
  if (!data || !Array.isArray(data.events)) return null;
  return { events: data.events, pageNumber: Number(data.pageNumber ?? 0), hasNextPage: Boolean(data.hasNextPage) };
}

/**
 * venues[] is usually one of Elsewhere's rooms; for "Elsewhere Presents" shows at other venues it names that venue
 * (Good Room, Market Hotel, SILO, ...), which we keep verbatim so the listing lands on the right venue.
 */
export function elsewhereVenueName(venues: string[] | null | undefined, address: string | null | undefined): string | null {
  const rooms = (venues ?? []).map((v) => v.trim()).filter(Boolean);
  const foreign = rooms.find((r) => !ROOM_VENUE.has(r.toLowerCase()));
  if (foreign) return foreign;
  if (rooms.length === 1) return ROOM_VENUE.get(rooms[0]!.toLowerCase()) ?? null;
  if (rooms.length > 1) return 'Elsewhere'; // multi-room takeover
  return address && /599 johnson/i.test(address) ? 'Elsewhere' : null;
}

const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

/** tickets[] totals are what Eventbrite charges (face value + fees); the note keeps the split visible. */
function priceTiers(e: ElsewhereEvent): PriceTier[] {
  return (e.tickets ?? [])
    .filter((t): t is ElsewhereTicket & { total: number } => typeof t?.total === 'number')
    .map((t) => ({
      tier: t.name?.trim() || 'GA',
      price: cents(t.total),
      feesIncluded: true,
      available: e.sold_out ? false : true,
      note:
        typeof t.face_value === 'number'
          ? `face value ${dollars(t.face_value)}${t.fees ? ` + ${dollars(t.fees)} fees` : ''}`
          : null,
    }));
}

/** Normalise one event. Returns null (with a reason) when it cannot be placed in time. */
export function normalizeElsewhereEvent(e: ElsewhereEvent): { listing: NormalizedListing } | { error: string } {
  // id and name are the only fields the contract cannot do without; a malformed entry must not abort the page
  if (e.id === null || e.id === undefined || String(e.id) === '') return { error: `event without id: ${JSON.stringify(e.name ?? null)}` };
  const title = typeof e.name === 'string' ? e.name.trim() : '';
  if (!title) return { error: `event ${e.id} has no name` };
  const start = parseWhen(e.start_date);
  if (!start) return { error: `event ${e.id} has unparsable start_date ${JSON.stringify(e.start_date)}` };
  // end_date and curfew_time were identical in every observed payload; curfew is the fallback if end_date is dropped.
  const end = parseWhen(e.end_date) ?? parseWhen(e.curfew_time);

  const prices = priceTiers(e);
  const known = prices.map((p) => p.price).filter((p): p is number => p !== null);
  let priceMin: number | null = known.length ? Math.min(...known) : null;
  let priceMax: number | null = known.length ? Math.max(...known) : null;
  let feesIncluded: boolean | null = known.length ? true : null;
  let priceNote: string | null = null;
  // Events not yet on sale list no tickets but still carry a representative (face value) price.
  if (priceMin === null && typeof e.representative_ticket_price === 'number' && e.representative_ticket_price > 0) {
    priceMin = priceMax = cents(e.representative_ticket_price);
    feesIncluded = false;
    priceNote = 'representative face value; fees not included';
  }

  const rooms = (e.venues ?? []).map((v) => v.trim()).filter(Boolean);
  const listing = baseListing({
    source: 'elsewhere',
    sourceId: String(e.id),
    title,
    raw: e,
    sourceUrl: e.ticket_url ?? null,
    startsAt: iso(start),
    endsAt: iso(end),
    hasTime: true,
    night: nightDate(start),
    venueName: elsewhereVenueName(rooms, e.address),
    venueAddress: e.address?.trim() || null,
    lineup: uniq((e.artists ?? []).map((a) => a.trim()).filter(Boolean)),
    priceMin,
    priceMax,
    feesIncluded,
    priceNote,
    prices,
    soldOut: typeof e.sold_out === 'boolean' ? e.sold_out : null,
    ageMin: parseAge(e.age_restriction),
    genres: uniq((e.genres ?? []).map((g) => g.trim().toLowerCase()).filter(Boolean)),
    promoters: e.presented_by?.trim() ? [e.presented_by.trim()] : [],
    // id is the ticketing provider's event id (Eventbrite for every event seen), so it doubles as a cross-source ref
    externalRefs: [{ source: e.provider?.trim() || 'eventbrite', id: String(e.id) }],
    description: e.description?.trim() || null,
    imageUrl: e.image_urls?.[0] ?? null,
    sourceTags: {
      elsewhere_type: e.type ?? null,
      rooms,
      elsewhere_presents: e.elsewhere_presents ?? null,
      highlight: e.highlight ?? null,
      presented_by: e.presented_by ?? null,
      announcement_date: e.announcement_date ?? null,
      sale_start_date: e.sale_start_date ?? null,
      provider: e.provider ?? null,
    },
  });
  return { listing };
}

/** Pure: one events.json page (or the embedded page-1 props) → normalised listings, unfiltered. */
export function parseElsewherePage(payload: unknown): { listings: NormalizedListing[]; hasNextPage: boolean; pageNumber: number; warnings: string[] } {
  const page = readEventsPage(payload);
  if (!page) throw new Error('elsewhere: payload has no pageProps.initialEventData.events (page data shape changed?)');
  const listings: NormalizedListing[] = [];
  const warnings: string[] = [];
  for (const e of page.events) {
    const r = normalizeElsewhereEvent(e);
    if ('listing' in r) listings.push(r.listing);
    else warnings.push(r.error);
  }
  return { listings, hasNextPage: page.hasNextPage, pageNumber: page.pageNumber, warnings };
}

/**
 * Walk pages until one runs past toDate (pages are date-ascending), hasNextPage is false, or the limit is hit.
 * `loadPage` is injected so the walk is unit-testable offline.
 */
export async function collectElsewhere(ctx: FetchContext, loadPage: (page: number) => Promise<unknown>): Promise<FetchResult> {
  const listings: NormalizedListing[] = [];
  const warnings: string[] = [];
  let lastNightSeen: string | null = null;
  let complete = false;
  let capped = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const parsed = parseElsewherePage(await loadPage(page));
    warnings.push(...parsed.warnings);
    let pastRange = false;
    for (const l of parsed.listings) {
      const night = l.night!;
      if (!lastNightSeen || night > lastNightSeen) lastNightSeen = night;
      if (night > ctx.toDate) { pastRange = true; continue; } // whole page still scanned: ordering is only mostly guaranteed
      if (night < ctx.fromDate) continue;
      if (ctx.limit !== undefined && listings.length >= ctx.limit) { capped = true; break; }
      listings.push(l);
    }
    ctx.log.info(`page ${page}: ${parsed.listings.length} events, ${listings.length} kept`, { hasNextPage: parsed.hasNextPage });
    if (capped) break;
    if (pastRange || !parsed.hasNextPage) { complete = true; break; }
    if (page === MAX_PAGES) warnings.push(`stopped after ${MAX_PAGES} pages with hasNextPage still true`);
  }
  const window = complete && !capped && lastNightSeen
    ? { start: ctx.fromDate, end: lastNightSeen < ctx.toDate ? lastNightSeen : ctx.toDate }
    : null;
  return { listings, window, warnings };
}

const pageUrl = (buildId: string, page: number) => `${ELSEWHERE_BASE}/_next/data/${buildId}/events.json?page=${page}`;

export const elsewhere: SourceAdapter = {
  key: 'elsewhere',
  displayName: 'Elsewhere',
  kind: 'feed',
  priority: 70,
  feesIncludedDefault: true,
  tosNote:
    'Reads the venue\'s own Next.js page data (/_next/data/<buildId>/events.json) with a plain GET, at most one request per 2s, ' +
    'a few times a day. No key, no login, robots.txt allows it. Tickets are Eventbrite; prices are Eventbrite totals (fees included).',
  enabled: () => ({ ok: true }),
  async fetch(ctx) {
    const http: HttpOptions = { ...HTTP, signal: ctx.signal };
    const readBuild = async () => extractNextData(await fetchText(`${ELSEWHERE_BASE}/events`, http));
    let { buildId, props } = await readBuild();
    ctx.log.info('resolved buildId', { buildId });
    const embedded = readEventsPage(props);
    let refreshed = false;
    const loadPage = async (page: number): Promise<unknown> => {
      if (page === 1 && embedded && embedded.pageNumber <= 1) return props;
      try {
        return await fetchJson(pageUrl(buildId, page), http);
      } catch (err) {
        // A deploy between our HTML read and this request rotates the buildId (stale → 404). Re-derive once.
        if (!(err instanceof HttpError) || err.status !== 404 || refreshed) throw err;
        refreshed = true;
        ({ buildId, props } = await readBuild());
        ctx.log.warn('buildId rotated mid-run; re-derived', { buildId });
        return fetchJson(pageUrl(buildId, page), http);
      }
    };
    return collectElsewhere(ctx, loadPage);
  },
};
