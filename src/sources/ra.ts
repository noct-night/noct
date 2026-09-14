/**
 * Resident Advisor adapter.
 *
 * RA has no public API. Its web app loads listings by POSTing the GET_EVENT_LISTINGS operation to
 * https://ra.co/graphql, which answers without any key or cookie as long as the User-Agent looks like a
 * browser (Cloudflare 403s curl/python UAs; see env.ts). The HTML pages (/events/..., /clubs/...) sit
 * behind DataDome, so this adapter never requests them: everything comes from the one GraphQL endpoint,
 * at most one request per 1.5 s, and a block response is surfaced as BlockedError by lib/http.
 *
 * Verified live 2026-09-13 (scratchpad/ra_research.md): pageSize > 100 is rejected server-side, boolean
 * listing filters (isTicketed/isSoldOut) return 0 rows so ticket state is derived client-side, and the
 * `ticketing.isAnyTicketTierAvailable` flag is false even for on-sale events, so sold-out is computed from
 * the per-tier validType instead.
 */
import { env } from '../lib/env.js';
import { postJson } from '../lib/http.js';
import { cleanText, parseMoneyRange } from '../lib/normalize.js';
import { NY_TZ, iso, nightDate, zonedToUtc } from '../lib/time.js';
import { baseListing, type FetchContext, type FetchResult, type NormalizedListing, type PriceTier, type SourceAdapter } from './types.js';

export const RA_GRAPHQL_URL = 'https://ra.co/graphql';
/** RA area 8 = New York City (area{ianaTimeZone} = America/New_York). */
export const RA_DEFAULT_AREA_ID = 8;
/** Server-side cap: pageSize 101+ -> "Limit must not be greater than 100". */
export const RA_PAGE_SIZE_MAX = 100;
const MIN_INTERVAL_MS = 1_500;
/** 100 pages x 100 = 10k events, ~10x a month of NYC listings; stops a runaway loop if totalResults ever lies. */
const MAX_PAGES = 100;

/**
 * Same operation name and variables the ra.co web app sends; the selection is trimmed to what NOCT stores.
 * `tickets(queryType: AVAILABLE)` is the only queryType that works unauthenticated (MANAGED is for promoters).
 */
export const GET_EVENT_LISTINGS = `query GET_EVENT_LISTINGS($filters: FilterInputDtoInput, $filterOptions: FilterOptionsInputDtoInput, $page: Int, $pageSize: Int, $sort: SortInputDtoInput) {
  eventListings(filters: $filters, filterOptions: $filterOptions, pageSize: $pageSize, page: $page, sort: $sort) {
    data {
      id
      listingDate
      event {
        id title date startTime endTime cost minimumAge isTicketed isFestival hasSecretVenue interestedCount contentUrl dateUpdated
        venue { id name address contentUrl location { latitude longitude } area { id name ianaTimeZone } }
        artists { id name }
        genres { id name slug }
        images { filename type }
        promoters { id name }
        pick { blurb }
        setTimes { status lineup }
        tickets(queryType: AVAILABLE) { id title priceRetail validType onSaleFrom onSaleUntil currency { code } }
      }
    }
    totalResults
  }
}`;

// ---- wire shapes (only the fields we select; everything optional because RA nulls freely) ---------------

export interface RaTicket {
  id?: string | null;
  title?: string | null;
  /** fee-inclusive retail price ("$25 + $1.90 fee" -> 26.9) */
  priceRetail?: number | null;
  /** VALID | SOLDOUT | NOLONGERONSALE | NOTYETONSALE | ... */
  validType?: string | null;
  onSaleFrom?: string | null;
  onSaleUntil?: string | null;
  currency?: { code?: string | null } | null;
}

export interface RaEvent {
  id: string;
  title: string;
  /** LocalDateTime at midnight: "2026-09-13T00:00:00.000" */
  date?: string | null;
  /** venue-local wall clock with no offset: "2026-09-13T15:00:00.000" */
  startTime?: string | null;
  endTime?: string | null;
  /** promoter free text: "$70", "$5-$30", "10.00", "" */
  cost?: string | null;
  minimumAge?: number | null;
  isTicketed?: boolean | null;
  isFestival?: boolean | null;
  hasSecretVenue?: boolean | null;
  interestedCount?: number | null;
  contentUrl?: string | null;
  dateUpdated?: string | null;
  venue?: {
    id?: string | null;
    name?: string | null;
    address?: string | null;
    contentUrl?: string | null;
    location?: { latitude?: number | null; longitude?: number | null } | null;
    area?: { id?: string | null; name?: string | null; ianaTimeZone?: string | null } | null;
  } | null;
  artists?: Array<{ id?: string | null; name?: string | null }> | null;
  genres?: Array<{ id?: string | null; name?: string | null; slug?: string | null }> | null;
  images?: Array<{ filename?: string | null; type?: string | null }> | null;
  promoters?: Array<{ id?: string | null; name?: string | null }> | null;
  pick?: { blurb?: string | null } | null;
  setTimes?: { status?: string | null; lineup?: string | null } | null;
  tickets?: RaTicket[] | null;
}

