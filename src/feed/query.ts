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
import {
  buildDays, genreFilterList, shapeEvent, shapeSource, shapeVenue,
  type FeedResponse, type FeedRow, type SourceRunRow, type VenueRow,
} from './shape.js';

/** A feed wider than a month is a data export, not a feed; the UI asks for three nights. */
export const MAX_RANGE_DAYS = 31;
const DEFAULT_SPAN_DAYS = 2;

/** venue.borough values (0002) as the UI's "Area" filter; matched case-insensitively. */
export const AREAS = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island', 'New Jersey', 'Other'] as const;
/** The only city NOCT serves today; adding one means a new RA area id + venue seed, not a query parameter. */
const CITY_ALIASES = new Set(['nyc', 'new york', 'new-york', 'new_york', 'new york city']);

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
  /** clock for the default range and the Tonight/Tomorrow hints (tests pin it) */
  now?: Date;
}

export interface ResolvedFeedParams {
  from: string;
  to: string;
  area: string | null;
  includeAll: boolean;
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
  if (!blank(p.city) && !CITY_ALIASES.has(p.city.trim().toLowerCase())) {
    throw new FeedParamError(`city "${p.city}" is not served yet; only New York is`);
  }
  for (const [key, v] of [['from', p.from], ['to', p.to]] as const) {
    if (!blank(v) && !isCalendarDate(v.trim())) throw new FeedParamError(`${key} must be a valid YYYY-MM-DD date`);
  }
  const from = blank(p.from) ? localDatePlus(0, NY_TZ, now) : p.from.trim();
  const to = blank(p.to) ? localDatePlus(DEFAULT_SPAN_DAYS, NY_TZ, localMidnightOf(from)) : p.to.trim();
  const span = daysBetween(from, to);
  if (span < 0) throw new FeedParamError('to must not be before from');
  if (span >= MAX_RANGE_DAYS) throw new FeedParamError(`range must cover at most ${MAX_RANGE_DAYS} nights`);
  let area: string | null = null;
  if (!blank(p.area) && p.area.trim().toLowerCase() !== 'all') {
    const want = p.area.trim().toLowerCase();
    area = AREAS.find((a) => a.toLowerCase() === want) ?? null;
    if (!area) throw new FeedParamError(`area must be one of ${AREAS.join(', ')} or All`);
  }
  return { from, to, area, includeAll: p.includeAll === true };
}

/** Noon UTC on a date: a safe anchor for localDatePlus() that lands on the same calendar day in New York. */
function localMidnightOf(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

// Columns are listed rather than `f.*` so `night` can come back as text and a view change cannot silently
// reshape the API. Offers are aggregated per event in the order event_offer declares (available first,
// cheapest first, then source priority); shape.ts re-sorts anyway so the JSON never depends on it.
const EVENTS_SQL = `
  select f.event_id, f.title, f.night::text as night, f.starts_at, f.ends_at, f.has_time, f.status,
         f.venue_id, f.venue_name, f.venue_kind, f.family_id, f.family_name, f.borough, f.neighborhood, f.lat, f.lng,
         f.age_min, f.lineup, f.description, f.image_url, f.interested_count, f.genres, f.genre_source,
         f.primary_genre, f.primary_genre_label, f.genre_codes, f.genre_labels, f.genre_tags, f.genre_confidence,
         f.vibe_codes, f.vibes,
         f.energy, f.darkness, f.crowd_size, f.start_lateness, f.end_lateness, f.price_tier, f.underground_index,
         f.sound_summary, f.is_electronic, f.needs_review, f.listing_count, f.platforms, f.sources,
         f.cheapest_price, f.sold_out, f.going_count,
         o.offers
  from event_feed f
  left join lateral (
    select jsonb_agg(jsonb_build_object(
             'platform', x.platform, 'platform_name', x.platform_name, 'platform_priority', x.platform_priority,
             'source_url', x.source_url, 'tier', x.tier, 'price', x.price, 'fees_included', x.fees_included,
             'available', x.available, 'note', x.note, 'sold_out', x.sold_out)
           order by (x.available is not false) desc, x.price nulls last, x.platform_priority desc) as offers
    from event_offer x where x.event_id = f.event_id
  ) o on true
  where f.night between $1::date and $2::date
    and ($3::text is null or f.borough = $3)
    and ($4::boolean or f.is_electronic is distinct from false)
  order by f.night, f.has_time desc, f.starts_at nulls last, lower(f.title)`;

const VENUES_SQL = `
  select venue_id, name, kind, address, neighborhood, borough, instagram, website, ra_url, dice_url, verified, lat, lng
  from venue where venue_id = any($1::uuid[])`;

const SOURCES_SQL = `
  select s.source_key, s.display_name, s.enabled, r.status, r.finished_at, r.listings_seen, r.error
  from source s
  left join lateral (select * from ingest_run i where i.source_key = s.source_key order by i.started_at desc limit 1) r on true
  order by s.priority desc`;

export async function buildFeed(params: FeedParams = {}): Promise<FeedResponse> {
  const now = params.now ?? new Date();
  const { from, to, area, includeAll } = resolveParams(params, now);
  const [ev, src] = await Promise.all([
    query<FeedRow>(EVENTS_SQL, [from, to, area, includeAll]),
    query<SourceRunRow>(SOURCES_SQL),
  ]);
  const days = buildDays(from, to, now);
  const dayIndex = new Map(days.map((d, i) => [d.date, i]));
  const rows = ev.rows.filter((r) => dayIndex.has(r.night));
  // venues{} is keyed by the family name the events carry (room -> complex), so fetch the family rows
  const venueIds = [...new Set(rows.map((r) => r.family_id ?? r.venue_id).filter((id): id is string => !!id))];
  const vs = venueIds.length ? (await query<VenueRow>(VENUES_SQL, [venueIds])).rows : [];
  const events = rows.map((r, i) => shapeEvent(r, { n: i + 1, d: dayIndex.get(r.night) as number }));
  return {
    generated_at: new Date().toISOString(),
    range: { from, to },
    days,
    venues: Object.fromEntries(vs.map((v) => [v.name, shapeVenue(v)])),
    events,
    genres: genreFilterList(events),
    sources: src.rows.map(shapeSource),
  };
}
