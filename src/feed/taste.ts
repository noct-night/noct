/**
 * Onboarding data: the genres worth offering, and a handful of real nights to react to.
 *
 * Both halves are deliberately shaped by what is actually on. Offering all 60 taxonomy codes would be a
 * scrolling chore with dead ends; offering an artist list would be worse still, because 1,015 of NYC's
 * 1,194 upcoming artists play exactly one night and almost nobody recognises the names. Genres that have
 * something on, then actual flyers to tap, is the shortest path to a profile.
 *
 * The chips read like a menu, not a leaderboard: a family at a time (the busiest family first), siblings in the
 * taxonomy's own order, so UK Garage sits next to the other house and Jungle next to Breaks. Wording is what
 * people say -- "House", "Techno", "UK Garage" -- where the taxonomy label is the exact one.
 */
import { query } from '../lib/db.js';
import { findCity, DEFAULT_CITY } from '../lib/cities.js';
import { EVENTS_COLUMNS_SQL, FeedParamError } from './query.js';
import { shapeEvent, type FeedEvent, type FeedRow } from './shape.js';

/** Below this an option is a dead end: four nights in the window is one every week and a half. */
export const MIN_EVENTS = 4;
/** A long screen of chips, not an endless one; when a city outgrows it the rarest go first. */
export const MAX_GENRES = 40;
const DEFAULT_PICKS = 9;
const PICK_WINDOW_DAYS = 45;

export interface TasteGenre { code: string; label: string; events: number }
/** a qualifying code as the query returns it, before arrangement */
export interface TasteGenreRow extends TasteGenre { family: string; sort: number }
export interface TasteOptions { generated_at: string; city: string; genres: TasteGenre[] }
/** shapeEvent() indexes nights against a loaded range; picks span any night, so each carries its own date. */
export interface TastePick extends FeedEvent { night: string }
export interface TastePicks { generated_at: string; city: string; events: TastePick[] }

const GENRES_SQL = `
  select x.code, coalesce(g.label, x.code) as label, count(distinct e.event_id)::int as events,
         coalesce(g.family, split_part(x.code, '.', 1)) as family, coalesce(g.sort, 9999) as sort
  from event e, unnest(e.genre_codes) as x(code)
  left join genre g on g.code = x.code
  where e.merged_into is null and e.city = $1::text and e.status = 'scheduled'
    and e.night between current_date and current_date + $2::int
    and e.is_electronic is distinct from false
    and not event_is_class(e.title)
  group by 1, 2, 4, 5
  having count(distinct e.event_id) >= $3::int
  order by 3 desc, 2
  limit ${MAX_GENRES}`;

/**
 * What the chip says. The taxonomy label is exact ("Disco / Funk / Boogie", "Peak-Time Techno") and stays on
 * cards; the picker uses the name a person would look for. Generic "House" and "Techno" tags land in
 * house.deep and techno.peak, so those two chips are simply House and Techno.
 */
export const CHIP_LABELS: Record<string, string> = {
  'house.deep': 'House',
  'house.progressive': 'Melodic / Progressive',
  'house.disco': 'Nu-Disco',
  'house.garage': 'UK Garage',
  'house.jackin': 'Jackin House',
  'house.soulful': 'Soulful House',
  'techno.peak': 'Techno',
  'techno.hard': 'Hard Techno',
  'techno.dub': 'Hypnotic Techno',
  'dnb.neuro_jumpup': 'Drum & Bass',
  'dnb.liquid': 'Liquid D&B',
  'bass.breaks': 'Breaks',
  'bass.footwork': 'Footwork',
  'dubstep.140': 'Dubstep',
  'dubstep.us_bass': 'US Bass',
  'electro.ebm_industrial': 'EBM / Industrial',
  'leftfield.ambient': 'Ambient',
  'leftfield.downtempo': 'Downtempo',
  'leftfield.experimental': 'Experimental',
  'hiphop.rap': 'Hip-Hop',
  'latin.latin_bass': 'Latin Bass',
  'afro.afrobeat': 'Afrobeat',
  'afro.gqom_kuduro_singeli': 'Gqom / Kuduro',
  'disco.disco': 'Disco',
  'live.indie_electronic': 'Live Electronic',
  'jazz.brokenbeat': 'Broken Beat',
  'jazz.balearic_global': 'Balearic',
  'open.eclectic': 'Open Format',
};

/**
 * The picker's order: families by how much of the city's calendar they hold, chips inside a family in the
 * taxonomy's own order (House, Tech House, Melodic, Afro House, ... UK Garage), each wearing its chip label.
 * The query has already dropped the rarest codes past the cap, so this only arranges what qualified.
 */
export function arrangeGenres(rows: TasteGenreRow[]): TasteGenre[] {
  const held = new Map<string, number>();
  for (const r of rows) held.set(r.family, (held.get(r.family) ?? 0) + r.events);
  return [...rows]
    .sort((a, b) => (held.get(b.family)! - held.get(a.family)!) || a.family.localeCompare(b.family) || a.sort - b.sort || a.code.localeCompare(b.code))
    .map((r) => ({ code: r.code, label: CHIP_LABELS[r.code] ?? r.label, events: Number(r.events) }));
}

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
  const res = await query<TasteGenreRow>(GENRES_SQL, [city, PICK_WINDOW_DAYS, MIN_EVENTS]);
  return { generated_at: new Date().toISOString(), city, genres: arrangeGenres(res.rows.map((r) => ({ ...r, events: Number(r.events), sort: Number(r.sort) }))) };
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
