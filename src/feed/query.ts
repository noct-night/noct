/**
 * buildFeed(): the read side of NOCT. One round of parallel queries against the read models from
 * 0007_views_rls.sql (event_feed, event_offer) plus venue rows and per-source run status, shaped by shape.ts
 * into the JSON index.html renders.
 *
 * Nights are compared as YYYY-MM-DD text end to end: `night` is cast to text in SQL so node-postgres never turns
 * it into a local-midnight Date. The default range is tonight..tonight+2 in New York. DICE multi-day season
 * passes carry night = their start date (months back), so the night range excludes them without special-casing.
 */
import { query } from '../lib/db.js';
import { localDatePlus, NY_TZ } from '../lib/time.js';
import { CITIES, DEFAULT_CITY, findCity, type City } from '../lib/cities.js';
import {
  buildDays, genreFilterList, shapeEvent, shapeSource, shapeVenue,
  type FeedResponse, type FeedRow, type SourceRunRow, type VenueRow,
} from './shape.js';

/** A feed wider than a month is a data export, not a feed; the UI asks for three nights. */
export const MAX_RANGE_DAYS = 31;
/** Counts are one integer per night, so the month grid (up to six weeks plus slack) is allowed. */
export const MAX_COUNTS_DAYS = 62;
const DEFAULT_SPAN_DAYS = 2;

/** New York's venue.borough values as the UI's "Area" filter; matched case-insensitively. Other cities pass any area through. */
export const AREAS = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island', 'New Jersey', 'Other'] as const;

/** Bad caller input (dates, area, city). api/feed.ts turns it into a 400; anything else is a 500. */
export class FeedParamError extends Error {
  override readonly name = 'FeedParamError';
}

export interface FeedParams {
  /** inclusive YYYY-MM-DD (New York nights); default: today */
  from?: string | null;
  /** inclusive YYYY-MM-DD; default: from + 2 */
  to?: string | null;
  /** borough name or 'All' */
  area?: string | null;
  city?: string | null;
  /** include events the classifier marked is_electronic = false (concerts, comedy); default false */
  includeAll?: boolean;
  /** counts-only request (the month calendar): allows a wider range, returns no event records */
  countsOnly?: boolean;
  /** clock for the default range and the Tonight/Tomorrow hints (tests pin it) */
  now?: Date;
}

export interface ResolvedFeedParams {
  from: string;
  to: string;
  area: string | null;
  includeAll: boolean;
  city: City;
}

/** A real calendar date in YYYY-MM-DD form: the regex alone lets 2026-02-30 through, so round-trip it. */
function isCalendarDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function blank(v: string | null | undefined): v is null | undefined | '' {
  return v === null || v === undefined || v.trim() === '';
}

/** Validate + default the caller's parameters. Exported so the API handler and tests share one rule set. */
export function resolveParams(p: FeedParams = {}, now: Date = p.now ?? new Date()): ResolvedFeedParams {
  const city = blank(p.city) ? findCity(DEFAULT_CITY) : findCity(p.city);
  if (!city) throw new FeedParamError(`city "${p.city}" is unknown; one of ${CITIES.map((c) => c.key).join(', ')}`);
  for (const [key, v] of [['from', p.from], ['to', p.to]] as const) {
    if (!blank(v) && !isCalendarDate(v.trim())) throw new FeedParamError(`${key} must be a valid YYYY-MM-DD date`);
  }
  // "today" is the city's calendar date, not the server's
  const from = blank(p.from) ? localDatePlus(0, city.tz, now) : p.from.trim();
  const to = blank(p.to) ? localDatePlus(DEFAULT_SPAN_DAYS, city.tz, localMidnightOf(from)) : p.to.trim();
  const span = daysBetween(from, to);
  if (span < 0) throw new FeedParamError('to must not be before from');
  // counts carry one integer per night, so a whole calendar grid (six weeks) is still tiny
  const maxSpan = p.countsOnly ? MAX_COUNTS_DAYS : MAX_RANGE_DAYS;
  if (span >= maxSpan) throw new FeedParamError(`range must cover at most ${maxSpan} nights`);
  let area: string | null = null;
  if (!blank(p.area) && p.area.trim().toLowerCase() !== 'all') {
    const want = p.area.trim().toLowerCase();
    if (city.key === 'nyc') {
      area = AREAS.find((a) => a.toLowerCase() === want) ?? null;
      if (!area) throw new FeedParamError(`area must be one of ${AREAS.join(', ')} or All`);
    } else {
      area = p.area.trim().slice(0, 40); // other cities: whatever area labels their venues carry
    }
  }
  return { from, to, area, includeAll: p.includeAll === true, city };
}

