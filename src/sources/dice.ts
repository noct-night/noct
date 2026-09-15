/**
 * DICE — partner Events API v2 (GET https://partners-endpoint.dice.fm/api/v2/events).
 *
 * Governance. Two keys can drive the same `x-api-key` header on the same partner host:
 *   - DICE_API_KEY       — a key DICE issues to NOCT (partner / widget programme). The clean path.
 *   - DICE_FRONTEND_KEY  — the public key DICE embeds in every dice.fm page (its `EVENTS_API_KEY`). Using it
 *                          for a scheduled aggregator is automated access DICE's US Terms §8.4 do not permit;
 *                          the project owner has chosen this path knowingly (docs/sources/dice.md records the
 *                          decision). The owner supplies the value from the page via env — NOCT never scrapes
 *                          dice.fm HTML to harvest it, never hardcodes it, and prefers DICE_API_KEY when both
 *                          are set. Calls go only to the partner host partners-endpoint.dice.fm (the host the
 *                          official widget uses); we never follow links.next to the Cloudflare-fronted
 *                          events-api.dice.fm, and when a host blocks, politeFetch throws BlockedError and the
 *                          run records it — nothing here tries to get around a challenge.
 *
 * Source quirks that shape the code below (all verified live 2026-09-13, see docs/sources/dice.md):
 *  - No date-range filter exists. Results come back date-ascending and already exclude past events, so we
 *    page from page 1 and stop once a whole page starts after the requested window.
 *  - `links.next` points at events-api.dice.fm (Cloudflare bot management). We never follow it; every page
 *    URL is built here against the partner host.
 *  - "New York" and "Brooklyn" are separate DICE cities, and the city filter occasionally leaks a far-away
 *    event (a Giza festival appeared under New York) — hence the state / bounding-box check.
 *  - The city feed carries everything DICE sells in NYC (gigs, comedy, theatre). NOCT is a club feed, so
 *    only music:dj / music:party events (or dj:* / party:* genre tags) are kept; the rest are counted.
 *  - Prices are integer cents with an all-in `total` plus `face_value` and `fees`; `sold_out` exists per
 *    ticket type and per event.
 */
import type { Env } from '../lib/env.js';
import { env } from '../lib/env.js';
import { fetchJson, HttpError } from '../lib/http.js';
import { cents, cleanText, parseAge, uniq } from '../lib/normalize.js';
import { NY_TZ, iso, localDatePlus, localMidnight, nightDate, parseWhen } from '../lib/time.js';
import { CITIES, enabledCityKeys, getCity, type DiceTarget } from '../lib/cities.js';
import type { FetchContext, FetchResult, ListingStatus, NormalizedListing, PriceTier, SourceAdapter } from './types.js';
import { baseListing } from './types.js';

export const DICE_EVENTS_URL = 'https://partners-endpoint.dice.fm/api/v2/events';
export const PAGE_SIZE = 100;
export const KEY_MISSING = 'no DICE key set (DICE_API_KEY or DICE_FRONTEND_KEY) — see docs/sources/dice.md';

/**
 * Resolve the x-api-key value and which kind it is. DICE_API_KEY (issued) wins over DICE_FRONTEND_KEY (the
 * public page key) when both are present. Never logs or returns the key itself outside the request header.
 */
