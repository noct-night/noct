/**
 * Ticketmaster Discovery API v2 — official, key-gated (free consumer key from developer.ticketmaster.com).
 *
 * Coverage is Ticketmaster / Live Nation / Universe / Front Gate inventory only: Brooklyn Steel, Terminal 5,
 * Irving Plaza, Brooklyn Paramount, arena-scale EDM. Whether TicketWeb-sold rooms (Knockdown Center) appear is
 * unverified. Underground clubs are RA / DICE territory, so this source sits at priority 50.
 *
 * Quotas (docs fetched 2026-09-13): 5000 calls/day and 5 requests/second per key -> 250 ms spacing plus a hard
 * per-run request cap. Deep paging: "we only support retrieving the 1000th item, i.e. size * page < 1000" -> a
 * range holding more than 1000 events is re-queried in 7-night windows (planWindows()).
 *
 * Source quirks that shape the code below:
 *  - status codes are spelled `canceled` in the docs enum (onsale, offsale, canceled, postponed, rescheduled);
 *    both spellings are accepted.
 *  - `dates.start.dateTime` is omitted when timeTBA / noSpecificTime, leaving only `localDate` -> hasTime=false.
 *  - `dates.end` exists but is flagged `approximate` for most concerts, so endsAt stays null.
 *  - venue location.latitude / longitude are strings.
 *  - classificationName matches names anywhere in the taxonomy, so the primary segment is re-checked in parse.
 *  - priceRanges are face value ("standard") unless the type says "including fees"; sold-out is not exposed.
 *  - TM rejects ISO instants with fractional seconds; the query bounds are formatted without them.
 */
import { env, requireEnv, type Env } from '../lib/env.js';
import { fetchJson } from '../lib/http.js';
import { parseAge, uniq } from '../lib/normalize.js';
import { NY_TZ, iso, localDatePlus, localMidnight, nightDate, parseWhen } from '../lib/time.js';
import {
  baseListing,
  type FetchContext,
  type FetchResult,
  type ListingStatus,
  type NormalizedListing,
  type PriceTier,
  type SourceAdapter,
} from './types.js';

export const TM_EVENTS_URL = 'https://app.ticketmaster.com/discovery/v2/events.json';
/** Ticketmaster DMA 345 = New York. It spans NY, NJ and slices of CT/PA, hence the state filter in parse. */
export const TM_NYC_DMA_ID = 345;
/** Genre name under the Music segment (genre id KnvZfZ7vAvF). */
export const TM_CLASSIFICATION = 'Dance/Electronic';
/** Documented maximum page size. */
export const TM_PAGE_SIZE = 200;
/** Deep-paging rule size * page < 1000: pages 0..4 of 200 are the most one query can ever return. */
export const TM_MAX_PAGES = 5;
export const TM_MAX_ITEMS = TM_PAGE_SIZE * TM_MAX_PAGES;
/** A range that overflows TM_MAX_ITEMS is re-queried in windows of this many nights. */
export const TM_SPLIT_DAYS = 7;
/** 5 req/s per key. */
export const TM_MIN_INTERVAL_MS = 250;
/** 40 x 200 = 8000 rows per run, an order of magnitude above a month of NYC dance listings, well under 5000/day. */
export const TM_MAX_REQUESTS_PER_RUN = 40;

const KEY_VAR = 'TICKETMASTER_API_KEY';
const KEPT_STATES = new Set(['NY', 'NJ']);
/** Nightlife day boundary, mirrors nightDate(): 06:00 local. */
const NIGHT_START_MS = 6 * 3_600_000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// ---- wire shapes (the subset we read; every field optional because TM omits what it lacks) --------------

