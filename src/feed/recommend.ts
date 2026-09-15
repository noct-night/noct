/**
 * Recommendations: ask Postgres (recommend_events, 0015 + 0016) as the caller, then shape the winners with the same
 * read model the feed uses so the client renders them as ordinary event cards carrying a `why`.
 *
 * The RPC is called through PostgREST with the caller's own token rather than over our pooled `postgres`
 * connection on purpose — that way Supabase authenticates the user, the function's auth.uid() is the truth,
 * and this service never has to hold a JWT secret or decide who somebody is.
 */
import { query } from '../lib/db.js';
import { env } from '../lib/env.js';
import { EVENTS_COLUMNS_SQL, FeedParamError } from './query.js';
import { shapeEvent, type FeedEvent, type FeedRow } from './shape.js';

export { FeedParamError };

export interface RecommendationReason { kind: 'artist' | 'genre' | 'venue' | 'vibe' | string; detail: string }
export interface Recommendation extends FeedEvent { score: number; why: RecommendationReason[]; night: string }
export interface RecommendResponse {
  generated_at: string;
  /** how many marks the profile is built from; 0 means "nothing to go on yet" */
  history_size: number;
  events: Recommendation[];
}

interface RpcRow { event_id: string; score: number; reasons: RecommendationReason[]; history_size: number }

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;
const DEFAULT_DAYS = 28;
/** At most two nights from one venue family, so a single room cannot fill the list (0016). */
const DEFAULT_PER_VENUE = 2;

function intParam(v: string | undefined, dflt: number, min: number, max: number, name: string): number {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new FeedParamError(`${name} must be a whole number`);
  if (n < min || n > max) throw new FeedParamError(`${name} must be between ${min} and ${max}`);
  return n;
}

export async function recommendationsFor(
  authHeader: string,
  opts: { limit?: string; city?: string; days?: string; perVenue?: string } = {},
): Promise<RecommendResponse> {
  const limit = intParam(opts.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit');
  const days = intParam(opts.days, DEFAULT_DAYS, 1, 60, 'days');
  const perVenue = intParam(opts.perVenue, DEFAULT_PER_VENUE, 1, 10, 'per_venue');
  const city = opts.city && opts.city.trim() ? opts.city.trim() : null;

  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_PUBLISHABLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are not configured');

  const res = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/rpc/recommend_events`, {
    method: 'POST',
    headers: { apikey: key, authorization: authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ p_limit: limit, p_city: city, p_days: days, p_per_venue: perVenue }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) throw new FeedParamError('that session is not valid any more; sign in again');
  if (!res.ok) throw new Error(`recommend_events rpc: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);

  const rows = (await res.json()) as RpcRow[];
  const generated_at = new Date().toISOString();
  if (!Array.isArray(rows) || rows.length === 0) return { generated_at, history_size: 0, events: [] };

  // one round trip for the cards, then restore the ranking the database chose
  const ids = rows.map((r) => r.event_id);
  const feed = await query<FeedRow>(`${EVENTS_COLUMNS_SQL} where f.event_id = any($1::uuid[])`, [ids]);
  const byId = new Map(feed.rows.map((r) => [r.event_id, r]));
  const events: Recommendation[] = [];
  rows.forEach((r) => {
    const row = byId.get(r.event_id);
    if (!row) return;                       // enrichment or a merge removed it between the two queries
    events.push({
      ...shapeEvent(row, { n: events.length + 1, d: 0, tz: row.tz || undefined }),
      night: row.night,                     // recommendations span many nights, so each card carries its own
      score: Math.round(Number(r.score) * 1000) / 1000,
      why: Array.isArray(r.reasons) ? r.reasons.filter((x) => x && x.detail) : [],
    });
  });
  return { generated_at, history_size: Number(rows[0]?.history_size ?? 0), events };
}