export interface RaListing {
  id?: string | null;
  listingDate?: string | null;
  event?: RaEvent | null;
}

export interface RaListingsBody {
  data?: { eventListings?: { data?: RaListing[] | null; totalResults?: number | null } | null } | null;
  errors?: Array<{ message?: string; path?: unknown }> | null;
}

export interface RaListingsVariables {
  filters: { areas: { eq: number }; listingDate: { gte: string; lte: string } };
  filterOptions: { genre: boolean; eventType: boolean };
  pageSize: number;
  page: number;
  sort: { listingDate: { order: 'ASCENDING' }; score: { order: 'DESCENDING' }; titleKeyword: { order: 'ASCENDING' } };
}

// ---- pure helpers ------------------------------------------------------------------------------------

/** The exact variables the web app sends for a city listing page (dates are inclusive New York nights). */
export function buildVariables(opts: { areaId: number; fromDate: string; toDate: string; page: number; pageSize: number }): RaListingsVariables {
  return {
    filters: {
      areas: { eq: opts.areaId },
      listingDate: { gte: `${opts.fromDate}T00:00:00.000Z`, lte: `${opts.toDate}T23:59:59.999Z` },
    },
    filterOptions: { genre: true, eventType: true },
    pageSize: opts.pageSize,
    page: opts.page,
    sort: { listingDate: { order: 'ASCENDING' }, score: { order: 'DESCENDING' }, titleKeyword: { order: 'ASCENDING' } },
  };
}

export interface ParsedPage {
  events: RaEvent[];
  /** rows RA returned on this page, including ones without a usable event; drives the "is there another page" check */
  rows: number;
  totalResults: number;
  /** GraphQL partial errors that came alongside usable data */
  warnings: string[];
}

/**
 * Unwrap one response body. RA returns HTTP 200 for GraphQL failures, so `errors` must be inspected:
 * with no usable `data` it is a failed page (throw); alongside data it is a partial error (warn).
 */
export function parseListingsPage(body: RaListingsBody): ParsedPage {
  const messages = (body.errors ?? []).map((e) => e?.message ?? 'unknown GraphQL error');
  const listings = body.data?.eventListings;
  if (!listings || !Array.isArray(listings.data)) {
    throw new Error(`RA GraphQL returned no eventListings${messages.length ? `: ${messages.join('; ')}` : ''}`);
  }
  const events: RaEvent[] = [];
  for (const row of listings.data) {
    const ev = row?.event;
    if (ev && typeof ev.id === 'string' && typeof ev.title === 'string') events.push(ev);
  }
  return {
    events,
    rows: listings.data.length,
    totalResults: typeof listings.totalResults === 'number' ? listings.totalResults : listings.data.length,
    warnings: messages.map((m) => `RA GraphQL partial error: ${m}`),
  };
}

/**
 * RA fills venue.location with placeholders when the club has not been geocoded: (41,-74) for older
 * venues and (0,0) for recently created ones (both seen live for NYC). Neither is a real position.
 */
export function normalizeCoords(loc: { latitude?: number | null; longitude?: number | null } | null | undefined): { lat: number; lng: number } | null {
  const lat = loc?.latitude, lng = loc?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 41 && lng === -74) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

interface PriceSummary {
  prices: PriceTier[];
  priceMin: number | null;
  priceMax: number | null;
  feesIncluded: boolean | null;
  soldOut: boolean | null;
  currency: string;
}

/**
 * priceRetail already includes RA's booking fee, so tiers are all-in. The headline price prefers tiers that
 * are actually buyable (VALID); when nothing is on sale (past releases, RSVP closed) fall back to every tier,
 * and only then to the promoter's free-text `cost`. Sold out means every tier says SOLDOUT — an event whose
 * tiers are merely NOLONGERONSALE may still be selling at the door.
 */
