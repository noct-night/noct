/**
 * "After this, nearby": for one event, the rooms within a few kilometres whose listed close is two hours or more
 * after this one's -- the second stop of a night, seeded from the event the person is looking at.
 *
 * This is the part of a "night itinerary" the data can actually stand behind. NOCT holds no bars (so no
 * "drinks in Williamsburg"), no set times (so no "MPH at midnight"), and a handful of listed afters citywide
 * (so no "afters nearby" as a slot that is usually filled). It does hold every room's door and close and, for
 * most of them, a coordinate: "open later, within walking distance" is a true sentence for about half of New
 * York's weekend mains. The section says exactly that and is absent otherwise.
 *
 * Distance is straight-line (haversine_km, 0024): no routing, no minutes. Directions hands the pair to Maps.
 */
import { query } from '../lib/db.js';
import { EVENTS_COLUMNS_SQL, FeedParamError } from './query.js';
import { shapeEvent, type FeedEvent, type FeedRow } from './shape.js';

export { FeedParamError };
/** the event is not (or no longer) listed: the handler answers 404, not 400 */
export class NightNotFound extends Error {
  override readonly name = 'NightNotFound';
}

export const RADIUS_DEFAULT_KM = 4;
export const RADIUS_MAX_KM = 10;
export const LIMIT_DEFAULT = 3;
export const LIMIT_MAX = 6;
/** a room counts as "after this" when it closes at least this much later */
export const LATER_BY_HOURS = 2;
/** and starts no later than this after the main closes -- "after this", not "tomorrow afternoon" */
export const START_WITHIN_HOURS = 3;
/** anything listed longer than this is a festival pass or a data error, not a room to go on to */
export const MAX_DURATION_HOURS = 12;
/**
 * The main itself may run long -- Nowadays Nonstop is 17 h, Refuge 21 h -- but a two-day span (a weekend pass, an
 * RA "ends 23:59 tomorrow") has no close to anchor "after this" on. Nothing is said for those.
 */
export const MAIN_MAX_DURATION_HOURS = 24;
/** at or under this a Directions link asks Maps for the walking route, and the row says "walkable" */
export const WALK_KM = 1.5;