export function resolveKey(e: Env): { key: string; kind: 'issued' | 'frontend' } | null {
  const issued = env('DICE_API_KEY', undefined, e);
  if (issued) return { key: issued, kind: 'issued' };
  const frontend = env('DICE_FRONTEND_KEY', undefined, e);
  if (frontend) return { key: frontend, kind: 'frontend' };
  return null;
}
/** DICE lists a few hundred upcoming NYC events; 30 pages (3,000) is a runaway guard, not a target. */
const MAX_PAGES = 30;
/** NYC's own target, kept as the default so every existing call site and test keeps its meaning. */
const NYC = CITIES.find((c) => c.key === 'nyc')!.dice as DiceTarget;
/** Rough NYC metro box: Staten Island to the north Bronx, Newark to Nassau. Catches events whose `state` is not literally 'New York'. */
export const NYC_BBOX = NYC.bbox;
const CLUB_TYPE_TAGS = new Set(['music:dj', 'music:party']);
const CLUB_GENRE_PREFIXES = ['dj:', 'party:'];
/** The event-type words DICE also uses as a genre placeholder ('dj:dj' = "a DJ set") — not genres. */
const TYPE_WORDS = new Set(['dj', 'party', 'gig']);
/** DICE writes some compound genres without a separator; split them so 'dj:afrohouse' and 'party:afro_house' agree. */
const COMPOUND_GENRES: Record<string, string> = {
  afrohouse: 'afro house',
  deephouse: 'deep house',
  melodictechno: 'melodic techno',
  progressivehouse: 'progressive house',
  hiphop: 'hip hop',
};

// ---- payload shape (the subset we read; everything else rides along in `raw`) --------------------------

export interface DiceTicketType {
  name?: string | null;
  /** integer cents */
  price?: { total?: number | null; fees?: number | null; face_value?: number | null } | null;
  sold_out?: boolean | null;
}
export interface DiceArtist { name?: string | null; headliner?: boolean | null }
export interface DiceVenue { id?: number | string | null; name?: string | null }
export interface DiceEvent {
  id: string;
  int_id?: number | null;
  hash?: string | null;
  perm_name?: string | null;
  name?: string | null;
  status?: string | null;
  flags?: string[] | null;
  sold_out?: boolean | null;
  /** UTC ISO instants */
  date?: string | null;
  date_end?: string | null;
  is_multi_days_event?: boolean | null;
  tags?: string[] | null;
  genre_tags?: string[] | null;
  type_tags?: string[] | null;
  artists?: string[] | null;
  detailed_artists?: DiceArtist[] | null;
  lineup?: unknown[] | null;
  age_limit?: string | null;
  description?: string | null;
  raw_description?: string | null;
  presented_by?: string | null;
  promoters?: { name?: string | null }[] | null;
  venue?: string | null;
  venues?: DiceVenue[] | null;
  address?: string | null;
  location?: { state?: string | null; lat?: number | null; lng?: number | null } | null;
  currency?: string | null;
  ticket_types?: DiceTicketType[] | null;
  bundles?: { name?: string | null }[] | null;
  event_images?: { landscape?: string | null; square?: string | null } | null;
  checksum?: string | null;
  /** stripped from `raw`: bulky and irrelevant to a listing */
  spotify_tracks?: unknown;
  apple_music_tracks?: unknown;
  images?: unknown;
  [extra: string]: unknown;
}
export interface DiceEventsPage {
  data: DiceEvent[];
  links?: { self?: string | null; next?: string | null } | null;
}

// ---- pure helpers (exported so the unit tests run offline on the fixture) ------------------------------

/** Page URL against the partner host. URLSearchParams encodes the bracketed keys exactly as the widget does. */
export function buildEventsUrl(page: number, names: readonly string[] = NYC.names): string {
  const q = new URLSearchParams();
  q.set('page[size]', String(PAGE_SIZE));
  for (const city of names) q.append('filter[cities][]', city);
  q.append('filter[flags][]', 'going_ahead');
  q.set('page[number]', String(page));
  return `${DICE_EVENTS_URL}?${q}`;
}

export function parseEventsPayload(payload: unknown): DiceEvent[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    throw new Error(`DICE: unexpected payload shape (no data[]): ${JSON.stringify(payload)?.slice(0, 200)}`);
  }
  return data.filter((e): e is DiceEvent => !!e && typeof e === 'object' && typeof (e as DiceEvent).id === 'string');
}