export function summarizePrices(tickets: RaTicket[] | null | undefined, cost: string | null | undefined): PriceSummary {
  const tiers = (tickets ?? []).filter((t): t is RaTicket => !!t);
  const prices: PriceTier[] = tiers.map((t) => ({
    tier: (t.title ?? '').trim() || 'GA',
    price: typeof t.priceRetail === 'number' && Number.isFinite(t.priceRetail) ? t.priceRetail : null,
    feesIncluded: true,
    available: t.validType === 'VALID',
    note: t.validType ?? null,
  }));
  const priced = prices.filter((p): p is PriceTier & { price: number } => p.price !== null);
  const pool = priced.some((p) => p.available) ? priced.filter((p) => p.available) : priced;
  let priceMin: number | null, priceMax: number | null;
  if (pool.length) {
    priceMin = Math.min(...pool.map((p) => p.price));
    priceMax = Math.max(...pool.map((p) => p.price));
  } else {
    [priceMin, priceMax] = parseMoneyRange(cost);
  }
  return {
    prices,
    priceMin,
    priceMax,
    feesIncluded: prices.length ? true : null,
    soldOut: prices.length ? tiers.every((t) => t.validType === 'SOLDOUT') : null,
    currency: tiers.find((t) => t.currency?.code)?.currency?.code ?? 'USD',
  };
}

const names = (xs: Array<{ name?: string | null }> | null | undefined): string[] =>
  (xs ?? []).map((x) => (x?.name ?? '').trim()).filter((s) => s.length > 0);

/** RA event -> NormalizedListing. Pure; the fixture tests exercise it offline. */
export function normalizeEvent(ev: RaEvent): NormalizedListing {
  const venue = ev.venue ?? null;
  // startTime/endTime are LocalDateTime in the venue's zone with no offset; the area tells us which zone.
  const tz = venue?.area?.ianaTimeZone || NY_TZ;
  const start = ev.startTime ? zonedToUtc(ev.startTime, tz) : null;
  const end = ev.endTime ? zonedToUtc(ev.endTime, tz) : null;
  const coords = normalizeCoords(venue?.location);
  const price = summarizePrices(ev.tickets, ev.cost);
  const images = (ev.images ?? []).filter((i) => !!i?.filename);
  const flyer = images.find((i) => i.type === 'FLYERFRONT') ?? images[0];
  const blurb = cleanText(ev.pick?.blurb);
  const setStatus = ev.setTimes?.status ?? null;
  const contentUrl = ev.contentUrl || `/events/${ev.id}`;

  const sourceTags: Record<string, unknown> = {
    ra_genre_slugs: (ev.genres ?? []).map((g) => g?.slug).filter((s): s is string => !!s),
    is_festival: ev.isFestival === true,
    is_pick: !!ev.pick,
    set_times_status: setStatus,
    ticketing: ev.isTicketed ?? null,
    date_updated: ev.dateUpdated ?? null,
  };
  // Set times are only meaningful once the promoter publishes them; SET means entered but hidden.
  if (setStatus === 'PUBLIC' && ev.setTimes?.lineup) sourceTags.set_times_lineup = ev.setTimes.lineup;
  // The venue name stays (RA shows it as "Secret location" or the promoter's placeholder) but must not be trusted for geocoding.
  if (ev.hasSecretVenue === true) sourceTags.secret_venue = true;

  return baseListing({
    source: 'ra',
    sourceId: ev.id,
    sourceUrl: `https://ra.co${contentUrl}`,
    raw: ev,
    title: ev.title.replace(/\s+/g, ' ').trim(),
    startsAt: iso(start),
    endsAt: iso(end),
    hasTime: start !== null,
    night: start ? nightDate(start, tz) : (ev.date?.slice(0, 10) ?? null),
    venueName: venue?.name?.trim() || null,
    venueAddress: venue?.address?.trim() || null,
    venueSourceId: venue?.id ?? null,
    venueLat: coords?.lat ?? null,
    venueLng: coords?.lng ?? null,
    lineup: names(ev.artists),
    priceMin: price.priceMin,
    priceMax: price.priceMax,
    currency: price.currency,
    feesIncluded: price.feesIncluded,
    priceNote: ev.cost?.trim() || null,
    prices: price.prices,
    soldOut: price.soldOut,
    // "[CANCELLED]" / "POSTPONED" prefixes are recognised by title_status_flag() in SQL, not here.
    status: 'scheduled',
    ageMin: typeof ev.minimumAge === 'number' ? ev.minimumAge : null,
    genres: names(ev.genres),
    promoters: names(ev.promoters),
    description: blurb || null,
    imageUrl: flyer?.filename ?? null,
    interestedCount: typeof ev.interestedCount === 'number' ? ev.interestedCount : null,
    sourceTags,
  });
}

// ---- fetching ----------------------------------------------------------------------------------------

export type PageFetcher = (variables: RaListingsVariables, ctx: FetchContext) => Promise<RaListingsBody>;

