/**
 * Onboarding data: the genres worth offering, and a handful of real nights to react to.
 *
 * Both halves are deliberately shaped by what is actually on. Offering all 60 taxonomy codes would be a
 * scrolling chore with 37 dead ends; offering an artist list would be worse still, because 1,015 of NYC's
 * 1,194 upcoming artists play exactly one night and almost nobody recognises the names. Genres that have
 * something on, then actual flyers to tap, is the shortest path to a profile.
 */
import { query } from '../lib/db.js';
import { findCity, DEFAULT_CITY } from '../lib/cities.js';
import { EVENTS_COLUMNS_SQL, FeedParamError } from './query.js';
import { shapeEvent, type FeedEvent, type FeedRow } from './shape.js';

/** Below this an option is a dead end: picking it would match almost nothing. */
const MIN_EVENTS = 8;
/** One screen of chips. More than this and the picker becomes the chore it is meant to avoid. */
const MAX_GENRES = 24;
const DEFAULT_PICKS = 9;
const PICK_WINDOW_DAYS = 45;

export interface TasteGenre { code: string; label: string; events: number }
export interface TasteOptions { generated_at: string; city: string; genres: TasteGenre[] }
/** shapeEvent() indexes nights against a loaded range; picks span any night, so each carries its own date. */
export interface TastePick extends FeedEvent { night: string }
export interface TastePicks { generated_at: string; city: string; events: TastePick[] }

const GENRES_SQL = `
  select x.code, coalesce(g.label, x.code) as label, count(distinct e.event_id)::int as events
  from event e, unnest(e.genre_codes) as x(code)
  left join genre g on g.code = x.code
  where e.merged_into is null and e.city = $1::text and e.status = 'scheduled'
    and e.night between current_date and current_date + $2::int
    and e.is_electronic is distinct from false
    and not event_is_class(e.title)
  group by 1, 2
  having count(distinct e.event_id) >= $3::int
  order by 3 desc, 2
  limit ${MAX_GENRES}`;

const PICKS_SQL = `${EVENTS_COLUMNS_SQL}
  where f.city = $1::text and f.night between current_date and current_date + $2::int
    and f.is_electronic is distinct from false
    and f.image_url is not null
    and not event_is_class(f.title)
    and (cardinality($3::text[]) = 0 or f.genre_codes && $3::text[])
  order by coalesce(f.interested_count, 0) desc, f.night`;

function cityKey(raw: string | undefined): string {
  const city = findCity(raw && raw.trim() ? raw.trim() : DEFAULT_CITY);
  if (!city) throw new FeedParamError(`city "${raw}" is unknown`);
  return city.key;
}

export async function tasteOptions(cityRaw?: string): Promise<TasteOptions> {
  const city = cityKey(cityRaw);
  const res = await query<TasteGenre>(GENRES_SQL, [city, PICK_WINDOW_DAYS, MIN_EVENTS]);
  return { generated_at: new Date().toISOString(), city, genres: res.rows.map((r) => ({ ...r, events: Number(r.events) })) };
}

/**
 * Nights to react to. One per venue so nine cards are nine different rooms rather than one venue's week —
 * the point is to spread the first profile, not to concentrate it.
 */
export async function tastePicks(cityRaw?: string, genres: string[] = [], limit = DEFAULT_PICKS): Promise<TastePicks> {
  const city = cityKey(cityRaw);
  const codes = genres.filter((g) => /^[a-z_]+\.[a-z_0-9]+$/.test(g)).slice(0, 12);
  const res = await query<FeedRow>(PICKS_SQL, [city, PICK_WINDOW_DAYS, codes]);
  const seen = new Set<string>();
  const rows: FeedRow[] = [];
  for (const pass of [0, 1]) {            // first one per venue, then backfill if that was not enough
    for (const r of res.rows) {
      if (rows.length >= limit) break;
      const key = r.family_id ?? r.venue_id ?? r.event_id;
      if (pass === 0 && seen.has(key)) continue;
      if (rows.includes(r)) continue;
      seen.add(key);
      rows.push(r);
    }
  }
  return {
    generated_at: new Date().toISOString(),
    city,
    events: rows.map((r, i) => ({ ...shapeEvent(r, { n: i + 1, d: 0, tz: r.tz || undefined }), night: r.night })),
  };
}