/** Rule (a): `location.state` matches the target, or the coordinates fall inside its metro box. */
export function isInTarget(e: DiceEvent, t: DiceTarget = NYC): boolean {
  const loc = e.location;
  if (loc?.state === t.state) return true;
  const { lat, lng } = loc ?? {};
  return typeof lat === 'number' && typeof lng === 'number'
    && lat >= t.bbox.latMin && lat <= t.bbox.latMax && lng >= t.bbox.lngMin && lng <= t.bbox.lngMax;
}
export const isInNewYork = (e: DiceEvent): boolean => isInTarget(e, NYC);

/** Rule (c): DJ / party by event type, or any dj:* / party:* genre tag (promoters sometimes leave type_tags empty). */
export function isClubEvent(e: DiceEvent): boolean {
  return (e.type_tags ?? []).some((t) => CLUB_TYPE_TAGS.has(t))
    || (e.genre_tags ?? []).some((g) => CLUB_GENRE_PREFIXES.some((p) => g.startsWith(p)));
}

/** [fromDate 00:00, toDate 24:00) in the city's own clock, as UTC instants. */
export interface NightWindow { startUtc: Date; endUtc: Date }
export function nightWindow(fromDate: string, toDate: string, tz: string = NY_TZ): NightWindow {
  return {
    startUtc: localMidnight(fromDate, tz),
    endUtc: localMidnight(localDatePlus(1, tz, localMidnight(toDate, tz)), tz),
  };
}

/**
 * Rule (b): the event overlaps the window. `date_end` (falling back to `date`) must reach the window start and
 * `date` must precede its end, so a season pass that started months ago still counts while it runs.
 * Returns null when `date` is unparsable.
 */
export function overlapsWindow(e: DiceEvent, w: NightWindow): boolean | null {
  const start = parseWhen(e.date);
  if (!start) return null;
  const end = parseWhen(e.date_end) ?? start;
  return end.getTime() >= w.startUtc.getTime() && start.getTime() < w.endUtc.getTime();
}

export interface DropCounts { outsideNy: number; undated: number; outsideWindow: number; nonClub: number }
export interface Selection { kept: DiceEvent[]; dropped: DropCounts }

/** Apply rules (a) → (b) → (c) in that order so "non-club" counts only NYC events inside the window. */
export function selectEvents(events: DiceEvent[], w: NightWindow, t: DiceTarget = NYC): Selection {
  const kept: DiceEvent[] = [];
  const dropped: DropCounts = { outsideNy: 0, undated: 0, outsideWindow: 0, nonClub: 0 };
  for (const e of events) {
    if (!isInTarget(e, t)) { dropped.outsideNy++; continue; }
    const overlap = overlapsWindow(e, w);
    if (overlap === null) { dropped.undated++; continue; }
    if (!overlap) { dropped.outsideWindow++; continue; }
    if (!isClubEvent(e)) { dropped.nonClub++; continue; }
    kept.push(e);
  }
  return { kept, dropped };
}

/** Flags carry the lifecycle; `status` is only on-sale / off-sale. */
export function parseStatus(flags: string[] | null | undefined): ListingStatus {
  const f = new Set(flags ?? []);
  if (f.has('cancelled')) return 'cancelled';
  if (f.has('postponed')) return 'postponed';
  if (f.has('rescheduled')) return 'rescheduled';
  return 'scheduled';
}

/** 'dj:tech-house' → 'tech house', 'party:afro_house' → 'afro house', 'genre:hiphop' → 'hip hop'; null for non-genres. */
export function genreFromTag(tag: string): string | null {
  const suffix = tag.slice(tag.indexOf(':') + 1).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!suffix || TYPE_WORDS.has(suffix)) return null;
  return COMPOUND_GENRES[suffix.replace(/ /g, '')] ?? suffix;
}