/** One POST to the GraphQL endpoint. postJson adds the browser UA, JSON headers, throttle, retries and block detection. */
export const fetchListingsPage: PageFetcher = (variables, ctx) =>
  postJson<RaListingsBody>(
    RA_GRAPHQL_URL,
    { operationName: 'GET_EVENT_LISTINGS', variables, query: GET_EVENT_LISTINGS },
    { minIntervalMs: MIN_INTERVAL_MS, timeoutMs: 30_000, signal: ctx.signal },
  );

export function areaIdFrom(e: FetchContext['env']): number {
  const raw = env('NOCT_RA_AREA_ID', String(RA_DEFAULT_AREA_ID), e) as string;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`NOCT_RA_AREA_ID must be a positive integer, got "${raw}"`);
  return id;
}

/**
 * Walk the listing pages for [fromDate, toDate]. `deps` exist so tests can drive the pager offline;
 * production uses the defaults. Events are de-duplicated by id because a multi-day event is listed once per
 * day and because scores can shift between page requests.
 */
export async function collectListings(ctx: FetchContext, deps: { fetchPage?: PageFetcher; pageSize?: number } = {}): Promise<FetchResult> {
  const fetchPage = deps.fetchPage ?? fetchListingsPage;
  const areaId = areaIdFrom(ctx.env);
  const limit = ctx.limit && ctx.limit > 0 ? Math.floor(ctx.limit) : undefined;
  // Smoke tests with --limit 5 should not pull 100 rows; otherwise take the biggest page RA allows.
  const pageSize = Math.max(1, Math.min(RA_PAGE_SIZE_MAX, deps.pageSize ?? limit ?? RA_PAGE_SIZE_MAX));
  const warnings: string[] = [];
  const byId = new Map<string, NormalizedListing>();
  let page = 1;
  let seen = 0;
  let hasMore = true;
  let capped = false;

  while (hasMore && !capped) {
    if (page > MAX_PAGES) {
      warnings.push(`stopped after ${MAX_PAGES} pages; enumeration incomplete`);
      break;
    }
    const body = await fetchPage(buildVariables({ areaId, fromDate: ctx.fromDate, toDate: ctx.toDate, page, pageSize }), ctx);
    const parsed = parseListingsPage(body);
    warnings.push(...parsed.warnings);
    seen += parsed.rows;
    for (const ev of parsed.events) {
      if (limit !== undefined && byId.size >= limit) { capped = true; break; }
      if (!byId.has(ev.id)) byId.set(ev.id, normalizeEvent(ev));
    }
    // Count raw rows, not parsed events: a row whose event is null (RA hides withdrawn events that way) must
    // not make a full page look short, or the walk would stop early while still claiming a complete window.
    hasMore = parsed.rows === pageSize && seen < parsed.totalResults;
    if (limit !== undefined && byId.size >= limit && hasMore) capped = true;
    ctx.log.info('page fetched', { page, events: parsed.events.length, totalResults: parsed.totalResults, collected: byId.size });
    page++;
  }

  const complete = !hasMore && !capped;
  return {
    listings: [...byId.values()],
    // Tombstoning needs a window we truly enumerated; a capped or aborted walk cannot promise that.
    window: complete ? { start: ctx.fromDate, end: ctx.toDate } : null,
    warnings,
  };
}

export const ra: SourceAdapter = {
  key: 'ra',
  displayName: 'Resident Advisor',
  kind: 'api',
  priority: 90,
  feesIncludedDefault: true,
  tosNote:
    'Undocumented public GraphQL endpoint (POST https://ra.co/graphql, operation GET_EVENT_LISTINGS) that the ra.co web app itself uses; no key or cookie is involved. ' +
    'RA\'s Terms of Use (3 April 2025) clause 4.4(a) prohibits using automated systems to extract content or data from the website for commercial purposes without a written agreement with RA, and 4.4(f) prohibits accessing the website by means not authorised in writing, including scripts, bots, crawlers and scrapers; ' +
    'robots.txt disallows /api/, /pro/, /user/ and /widget (not /graphql) and lists ClaudeBot, anthropic-ai and GPTBot among disallowed agents, and the HTML pages are behind DataDome. ' +
    'NOCT therefore calls only the GraphQL endpoint, server-side, at most once per 1.5 s with a plain browser User-Agent, never requests HTML pages and stops at the first block response. ' +
    'Written permission from Resident Advisor Ltd should be sought before this adapter runs on a schedule or its data is shown commercially.',
  enabled: () => ({ ok: true }),
  fetch: (ctx) => collectListings(ctx),
};
