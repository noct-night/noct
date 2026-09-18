/**
 * How big a name is, from Spotify.
 *
 * "Coming to New York" needs to know which of a fortnight's four hundred names people would actually travel
 * for, and the feed cannot say: RA's `interested` is about an event, so a headliner announced yesterday sits
 * under a local party that has been on sale a month. Spotify's follower count is about the artist, which is
 * the question being asked. Like every other volatile number it ranks and is never printed (see 0037).
 *
 * Names are matched, not resolved: "Anna" is an artist on Spotify and a different one in a Bushwick basement.
 * A match is only `confident` when Spotify spells the name the way we do, once accents and punctuation are
 * folded, and -- for names short enough to belong to anyone -- when Spotify files the artist under something
 * dance music is filed under. Anything less is stored with confident = false and the studio says so before
 * the post can be approved, because publishing the wrong Anna is a correction in public.
 *
 * Spotify's Client Credentials flow: an app token, no user data, no login. The token lasts an hour and is
 * kept in memory rather than in the database -- a lambda that lives minutes has no use for a row, and a
 * token is not something to persist when it can be asked for again in one call.
 */
import { query } from '../lib/db.js';
import { requireEnv } from '../lib/env.js';
import { fetchJson, politeFetch } from '../lib/http.js';
import { createLogger, type Logger } from '../lib/log.js';
import { foldName } from './artist_tracks.js';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SEARCH_URL = 'https://api.spotify.com/v1/search';

/** Spotify's published rate limits are generous; this is politeness, not a ceiling. */
export const SPOTIFY_MIN_INTERVAL_MS = 250;
/** How long a hit or a miss stands before the name is looked up again. Follower counts move slowly. */
export const RECHECK_DAYS = 60;
/** The default time budget: a draft waits on this, so it is short enough that a person does not. */
export const DEFAULT_BUDGET_MS = 25_000;
/** How far ahead a night has to be for its line-up to be worth a lookup. */
export const WINDOW_DAYS = 30;

export class SpotifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpotifyError';
  }
}

export interface SpotifyArtist {
  id: string;
  name: string;
  followers: number;
  popularity: number;
  genres: string[];
  url: string;
}

interface SearchResponse {
  artists?: { items?: { id?: string; name?: string; followers?: { total?: number }; popularity?: number; genres?: string[]; external_urls?: { spotify?: string } }[] };
}

/** The app token, and when it stops working. Module-level: one per lambda, reused across a run. */
let token: { value: string; expiresAt: number } | null = null;

/** Forget the cached token. For tests, and for a run that has just been told the token is no longer good. */
export function forgetToken(): void {
  token = null;
}

/**
 * An app token from the Client Credentials flow.
 *
 * The secret is sent as HTTP Basic, which is where Spotify's own documentation puts it, and never in a query
 * string. Refreshed a minute before it expires rather than on failure: a token that dies mid-run would cost
 * the rest of the run's lookups.
 */