/** Distinct genre labels in DICE's vocabulary: genre_tags suffixes first, then the coarser editorial `genre:*` tags. */
export function diceGenres(e: DiceEvent): string[] {
  const labels = [
    ...(e.genre_tags ?? []).map(genreFromTag),
    ...(e.tags ?? []).filter((t) => t.startsWith('genre:')).map(genreFromTag),
  ];
  return uniq(labels.filter((g): g is string => g !== null));
}

/** Headliners first (stable sort keeps DICE's order within each group); plain `artists` strings as fallback. */
export function diceLineup(e: DiceEvent): string[] {
  const detailed = (e.detailed_artists ?? []).filter((a) => cleanText(a.name));
  const names = detailed.length
    ? [...detailed].sort((a, b) => Number(!!b.headliner) - Number(!!a.headliner)).map((a) => cleanText(a.name))
    : (e.artists ?? []).map((a) => cleanText(a));
  return uniq(names.filter(Boolean));
}

const dollars = (c: number): string => (Math.round(c) / 100).toFixed(2).replace(/\.00$/, '');

/** Tiers in dollars (DICE totals are all-in); min/max over tiers still on sale, else over every tier. */
export function dicePrices(e: DiceEvent): { prices: PriceTier[]; priceMin: number | null; priceMax: number | null } {
  const prices: PriceTier[] = (e.ticket_types ?? []).map((t) => {
    const total = t.price?.total;
    const face = t.price?.face_value;
    const fees = t.price?.fees ?? 0;
    return {
      tier: cleanText(t.name) || 'Ticket',
      price: typeof total === 'number' ? cents(total) : null,
      feesIncluded: true,
      available: !t.sold_out,
      note: typeof face === 'number' ? `face $${dollars(face)}${fees > 0 ? ` + $${dollars(fees)} fees` : ''}` : null,
    };
  });
  const priced = prices.filter((p) => p.price !== null);
  const pool = priced.some((p) => p.available) ? priced.filter((p) => p.available) : priced;
  const values = pool.map((p) => p.price as number);
  return {
    prices,
    priceMin: values.length ? Math.min(...values) : null,
    priceMax: values.length ? Math.max(...values) : null,
  };
}

export function normalizeEvent(e: DiceEvent, city = 'nyc'): NormalizedListing {
  const { spotify_tracks: _spotify, apple_music_tracks: _apple, images: _images, ...raw } = e;
  const hash = e.hash?.trim() || null;
  const sourceId = hash ?? e.id;
  // Canonical web URL is hash-permname; the bare id also resolves, so it is the fallback when hash is missing.
  const sourceUrl = hash ? `https://dice.fm/event/${hash}${e.perm_name ? `-${e.perm_name}` : ''}` : `https://dice.fm/event/${e.id}`;
  const start = parseWhen(e.date);
  const end = parseWhen(e.date_end);
  const venue0 = e.venues?.[0];
  const { prices, priceMin, priceMax } = dicePrices(e);
  return baseListing({
    source: 'dice',
    city,
    sourceId,
    sourceUrl,
    raw,
    title: cleanText(e.name) || sourceId,
    startsAt: iso(start),
    endsAt: iso(end),
    hasTime: start !== null,
    night: start ? nightDate(start) : null,
    venueName: cleanText(venue0?.name) || cleanText(e.venue) || null,
    venueAddress: cleanText(e.address) || null,
    venueSourceId: venue0?.id === undefined || venue0.id === null ? null : String(venue0.id),
    venueLat: typeof e.location?.lat === 'number' ? e.location.lat : null,
    venueLng: typeof e.location?.lng === 'number' ? e.location.lng : null,
    lineup: diceLineup(e),
    priceMin,
    priceMax,
    currency: e.currency?.toUpperCase() || 'USD',
    feesIncluded: prices.length ? true : null,
    prices,
    soldOut: typeof e.sold_out === 'boolean' ? e.sold_out : null,
    status: parseStatus(e.flags),
    ageMin: parseAge(e.age_limit),
    genres: diceGenres(e),
    promoters: uniq((e.promoters ?? []).map((p) => cleanText(p.name)).filter(Boolean)),
    externalRefs: [],
    description: cleanText(e.description) || null,
    imageUrl: e.event_images?.landscape ?? e.event_images?.square ?? null,
    sourceTags: {
      dice_id: e.id,
      int_id: e.int_id ?? null,
      status: e.status ?? null,
      checksum: e.checksum ?? null,
      dice_type_tags: e.type_tags ?? [],
      dice_genre_tags: e.genre_tags ?? [],
      dice_tags: e.tags ?? [],
      dice_flags: e.flags ?? [],
      presented_by: e.presented_by ?? null,
      lineup_times: e.lineup ?? [],
      bundles: (e.bundles ?? []).map((b) => b.name).filter((n): n is string => !!n),
      is_multi_days_event: e.is_multi_days_event ?? false,
      raw_description: e.raw_description ?? null,
    },
  });
}