export interface TmNamed {
  id?: string;
  name?: string;
}
export interface TmImage {
  /** "16_9" | "3_2" | "4_3" */
  ratio?: string;
  url?: string;
  width?: number;
  height?: number;
  /** true = a generic stand-in, not the event's own artwork */
  fallback?: boolean;
}
export interface TmClassification {
  primary?: boolean;
  segment?: TmNamed;
  genre?: TmNamed;
  subGenre?: TmNamed;
  type?: TmNamed;
  subType?: TmNamed;
  family?: boolean;
}
export interface TmPriceRange {
  /** "standard" | "standard including fees" | ... */
  type?: string;
  currency?: string;
  min?: number;
  max?: number;
}
export interface TmDateStart {
  /** venue-local YYYY-MM-DD */
  localDate?: string;
  /** venue-local HH:mm:ss */
  localTime?: string;
  /** UTC instant, absent when the time is TBA */
  dateTime?: string;
  dateTBD?: boolean;
  dateTBA?: boolean;
  timeTBA?: boolean;
  noSpecificTime?: boolean;
}
export interface TmVenue extends TmNamed {
  postalCode?: string;
  timezone?: string;
  city?: { name?: string };
  state?: { name?: string; stateCode?: string };
  country?: { name?: string; countryCode?: string };
  address?: { line1?: string; line2?: string };
  /** strings on the wire ("40.71773") */
  location?: { latitude?: string | number; longitude?: string | number };
}
export interface TmAttraction extends TmNamed {
  url?: string;
  classifications?: TmClassification[];
}
export interface TmEvent {
  id: string;
  name?: string;
  url?: string;
  test?: boolean;
  info?: string;
  pleaseNote?: string;
  images?: TmImage[];
  dates?: {
    start?: TmDateStart;
    end?: { localDate?: string; dateTime?: string; approximate?: boolean; noSpecificTime?: boolean };
    timezone?: string;
    status?: { code?: string };
    spanMultipleDays?: boolean;
  };
  classifications?: TmClassification[];
  priceRanges?: TmPriceRange[];
  ageRestrictions?: { legalAgeEnforced?: boolean; ageRuleDescription?: string };
  promoter?: TmNamed;
  promoters?: TmNamed[];
  _embedded?: { venues?: TmVenue[]; attractions?: TmAttraction[] };
}
export interface TmPage {
  size: number;
  totalElements: number;
  totalPages: number;
  /** zero-based */
  number: number;
}
export interface TmEventsResponse {
  _embedded?: { events?: TmEvent[] };
  page?: TmPage;
}

// ---- pure helpers (exported so the unit tests run offline) ---------------------------------------------

export function ticketmasterEnabled(e: Env): { ok: true } | { ok: false; reason: string } {
  return env(KEY_VAR, undefined, e) ? { ok: true } : { ok: false, reason: `${KEY_VAR} is not set` };
}

export interface TmQuery {
  key: string;
  startDateTime: string;
  endDateTime: string;
  page: number;
  dmaId?: number;
  size?: number;
}

export function buildTmUrl(q: TmQuery): string {
  const p = new URLSearchParams({
    apikey: q.key,
    dmaId: String(q.dmaId ?? TM_NYC_DMA_ID),
    classificationName: TM_CLASSIFICATION,
    startDateTime: q.startDateTime,
    endDateTime: q.endDateTime,
    size: String(q.size ?? TM_PAGE_SIZE),
    page: String(q.page),
    sort: 'date,asc',
  });
  return `${TM_EVENTS_URL}?${p}`;
}

/** The request URL with the consumer key masked, for logs and error messages. */
export function redactTmUrl(url: string): string {
  return url.replace(/([?&]apikey=)[^&]*/, '$1***');
}

function addDays(date: string, n: number): string {
  return localDatePlus(n, NY_TZ, localMidnight(date));
}