export async function appToken(env = process.env): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const id = requireEnv('SPOTIFY_CLIENT_ID', env);
  const secret = requireEnv('SPOTIFY_CLIENT_SECRET', env);
  const res = await politeFetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    timeoutMs: 15_000,
    retries: 1,
    minIntervalMs: 0,
  }).catch((err: unknown) => {
    throw new SpotifyError(`Spotify would not issue a token: ${err instanceof Error ? err.message : String(err)}`);
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new SpotifyError('Spotify returned no token');
  token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return token.value;
}

/**
 * Genres Spotify files dance music under, for the short-name rule.
 *
 * Spotify's genres are specific ("melodic techno", "uk bass"), so this matches on words rather than on whole
 * labels -- an inclusion list of Spotify's actual genre strings would be thousands long and stale by Friday.
 */
const DANCE_WORDS = /\b(house|techno|trance|electro|edm|dance|rave|bass|dnb|drum and bass|jungle|garage|dubstep|breakbeat|disco|club|dj|ambient|idm|downtempo|amapiano|afrobeats|afro|dancehall|reggaeton|hyperpop|industrial|minimal|acid|hardcore|hardstyle|gabber)\b/i;

/** A name this short belongs to too many acts for a spelling match alone to mean anything. */
export const SHORT_NAME_MAX = 4;

export interface Match {
  artist: SpotifyArtist;
  confident: boolean;
}

/**
 * Which of Spotify's results is this artist, and whether that is a claim or a guess.
 *
 * Spotify ranks by its own popularity, so the first result that spells the name our way is the one meant. A
 * top result that spells it differently is kept anyway -- it is often right, and a post that never mentions
 * an artist because of a stray full stop is worse -- but it is kept as a guess for a person to confirm.
 */
export function pickArtist(name: string, body: SearchResponse | null | undefined): Match | null {
  const want = foldName(name);
  if (want.length < 2) return null;
  const items = (body?.artists?.items ?? []).flatMap((item) => {
    if (!item?.id || !item.name) return [];
    return [{
      id: item.id,
      name: item.name,
      followers: item.followers?.total ?? 0,
      popularity: item.popularity ?? 0,
      genres: item.genres ?? [],
      url: item.external_urls?.spotify ?? `https://open.spotify.com/artist/${item.id}`,
    }];
  });
  if (items.length === 0) return null;

  const danceish = (a: SpotifyArtist): boolean => a.genres.some((g) => DANCE_WORDS.test(g));
  const short = want.replace(/ /g, '').length <= SHORT_NAME_MAX;
  const exact = items.filter((a) => foldName(a.name) === want);
  for (const a of exact) {
    // A short name that Spotify files under nothing dance-shaped is the wrong Anna more often than not.
    if (!short || danceish(a)) return { artist: a, confident: true };
  }
  if (exact[0]) return { artist: exact[0], confident: false };
  const first = items[0]!;
  return { artist: first, confident: false };
}

export function searchUrl(name: string): string {
  const q = new URLSearchParams({ q: name, type: 'artist', limit: '5', market: 'US' });
  return `${SEARCH_URL}?${q}`;
}

export type SpotifyFetch = (url: string, bearer: string) => Promise<SearchResponse>;
const defaultFetch: SpotifyFetch = (url, bearer) =>
  fetchJson<SearchResponse>(url, {
    headers: { authorization: `Bearer ${bearer}` },
    minIntervalMs: SPOTIFY_MIN_INTERVAL_MS,
    timeoutMs: 15_000,
    retries: 1,
  });

export interface ResolveOptions {
  budgetMs?: number;
  limit?: number;
  /** How far ahead to look for nights whose line-ups matter. */
  days?: number;
  log?: Logger;
  fetchImpl?: SpotifyFetch;
  env?: NodeJS.ProcessEnv;
}

export interface ResolveSummary {
  looked_up: number;
  found: number;
  missed: number;
  unsure: number;
  errors: number;
  budgetStopped: boolean;
  pending: number;
}

/** Artists on upcoming scheduled nights with no fresh Spotify row, soonest night first. */
const PENDING_SQL = `
  select a.artist_id, a.name
  from artist a
  join event_artist ea on ea.artist_id = a.artist_id
  join event e on e.event_id = ea.event_id
  left join artist_spotify s on s.artist_id = a.artist_id
  where e.merged_into is null and e.status = 'scheduled'
    and e.night >= current_date and e.night < current_date + make_interval(days => $3::int)
    and e.is_electronic is distinct from false
    and (s.artist_id is null or s.checked_at < now() - make_interval(days => $1::int))
  group by a.artist_id, a.name
  order by min(e.night), a.name
  limit $2::int`;

const UPSERT_SQL = `
  insert into artist_spotify (artist_id, found, spotify_id, name, followers, popularity, genres, url, confident, checked_at)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
  on conflict (artist_id) do update set found = excluded.found, spotify_id = excluded.spotify_id,
    name = excluded.name, followers = excluded.followers, popularity = excluded.popularity,
    genres = excluded.genres, url = excluded.url, confident = excluded.confident, checked_at = now()`;

/**
 * Look up the names on upcoming line-ups, within a time budget.
 *
 * Stops on budget rather than finishing the list: this runs while someone waits for a draft, and the work is
 * cumulative -- what is looked up is stored, so the next run starts where this one stopped.
 */
export async function resolveArtistSpotify(opts: ResolveOptions = {}): Promise<ResolveSummary> {
  const log = opts.log ?? createLogger('artist-spotify');
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const started = Date.now();
  const summary: ResolveSummary = {
    looked_up: 0, found: 0, missed: 0, unsure: 0, errors: 0, budgetStopped: false, pending: 0,
  };

  const bearer = await appToken(opts.env);
  const pending = await query<{ artist_id: string; name: string }>(
    PENDING_SQL, [RECHECK_DAYS, opts.limit ?? 400, opts.days ?? WINDOW_DAYS],
  );
  summary.pending = pending.rows.length;

  for (const a of pending.rows) {
    if (Date.now() - started > budgetMs) { summary.budgetStopped = true; break; }
    try {
      const match = pickArtist(a.name, await fetchImpl(searchUrl(a.name), bearer));
      await query(UPSERT_SQL, match
        ? [a.artist_id, true, match.artist.id, match.artist.name, match.artist.followers, match.artist.popularity,
           match.artist.genres, match.artist.url, match.confident]
        : [a.artist_id, false, null, null, null, null, null, null, true]);
      summary.looked_up++;
      if (!match) summary.missed++;
      else if (match.confident) summary.found++;
      else { summary.found++; summary.unsure++; }
    } catch (err) {
      summary.errors++;
      log.warn('lookup failed', { artist: a.name, error: err instanceof Error ? err.message : String(err) });
      if (summary.errors >= 5) { log.warn('too many failures; stopping this run'); break; }
    }
  }
  summary.pending = Math.max(0, summary.pending - summary.looked_up);
  log.info('spotify lookups done', { ...summary, ms: Date.now() - started });
  return summary;
}

/** What is known about a name, keyed by the folded name the feed's line-ups use. */
export interface KnownArtist extends SpotifyArtist {
  confident: boolean;
}

/**
 * Look up what is already stored for these names.
 *
 * By folded name rather than by artist id because a post is drafted from the feed, which carries line-ups as
 * the strings the sources printed. `norm_text` (0002) is the same folding, run in Postgres.
 */
export async function knownArtists(names: string[]): Promise<Map<string, KnownArtist>> {
  const wanted = [...new Set(names.map(foldName).filter((n) => n.length > 1))];
  if (wanted.length === 0) return new Map();
  const { rows } = await query<{
    folded: string; spotify_id: string; name: string; followers: number; popularity: number;
    genres: string[] | null; url: string | null; confident: boolean;
  }>(
    `select a.name_norm as folded, s.spotify_id, s.name, s.followers, s.popularity, s.genres, s.url, s.confident
       from artist a join artist_spotify s on s.artist_id = a.artist_id
      where s.found and a.name_norm = any($1::text[])`,
    [wanted],
  );
  const out = new Map<string, KnownArtist>();
  for (const r of rows) {
    const known: KnownArtist = {
      id: r.spotify_id, name: r.name, followers: r.followers, popularity: r.popularity,
      genres: r.genres ?? [], url: r.url ?? `https://open.spotify.com/artist/${r.spotify_id}`,
      confident: r.confident,
    };
    // The same folded name can belong to two artist rows (different disambiguations); the bigger one is the
    // one a post about big names means.
    const before = out.get(r.folded);
    if (!before || before.followers < known.followers) out.set(r.folded, known);
  }
  return out;
}