/** Noon UTC on a date: a safe anchor for localDatePlus() that lands on the same calendar day in New York. */
function localMidnightOf(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

// Columns are listed rather than `f.*` so `night` can come back as text and a view change cannot silently
// reshape the API. Offers are aggregated per event in the order event_offer declares (available first,
// cheapest first, then source priority); shape.ts re-sorts anyway so the JSON never depends on it.
/** The select + offer aggregation of the feed, reusable with a different WHERE (recommendations). */
export const EVENTS_COLUMNS_SQL = `
  select f.event_id, f.title, f.night::text as night, f.starts_at, f.ends_at, f.has_time, f.status,
         f.venue_id, f.venue_name, f.venue_kind, f.family_id, f.family_name, f.borough, f.neighborhood, f.lat, f.lng,
         f.age_min, f.lineup, f.description, f.image_url, f.interested_count, f.genres, f.genre_source,
         f.primary_genre, f.primary_genre_label, f.genre_codes, f.genre_labels, f.genre_tags, f.genre_confidence,
         f.vibe_codes, f.vibes,
         f.energy, f.darkness, f.crowd_size, f.start_lateness, f.end_lateness, f.price_tier, f.underground_index,
         f.sound_summary, f.is_electronic, f.needs_review, f.listing_count, f.platforms, f.sources,
         f.cheapest_price, f.sold_out, f.going_count, f.city, f.tz,
         o.offers
  from event_feed f
  left join lateral (
    select jsonb_agg(jsonb_build_object(
             'platform', x.platform, 'platform_name', x.platform_name, 'platform_priority', x.platform_priority,
             'source_url', x.source_url, 'tier', x.tier, 'price', x.price, 'fees_included', x.fees_included,
             'available', x.available, 'note', x.note, 'sold_out', x.sold_out)
           order by (x.available is not false) desc, x.price nulls last, x.platform_priority desc) as offers
    from event_offer x where x.event_id = f.event_id
  ) o on true`;

const EVENTS_SQL = `${EVENTS_COLUMNS_SQL}
  where f.night between $1::date and $2::date
    and f.city = $5::text
    and ($3::text is null or f.borough = $3)
    and ($4::boolean or f.is_electronic is distinct from false)
  order by f.night, f.has_time desc, f.starts_at nulls last, lower(f.title)`;

/** Cities that have something to show (upcoming events), for the UI's city picker. */
const CITIES_SQL = `select city, count(*)::int as n from event where merged_into is null and status <> 'removed' and night >= $1::date group by city`;

/**
 * Per-night counts only — what the month calendar needs to draw its grid. A month of full event records is
 * ~320 KB gzipped; this is ~1 KB, so the grid is cheap and the day's cards are fetched when a date is tapped.
 */
const COUNTS_SQL = `
  select f.night::text as night, count(*)::int as n
  from event_feed f
  where f.night between $1::date and $2::date
    and f.city = $4::text
    and ($3::boolean or f.is_electronic is distinct from false)
  group by f.night`;

const VENUES_SQL = `
  select venue_id, name, kind, address, neighborhood, borough, instagram, website, ra_url, dice_url, verified, lat, lng
  from venue where venue_id = any($1::uuid[])`;

const SOURCES_SQL = `
  select s.source_key, s.display_name, s.enabled, r.status, r.finished_at, r.listings_seen, r.error
  from source s
  left join lateral (select * from ingest_run i where i.source_key = s.source_key order by i.started_at desc limit 1) r on true
  order by s.priority desc`;

export interface FeedCountsResponse {
  generated_at: string;
  range: { from: string; to: string };
  city: { key: string; name: string; tz: string };
  /** every night in the range, in order, with how many events it holds (0 included) */
  days: (ReturnType<typeof buildDays>[number] & { events: number })[];
  total: number;
}

/** Per-night counts for the month calendar. Same filters as buildFeed, no event records. */
export async function buildCounts(params: FeedParams = {}): Promise<FeedCountsResponse> {
  const now = params.now ?? new Date();
  const { from, to, includeAll, city } = resolveParams({ ...params, countsOnly: true }, now);
  const res = await query<{ night: string; n: number }>(COUNTS_SQL, [from, to, includeAll, city.key]);
  const counts = new Map(res.rows.map((r) => [r.night, Number(r.n)]));
  const days = buildDays(from, to, now, city.tz).map((d) => ({ ...d, events: counts.get(d.date) ?? 0 }));
  return {
    generated_at: new Date().toISOString(),
    range: { from, to },
    city: { key: city.key, name: city.name, tz: city.tz },
    days,
    total: days.reduce((a, d) => a + d.events, 0),
  };
}

export async function buildFeed(params: FeedParams = {}): Promise<FeedResponse> {
  const now = params.now ?? new Date();
  const { from, to, area, includeAll, city } = resolveParams(params, now);
  const [ev, src, cityRows] = await Promise.all([
    query<FeedRow>(EVENTS_SQL, [from, to, area, includeAll, city.key]),
    query<SourceRunRow>(SOURCES_SQL),
    query<{ city: string; n: number }>(CITIES_SQL, [localDatePlus(0, city.tz, now)]),
  ]);
  const days = buildDays(from, to, now, city.tz);
  const dayIndex = new Map(days.map((d, i) => [d.date, i]));
  const rows = ev.rows.filter((r) => dayIndex.has(r.night));
  // venues{} is keyed by the family name the events carry (room -> complex), so fetch the family rows
  const venueIds = [...new Set(rows.map((r) => r.family_id ?? r.venue_id).filter((id): id is string => !!id))];
  const vs = venueIds.length ? (await query<VenueRow>(VENUES_SQL, [venueIds])).rows : [];
  const events = rows.map((r, i) => shapeEvent(r, { n: i + 1, d: dayIndex.get(r.night) as number, tz: r.tz || city.tz }));
  const counts = new Map(cityRows.rows.map((r) => [r.city, Number(r.n)]));
  return {
    generated_at: new Date().toISOString(),
    range: { from, to },
    city: { key: city.key, name: city.name, tz: city.tz },
    cities: CITIES.map((c) => ({ key: c.key, name: c.name, tz: c.tz, events: counts.get(c.key) ?? 0, enabled: (counts.get(c.key) ?? 0) > 0 })),
    days,
    venues: Object.fromEntries(vs.map((v) => [v.name, shapeVenue(v)])),
    events,
    genres: genreFilterList(events),
    sources: src.rows.map(shapeSource),
  };
}