/** "2026-09-13T10:00:00Z" — TM rejects the ".000" that toISOString() emits. */
function tmInstant(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * UTC bounds that enumerate exactly the New York nights fromDate..toDate: 06:00 local on fromDate through
 * 05:59:59 local the morning after toDate, DST-correct. A 1 am show the morning after toDate is toDate's night.
 */
export function tmDateRange(fromDate: string, toDate: string): { startDateTime: string; endDateTime: string } {
  return {
    startDateTime: tmInstant(new Date(localMidnight(fromDate).getTime() + NIGHT_START_MS)),
    endDateTime: tmInstant(new Date(localMidnight(addDays(toDate, 1)).getTime() + NIGHT_START_MS - 1_000)),
  };
}

export interface DateWindow {
  fromDate: string;
  toDate: string;
}

/** Consecutive, non-overlapping windows of at most `days` nights covering fromDate..toDate inclusive. */
export function splitDateRange(fromDate: string, toDate: string, days: number): DateWindow[] {
  const step = Math.max(1, Math.floor(days));
  const out: DateWindow[] = [];
  for (let start = fromDate; start <= toDate; start = addDays(start, step)) {
    const end = addDays(start, step - 1);
    out.push({ fromDate: start, toDate: end < toDate ? end : toDate });
  }
  return out;
}

/** One window when the range fits under the 1000-item paging ceiling, otherwise 7-night slices. */
export function planWindows(fromDate: string, toDate: string, totalElements: number): DateWindow[] {
  return totalElements > TM_MAX_ITEMS ? splitDateRange(fromDate, toDate, TM_SPLIT_DAYS) : [{ fromDate, toDate }];
}

export function mapTmStatus(code: string | null | undefined): ListingStatus {
  switch (code?.toLowerCase()) {
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    case 'postponed':
      return 'postponed';
    case 'rescheduled':
      return 'rescheduled';
    default:
      // onsale, offsale, missing: the event is still happening as scheduled
      return 'scheduled';
  }
}

export function primaryClassification(cls: TmClassification[] | undefined): TmClassification | undefined {
  return cls?.find((c) => c.primary) ?? cls?.[0];
}

/** Distinct genre + sub-genre names of the primary classification; TM's "Undefined" placeholder is dropped. */
export function tmGenres(cls: TmClassification | undefined): string[] {
  return uniq([cls?.genre?.name, cls?.subGenre?.name].filter((n): n is string => !!n && n !== 'Undefined'));
}

/** Largest genuine 16:9 image; falls back to the largest of any ratio, then to fallback artwork. */
export function pickImage(images: TmImage[] | undefined): string | null {
  const withUrl = (images ?? []).filter((i) => !!i.url);
  const genuine = withUrl.filter((i) => !i.fallback);
  const pool = genuine.length ? genuine : withUrl;
  const wide = pool.filter((i) => i.ratio === '16_9');
  const best = [...(wide.length ? wide : pool)].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  return best?.url ?? null;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** priceRanges -> tiers. Tier names are made unique because listing_price is keyed on (listing_id, tier). */
export function toPriceTiers(ranges: TmPriceRange[] | undefined, statusCode: string | null | undefined): PriceTier[] {
  const used = new Set<string>();
  const tiers: PriceTier[] = [];
  for (const r of ranges ?? []) {
    const base = r.type?.trim() || 'standard';
    let tier = base;
    for (let i = 2; used.has(tier); i++) tier = `${base} ${i}`;
    used.add(tier);
    const min = num(r.min);
    const max = num(r.max);
    tiers.push({
      tier,
      price: min,
      feesIncluded: /including fees/i.test(base),
      available: statusCode !== 'offsale',
      note: max !== null && max !== min ? `up to $${max}` : null,
    });
  }
  return tiers;
}

function formatAddress(v: TmVenue | undefined): string | null {
  if (!v) return null;
  const region = [v.state?.stateCode, v.postalCode].filter(Boolean).join(' ');
  return [v.address?.line1, v.address?.line2, v.city?.name, region].map((s) => s?.trim() ?? '').filter(Boolean).join(', ') || null;
}

/** startsAt only when TM gives a real instant; otherwise the local date alone decides the night. */
function resolveStart(ev: TmEvent): { startsAt: Date | null; night: string | null } {
  const s = ev.dates?.start;
  const instant = s && !s.timeTBA && !s.noSpecificTime && s.dateTime ? parseWhen(s.dateTime) : null;
  if (instant) return { startsAt: instant, night: nightDate(instant) };
  return { startsAt: null, night: s?.localDate && YMD.test(s.localDate) ? s.localDate : null };
}

function skipReason(ev: TmEvent): string | null {
  if (ev.test) return 'test event';
  if (!ev.id || !ev.name?.trim()) return 'missing id or name';
  const segment = primaryClassification(ev.classifications)?.segment?.name;
  // classificationName is a name match across the whole taxonomy; Arts & Theatre > Dance can leak in
  if (segment && segment !== 'Music') return `primary segment "${segment}" is not Music`;
  const state = ev._embedded?.venues?.[0]?.state?.stateCode;
  if (state && !KEPT_STATES.has(state)) return `venue in ${state} (outside NY/NJ)`;
  return null;
}

function toListing(ev: TmEvent, startsAt: Date | null, night: string): NormalizedListing {
  const venue = ev._embedded?.venues?.[0];
  const attractions = ev._embedded?.attractions ?? [];
  const cls = primaryClassification(ev.classifications);
  const code = ev.dates?.status?.code ?? null;
  const prices = toPriceTiers(ev.priceRanges, code);
  const mins = prices.map((p) => p.price).filter((p): p is number => p !== null);
  const maxes = (ev.priceRanges ?? []).map((r) => num(r.max) ?? num(r.min)).filter((p): p is number => p !== null);
  const fees = uniq(prices.map((p) => p.feesIncluded));
  const age = ev.ageRestrictions;
  return baseListing({
    source: 'ticketmaster',
    sourceId: ev.id,
    sourceUrl: ev.url ?? null,
    raw: ev,
    title: (ev.name ?? '').trim(),
    startsAt: iso(startsAt),
    // endsAt stays null: dates.end is `approximate` for most concerts and would poison set-time reasoning
    hasTime: startsAt !== null,
    night,
    venueName: venue?.name?.trim() || null,
    venueAddress: formatAddress(venue),
    venueSourceId: venue?.id ?? null,
    venueLat: num(venue?.location?.latitude),
    venueLng: num(venue?.location?.longitude),
    lineup: uniq(attractions.map((a) => a.name?.trim() ?? '').filter(Boolean)),
    priceMin: mins.length ? Math.min(...mins) : null,
    priceMax: maxes.length ? Math.max(...maxes) : null,
    currency: ev.priceRanges?.[0]?.currency ?? 'USD',
    // one verdict only when every tier agrees; a mixed face-value / all-in pair is left undecided
    feesIncluded: fees.length === 1 ? (fees[0] ?? null) : null,
    prices,
    status: mapTmStatus(code),
    // legalAgeEnforced alone means "21+ enforced"; a written rule ("18 & over") is more specific when present
    ageMin: parseAge(age?.ageRuleDescription) ?? (age?.legalAgeEnforced ? 21 : null),
    genres: tmGenres(cls),
    promoters: uniq([ev.promoter?.name, ...(ev.promoters ?? []).map((p) => p.name)].map((n) => n?.trim() ?? '').filter(Boolean)),
    description: [ev.info, ev.pleaseNote].map((s) => s?.trim() ?? '').filter(Boolean).join('\n\n') || null,
    imageUrl: pickImage(ev.images),
    sourceTags: {
      tm_segment: cls?.segment?.name ?? null,
      tm_genre: cls?.genre?.name ?? null,
      tm_subgenre: cls?.subGenre?.name ?? null,
      tm_status: code,
      tm_attraction_ids: attractions.map((a) => a.id).filter((id): id is string => !!id),
      tm_local_date: ev.dates?.start?.localDate ?? null,
      tm_local_time: ev.dates?.start?.localTime ?? null,
      tm_timezone: ev.dates?.timezone ?? venue?.timezone ?? null,
    },
  });
}

export interface TmParsedPage {
  listings: NormalizedListing[];
  /** skip reason -> count, merged across pages by the adapter */
  skipped: Record<string, number>;
  page: TmPage | null;
}

/** Pure: one response page -> listings. Events without any usable date, outside NY/NJ or outside Music are counted, not thrown. */
export function parseTmEvents(payload: TmEventsResponse): TmParsedPage {
  const listings: NormalizedListing[] = [];
  const skipped: Record<string, number> = {};
  const count = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  for (const ev of payload._embedded?.events ?? []) {
    const reason = skipReason(ev);
    if (reason) { count(reason); continue; }
    const { startsAt, night } = resolveStart(ev);
    if (night === null) { count('no usable start date (dateTBD/dateTBA)'); continue; }
    listings.push(toListing(ev, startsAt, night));
  }
  return { listings, skipped, page: payload.page ?? null };
}

export function skipWarnings(skipped: Record<string, number>): string[] {
  return Object.entries(skipped).map(([reason, n]) => `skipped ${n} event(s): ${reason}`);
}

// ---- adapter -------------------------------------------------------------------------------------------

type WindowOutcome = 'complete' | 'overflow' | 'budget' | 'limit';

export const ticketmaster: SourceAdapter = {
  key: 'ticketmaster',
  displayName: 'Ticketmaster',
  kind: 'api',
  priority: 50,
  feesIncludedDefault: false,
  tosNote:
    'Official Discovery API v2 with a free consumer key from developer.ticketmaster.com (5000 calls/day, 5 req/s). ' +
    'Terms of Use: content may be cached only for reasonable periods to serve the app, may not be resold, and the API ' +
    'may not be used to generate revenue without written permission. Covers Ticketmaster / Live Nation inventory only; ' +
    'face-value price ranges, no sold-out flag.',
  enabled: ticketmasterEnabled,
  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const key = requireEnv(KEY_VAR, ctx.env);
    const byId = new Map<string, NormalizedListing>();
    const skipped: Record<string, number> = {};
    const warnings: string[] = [];
    let requests = 0;
    const limitReached = () => ctx.limit !== undefined && byId.size >= ctx.limit;

    const getPage = async (win: DateWindow, page: number): Promise<TmEventsResponse> => {
      requests++;
      const url = buildTmUrl({ key, page, ...tmDateRange(win.fromDate, win.toDate) });
      ctx.log.info('GET', { url: redactTmUrl(url) });
      const body = await fetchJson<TmEventsResponse>(url, { minIntervalMs: TM_MIN_INTERVAL_MS, signal: ctx.signal });
      const parsed = parseTmEvents(body);
      // pages sorted by date can repeat a row at the boundary between equal start times; last write wins
      for (const l of parsed.listings) byId.set(l.sourceId, l);
      for (const [reason, n] of Object.entries(parsed.skipped)) skipped[reason] = (skipped[reason] ?? 0) + n;
      return body;
    };

    /** Every page of one window; page 0 may already be in hand from the probe. */
    const fetchWindow = async (win: DateWindow, first?: TmEventsResponse): Promise<WindowOutcome> => {
      if (limitReached()) return 'limit';
      if (!first && requests >= TM_MAX_REQUESTS_PER_RUN) return 'budget';
      const totalPages = (first ?? (await getPage(win, 0))).page?.totalPages ?? 0;
      for (let p = 1; p < Math.min(totalPages, TM_MAX_PAGES); p++) {
        if (limitReached()) return 'limit';
        if (requests >= TM_MAX_REQUESTS_PER_RUN) return 'budget';
        await getPage(win, p);
      }
      // every page is in hand; whether the cap then trims the result is decided (and the window withheld) below
      return totalPages > TM_MAX_PAGES ? 'overflow' : 'complete';
    };

    // page 0 of the whole range doubles as the count probe that decides whether to split
    const full: DateWindow = { fromDate: ctx.fromDate, toDate: ctx.toDate };
    const probe = await getPage(full, 0);
    const total = probe.page?.totalElements ?? 0;
    const windows = planWindows(ctx.fromDate, ctx.toDate, total);
    if (windows.length > 1) {
      warnings.push(`${total} events in ${ctx.fromDate}..${ctx.toDate} exceed Ticketmaster's ${TM_MAX_ITEMS}-item paging ceiling; re-querying in ${TM_SPLIT_DAYS}-night windows`);
    }

    // Windows run in date order. The tombstone window is the contiguous run of fully paged nights from fromDate:
    // an overflowing week withholds itself and everything after it from tombstoning but is not a reason to stop
    // fetching the later weeks; only an exhausted budget or a satisfied --limit ends the run early.
    let enumeratedThrough: string | null = null;
    let contiguous = true;
    for (const [i, win] of windows.entries()) {
      const outcome = await fetchWindow(win, windows.length === 1 && i === 0 ? probe : undefined);
      if (outcome === 'complete') {
        if (contiguous) enumeratedThrough = win.toDate;
        continue;
      }
      contiguous = false;
      if (outcome === 'overflow') {
        warnings.push(`${win.fromDate}..${win.toDate} exceeds ${TM_MAX_ITEMS} events; only the first ${TM_MAX_ITEMS} were fetched`);
        continue;
      }
      if (outcome === 'budget') warnings.push(`request budget of ${TM_MAX_REQUESTS_PER_RUN} exhausted; nights fully enumerated: ${enumeratedThrough ? `${ctx.fromDate}..${enumeratedThrough}` : 'none'}`);
      break;
    }
    warnings.push(...skipWarnings(skipped));

    const all = [...byId.values()];
    const truncated = ctx.limit !== undefined && all.length > ctx.limit;
    // a window is only promised for nights that were fully enumerated AND fully handed back (tombstoning relies on it)
    const window: FetchResult['window'] = !truncated && enumeratedThrough ? { start: ctx.fromDate, end: enumeratedThrough } : null;
    ctx.log.info('done', { requests, total, listings: all.length, window });
    return { listings: truncated ? all.slice(0, ctx.limit) : all, window, warnings };
  },
};
