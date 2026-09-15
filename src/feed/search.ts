/**
 * Search across events, artists and venues, plus the one thing a search result needs to be worth tapping:
 * an artist's own upcoming nights.
 *
 * The ranking is in SQL (`search_noct`, 0020) because that is where the trigram indexes are. This module is
 * the shape and the guard rails.
 */
import { query } from '../lib/db.js';
import { findCity } from '../lib/cities.js';
import { EVENTS_COLUMNS_SQL, FeedParamError } from './query.js';
import { shapeEvent, type FeedEvent, type FeedRow } from './shape.js';

const MIN_Q = 2;
const MAX_Q = 60;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const ARTIST_DAYS = 120;

export interface SearchHit { kind: 'event' | 'artist' | 'venue'; id: string; label: string; sub: string | null; n: number; city: string | null }
export interface SearchResponse { q: string; results: SearchHit[] }
export interface ArtistEvents { artist: { id: string; name: string }; events: (FeedEvent & { night: string })[] }

const ARTIST_SQL = `${EVENTS_COLUMNS_SQL}
  where f.event_id in (select ea.event_id from event_artist ea where ea.artist_id = $1::uuid)
    and f.night between current_date and current_date + ${ARTIST_DAYS}
  order by f.night, f.starts_at nulls last`;

function cityKey(raw: string | undefined | null): string | null {
  if (!raw || !raw.trim()) return null;
  const c = findCity(raw.trim());
  if (!c) throw new FeedParamError(`city "${raw}" is unknown`);
  return c.key;
}

export async function search(qRaw: string | undefined, cityRaw?: string, limitRaw?: string): Promise<SearchResponse> {
  const q = (qRaw ?? '').trim();
  if (q.length < MIN_Q) throw new FeedParamError(`search needs at least ${MIN_Q} characters`);
  if (q.length > MAX_Q) throw new FeedParamError(`search is limited to ${MAX_Q} characters`);
  const n = Number(limitRaw);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
  const res = await query<SearchHit>(
    `select kind, id::text as id, label, sub, n, city from search_noct($1, $2, $3)`,
    [q, cityKey(cityRaw), limit],
  );
  return { q, results: res.rows.map((r) => ({ ...r, n: Number(r.n) })) };
}

/** One artist's upcoming nights, shaped like feed cards so the client renders them with what it already has. */
export async function artistEvents(artistId: string): Promise<ArtistEvents> {
  if (!/^[0-9a-f-]{36}$/i.test(artistId)) throw new FeedParamError('artist must be a uuid');
  const who = await query<{ artist_id: string; name: string }>(
    `select artist_id::text, name from artist where artist_id = $1::uuid`, [artistId]);
  if (!who.rows.length) throw new FeedParamError('no such artist');
  const rows = await query<FeedRow>(ARTIST_SQL, [artistId]);
  return {
    artist: { id: who.rows[0]!.artist_id, name: who.rows[0]!.name },
    events: rows.rows.map((r, i) => ({ ...shapeEvent(r, { n: i + 1, d: 0, tz: r.tz || undefined }), night: r.night })),
  };
}