export interface NightStop extends FeedEvent {
  night: string;
  lat: number | null;
  lng: number | null;
}
export interface NightNext extends NightStop {
  /** straight-line kilometres from the main event's venue, one decimal; clients should print it coarsely */
  km: number;
  walk: boolean;
}
export interface NightResponse {
  generated_at: string;
  radius_km: number;
  main: NightStop;
  next: NightNext[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function numParam(v: string | undefined, dflt: number, min: number, max: number, name: string, integer = false): number {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) throw new FeedParamError(`${name} must be a number`);
  if (n < min || n > max) throw new FeedParamError(`${name} must be between ${min} and ${max}`);
  return n;
}

export function resolveNightParams(p: { e?: string; radiusKm?: string; limit?: string } = {}): { id: string; radiusKm: number; limit: number } {
  const id = (p.e ?? '').trim();
  if (!UUID_RE.test(id)) throw new FeedParamError('e must be an event id');
  return {
    id: id.toLowerCase(),
    radiusKm: numParam(p.radiusKm, RADIUS_DEFAULT_KM, 0.5, RADIUS_MAX_KM, 'radius_km'),
    limit: numParam(p.limit, LIMIT_DEFAULT, 1, LIMIT_MAX, 'limit', true),
  };
}

/** Same formula as haversine_km() in SQL; used here only to print the distance the query already filtered on. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const MAIN_SQL = `${EVENTS_COLUMNS_SQL} where f.event_id = $1::uuid`;

/**
 * The rule, in one place. A candidate is another room (family), same city, this night or the next, scheduled,
 * a night out (not a class, not non-electronic), timed, located, not sold out, closing >= 2 h after the main
 * closes, starting no more than 3 h after it closes, listed for <= 12 h, within the radius. One row per room
 * (the latest-closing night of a room that has several), nearest first.
 *
 * The main's values are bound as parameters rather than joined from a one-row CTE on purpose: with constants
 * on f.city and f.night the planner reaches event_city_night_idx and evaluates the view's laterals for that
 * night's rows only (about 2 ms on production); joined through a CTE the same predicates ran as a top-level
 * join filter over every scheduled event in every city (about 250 ms).
 */
const NEXT_SQL = `
  select * from (
    select distinct on (coalesce(q.family_id, q.venue_id)) q.*
    from (
      ${EVENTS_COLUMNS_SQL}
      where f.event_id <> $1::uuid
        and f.city = $7::text
        and f.night between $8::date and $8::date + 1
        and f.status = 'scheduled'
        and f.is_electronic is distinct from false
        and not event_is_class(f.title)
        and not venue_is_placeholder(coalesce(f.venue_name, ''))
        and f.has_time and f.starts_at is not null and f.ends_at is not null
        and f.lat is not null and f.lng is not null
        and coalesce(f.family_id, f.venue_id) is distinct from $9::uuid
        and f.sold_out is not true
        and f.ends_at >= $10::timestamptz + make_interval(hours => $4::int)
        and f.starts_at <= $10::timestamptz + make_interval(hours => $5::int)
        and f.ends_at - f.starts_at <= make_interval(hours => $6::int)
        and haversine_km($11::double precision, $12::double precision, f.lat, f.lng) <= $2::double precision
    ) q
    order by coalesce(q.family_id, q.venue_id), q.ends_at desc, q.event_id
  ) c
  order by haversine_km($11::double precision, $12::double precision, c.lat, c.lng), c.ends_at desc, c.event_id
  limit $3::int`;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const ms = (v: Date | string | null | undefined): number => (v ? new Date(v).getTime() : NaN);

function stop(row: FeedRow): NightStop {
  return { ...shapeEvent(row, { n: 1, d: 0, tz: row.tz || undefined }), night: row.night, lat: num(row.lat), lng: num(row.lng) };
}

/** Whether "after this" has an anchor at all: a scheduled, timed, located main whose listed span is one night's. */
export function mainAnchors(row: Pick<FeedRow, 'status' | 'has_time' | 'starts_at' | 'ends_at' | 'lat' | 'lng'>): boolean {
  if (row.status !== 'scheduled' || row.has_time !== true || !row.starts_at || !row.ends_at) return false;
  if (num(row.lat) === null || num(row.lng) === null) return false;
  const span = ms(row.ends_at) - ms(row.starts_at);
  return Number.isFinite(span) && span > 0 && span <= MAIN_MAX_DURATION_HOURS * 3_600_000;
}

export async function nightFor(params: { e?: string; radiusKm?: string; limit?: string } = {}): Promise<NightResponse> {
  const { id, radiusKm, limit } = resolveNightParams(params);
  const mainRes = await query<FeedRow>(MAIN_SQL, [id]);
  const mainRow = mainRes.rows[0];
  if (!mainRow) throw new NightNotFound('that night is not listed');
  const main = stop(mainRow);
  const generated_at = new Date().toISOString();
  // postponed, cancelled, untimed, unlocated or a multi-day span: nothing honest to say about "after this"
  if (!mainAnchors(mainRow)) return { generated_at, radius_km: radiusKm, main, next: [] };
  const res = await query<FeedRow>(NEXT_SQL, [
    id, radiusKm, limit, LATER_BY_HOURS, START_WITHIN_HOURS, MAX_DURATION_HOURS,
    mainRow.city, mainRow.night, mainRow.family_id ?? mainRow.venue_id, mainRow.ends_at, main.lat, main.lng,
  ]);
  const next: NightNext[] = res.rows.map((r, i) => {
    const s = { ...stop(r), n: i + 1 };
    const km = Math.round(haversineKm(main.lat as number, main.lng as number, s.lat as number, s.lng as number) * 10) / 10;
    return { ...s, km, walk: km <= WALK_KM };
  });
  return { generated_at, radius_km: radiusKm, main, next };
}