// ---- adapter -------------------------------------------------------------------------------------------

function enabled(e: Env): { ok: true } | { ok: false; reason: string } {
  return resolveKey(e) ? { ok: true } : { ok: false, reason: KEY_MISSING };
}

interface Page {
  events: DiceEvent[];
  /** `data.length === page[size]` on the wire — the only signal that another page may exist. Counted before
   * parseEventsPayload drops malformed entries, so one bad row cannot end the walk early with a "complete" window. */
  full: boolean;
}

async function fetchPage(page: number, key: string, ctx: FetchContext, names: readonly string[] = NYC.names): Promise<Page> {
  try {
    const body = await fetchJson<DiceEventsPage>(buildEventsUrl(page, names), {
      headers: { 'x-api-key': key },
      minIntervalMs: 1_000,
      signal: ctx.signal,
    });
    const events = parseEventsPayload(body);
    return { events, full: body.data.length >= PAGE_SIZE };
  } catch (err) {
    // A rejected key is a configuration problem, not a transient one; say so. Blocks (BlockedError) pass through untouched.
    // The frontend key rotates with dice.fm deploys, so 401/403 there usually means "re-read it from the page".
    if (err instanceof HttpError && err.name === 'HttpError' && (err.status === 401 || err.status === 403)) {
      throw new Error(`DICE rejected the key (HTTP ${err.status}); refresh DICE_API_KEY / DICE_FRONTEND_KEY — see docs/sources/dice.md`);
    }
    throw err;
  }
}

/** Enabled cities DICE is configured for, in NOCT_CITIES order. */
export function diceTargets(e: FetchContext['env']): { city: string; tz: string; target: DiceTarget }[] {
  return enabledCityKeys(e)
    .map((k) => getCity(k))
    .filter((c) => c.dice)
    .map((c) => ({ city: c.key, tz: c.tz, target: c.dice as DiceTarget }));
}

async function fetch(ctx: FetchContext): Promise<FetchResult> {
  const resolved = resolveKey(ctx.env);
  if (!resolved) throw new Error(KEY_MISSING);
  const key = resolved.key;
  ctx.log.info('dice key in use', { kind: resolved.kind });
  const targets = diceTargets(ctx.env);
  if (!targets.length) return { listings: [], window: null, warnings: ['no enabled city has DICE targeting'] };
  const all: NormalizedListing[] = [];
  const warnings: string[] = [];
  let complete = true;
  for (const t of targets) {
    const remaining = ctx.limit === undefined ? undefined : ctx.limit - all.length;
    if (remaining !== undefined && remaining <= 0) { complete = false; break; }
    const r = await fetchCity(t, key, ctx, remaining);
    all.push(...r.listings);
    warnings.push(...r.warnings.map((w) => `${t.city}: ${w}`));
    if (!r.complete) complete = false;
  }
  return { listings: all, window: complete ? { start: ctx.fromDate, end: ctx.toDate } : null, warnings };
}

async function fetchCity(
  t: { city: string; tz: string; target: DiceTarget },
  key: string,
  ctx: FetchContext,
  limit: number | undefined,
): Promise<{ listings: NormalizedListing[]; warnings: string[]; complete: boolean }> {
  const w = nightWindow(ctx.fromDate, ctx.toDate, t.tz);
  const listings = new Map<string, NormalizedListing>();
  const dropped: DropCounts = { outsideNy: 0, undated: 0, outsideWindow: 0, nonClub: 0 };
  const warnings: string[] = [];
  /** false once we stop before the API runs dry (limit, page cap, stalled pagination) — then no tombstone window */
  let complete = true;
  /** date-ascending so far; only then may we stop once a whole page starts after the window */
  let ordered = true;
  let lastStart = -Infinity;
  let prevIds = '';

  for (let page = 1; ; page++) {
    const { events, full } = await fetchPage(page, key, ctx, t.target.names);
    // An identical page means page[number] was ignored: stop rather than loop to the cap. (A single repeated
    // event is normal — new events shift the boundary between pages while we walk them.)
    const ids = events.map((e) => e.id).join(',');
    if (page > 1 && ids === prevIds) {
      warnings.push(`pagination stalled at page ${page} (page[number] ignored?)`);
      complete = false;
      break;
    }
    prevIds = ids;

    const sel = selectEvents(events, w, t.target);
    for (const k of Object.keys(dropped) as (keyof DropCounts)[]) dropped[k] += sel.dropped[k];
    // New events can shift pages while we walk them; keep the first copy of each hash.
    for (const e of sel.kept) {
      const l = normalizeEvent(e, t.city);
      if (!listings.has(l.sourceId)) listings.set(l.sourceId, l);
    }
    for (const e of events) {
      const at = parseWhen(e.date)?.getTime();
      if (at === undefined) continue;
      if (at < lastStart) ordered = false;
      lastStart = at;
    }
    ctx.log.info('page', { page, events: events.length, kept: listings.size, ...sel.dropped });

    if (!full) break;
    if (limit !== undefined && listings.size >= limit) { complete = false; break; }
    if (ordered && lastStart >= w.endUtc.getTime()) break;
    if (page >= MAX_PAGES) {
      warnings.push(`stopped after ${MAX_PAGES} pages with more available`);
      complete = false;
      break;
    }
  }

  let out = [...listings.values()];
  if (limit !== undefined && out.length > limit) {
    out = out.slice(0, limit);
    complete = false;
  }
  if (dropped.nonClub) warnings.push(`dropped ${dropped.nonClub} non-club events (gigs, culture)`);
  if (dropped.outsideNy) warnings.push(`dropped ${dropped.outsideNy} events outside ${t.target.state} (city filter leak)`);
  if (dropped.undated) warnings.push(`dropped ${dropped.undated} events without a parsable date`);
  ctx.log.info('done', { city: t.city, listings: out.length, ...dropped, complete });
  return { listings: out, warnings, complete };
}

export const dice: SourceAdapter = {
  key: 'dice',
  displayName: 'DICE',
  kind: 'api',
  priority: 80,
  feesIncludedDefault: true,
  tosNote:
    'DICE US Terms of Use (10 Mar 2026) §4.2 license the App and Services for personal, non-commercial use only and §8.4 forbid automated crawling and commercial exploitation of their content. NOCT reads only the partner Events API (partners-endpoint.dice.fm/api/v2/events, the host DICE\'s own widget uses) with an x-api-key: DICE_API_KEY if DICE issued one, otherwise DICE_FRONTEND_KEY — the public key DICE ships in every dice.fm page, which the project owner supplies from the page and has opted to use knowingly despite §8.4. NOCT never scrapes dice.fm HTML, never follows links.next to the Cloudflare-fronted events-api host, and stops on any block. A DICE-issued key remains the clean path (help@dice.fm / dice.fm/partners); see docs/sources/dice.md.',
  enabled,
  fetch,
};
