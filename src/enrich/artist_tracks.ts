/**
 * A representative track per artist, from Apple's iTunes Search API.
 *
 * The night's own track (0024) exists on a third of DICE nights and names one artist. For every other name on a
 * line-up this asks Apple for songs by that name and keeps the top one only when the match is unambiguous: Apple's
 * artist name equals ours once accents and punctuation are folded, and the genre is not one no DJ is filed under.
 * A name with no such result is remembered as a miss so it is not searched again for sixty days.
 *
 * Apple's terms (performance-partners.apple.com/search-api): no key, about 20 calls a minute, cache the search
 * results, and for the previews -- streamed only, never downloaded or stored; shown next to a link to the track
 * on Apple Music; credited "courtesy of Apple Music". NOCT stores URLs and streams from Apple's host; the client
 * prints the credit under the line-up. Only Apple's own hosts are accepted (shapeTrack() checks again).
 */
import { query } from '../lib/db.js';
import { fetchJson } from '../lib/http.js';
import type { Logger } from '../lib/log.js';
import { createLogger } from '../lib/log.js';

export interface ItunesSong {
  wrapperType?: string;
  kind?: string;
  trackId?: number;
  artistName?: string;
  trackName?: string;
  trackViewUrl?: string;
  previewUrl?: string;
  primaryGenreName?: string;
  isStreamable?: boolean;
}

export interface ArtistTrackPick { apple_id: number | null; title: string; url: string; preview: string; genre: string | null }

/** Apple's spacing, plus a little: "approximately 20 calls per minute (subject to change)". */
export const ITUNES_MIN_INTERVAL_MS = 3_200;
/** how long a hit or a miss stands before the name is looked up again */
export const RECHECK_DAYS = 60;
/** the default time budget when none is given: fits beside the enrichment run in a 300 s function */
export const DEFAULT_BUDGET_MS = 90_000;

/**
 * Genres under which no DJ or live electronic act is filed. An exclusion list, not an inclusion list: Apple files
 * dance music under Dance, Electronic, House, Techno, Hip-Hop/Rap, R&B/Soul, Reggae, Latin, Afrobeats, World,
 * Alternative and more, and a list of those would go stale faster than this one.
 */
const NOT_A_DJ_GENRE = new Set([
  'classical', 'opera', 'christian & gospel', 'children\'s music', 'kids & family', 'soundtrack', 'comedy', 'spoken word',
  'audiobooks', 'podcasts', 'holiday', 'country', 'bluegrass', 'enka', 'karaoke', 'marching bands', 'anime', 'fitness & workout',
  'new age', 'easy listening', 'vocal', 'brazilian', 'j-pop', 'k-pop', 'c-pop', 'kayokyoku',
]);

/** norm_text() from 0002, in JS: lower-case, accents folded, everything but letters and digits to one space. */
export function foldName(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const PREVIEW_HOST = /^(audio-ssl\.itunes\.apple\.com|[a-z0-9-]+\.mzstatic\.com)$/i;
const TRACK_HOST = /^(music|itunes)\.apple\.com$/i;
function host(u: unknown): string | null {
  if (typeof u !== 'string' || !/^https:\/\//i.test(u)) return null;
  try { return new URL(u).hostname; } catch { return null; }
}

/**
 * The song to keep for `name` out of Apple's results, or null. Apple ranks by popularity, so the first song whose
 * artist IS this name is the representative one; songs by "X & Y" or "X feat. Z" are not X's and are skipped.
 */
export function pickTrack(name: string, results: ItunesSong[] | null | undefined): ArtistTrackPick | null {
  const want = foldName(name);
  if (want.length < 2) return null;
  for (const r of results ?? []) {
    if (r.wrapperType && r.wrapperType !== 'track') continue;
    if (r.kind && r.kind !== 'song') continue;
    if (foldName(r.artistName ?? '') !== want) continue;
    if (NOT_A_DJ_GENRE.has((r.primaryGenreName ?? '').toLowerCase())) continue;
    const ph = host(r.previewUrl);
    const uh = host(r.trackViewUrl);
    if (!ph || !PREVIEW_HOST.test(ph) || !uh || !TRACK_HOST.test(uh)) continue;
    const title = (r.trackName ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!title) continue;
    return {
      apple_id: typeof r.trackId === 'number' ? r.trackId : null,
      title,
      url: new URL(r.trackViewUrl as string).href,
      preview: new URL(r.previewUrl as string).href,
      genre: r.primaryGenreName ?? null,
    };
  }
  return null;
}

export function searchUrl(name: string): string {
  const q = new URLSearchParams({ term: name, entity: 'song', media: 'music', limit: '10', country: 'US' });
  return `https://itunes.apple.com/search?${q}`;
}

export type ItunesFetch = (url: string) => Promise<{ results?: ItunesSong[] }>;
const defaultFetch: ItunesFetch = (url) => fetchJson<{ results?: ItunesSong[] }>(url, { minIntervalMs: ITUNES_MIN_INTERVAL_MS, timeoutMs: 15_000, retries: 1 });

export interface ArtistTracksOptions {
  /** stop looking up new names once this much time has passed */
  budgetMs?: number;
  /** at most this many lookups */
  limit?: number;
  log?: Logger;
  fetchImpl?: ItunesFetch;
  /** only these artists (tests) */
  artistIds?: string[];
}
export interface ArtistTracksSummary { looked_up: number; found: number; missed: number; errors: number; budgetStopped: boolean; pending: number }

/** Artists on upcoming scheduled nights with no fresh row, soonest night first. */
const PENDING_SQL = `
  select a.artist_id, a.name, min(e.night) as first_night
  from artist a
  join event_artist ea on ea.artist_id = a.artist_id
  join event e on e.event_id = ea.event_id
  left join artist_track t on t.artist_id = a.artist_id
  where e.merged_into is null and e.status = 'scheduled' and e.night >= current_date
    and e.is_electronic is distinct from false
    and (t.artist_id is null or t.checked_at < now() - make_interval(days => $1::int))
    and ($3::uuid[] is null or a.artist_id = any($3::uuid[]))
  group by a.artist_id, a.name
  order by min(e.night), a.name
  limit $2::int`;

const UPSERT_SQL = `
  insert into artist_track (artist_id, found, platform, title, url, preview, genre, apple_id, checked_at)
  values ($1, $2, $3, $4, $5, $6, $7, $8, now())
  on conflict (artist_id) do update set found = excluded.found, platform = excluded.platform, title = excluded.title,
    url = excluded.url, preview = excluded.preview, genre = excluded.genre, apple_id = excluded.apple_id, checked_at = now()`;

export async function resolveArtistTracks(opts: ArtistTracksOptions = {}): Promise<ArtistTracksSummary> {
  const log = opts.log ?? createLogger('artist-tracks');
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const limit = opts.limit ?? 5_000;
  const started = Date.now();
  const summary: ArtistTracksSummary = { looked_up: 0, found: 0, missed: 0, errors: 0, budgetStopped: false, pending: 0 };

  const pending = await query<{ artist_id: string; name: string; first_night: string }>(PENDING_SQL, [RECHECK_DAYS, limit, opts.artistIds ?? null]);
  summary.pending = pending.rows.length;
  for (const a of pending.rows) {
    if (Date.now() - started > budgetMs) { summary.budgetStopped = true; break; }
    try {
      const body = await fetchImpl(searchUrl(a.name));
      const pick = pickTrack(a.name, body.results);
      await query(UPSERT_SQL, pick
        ? [a.artist_id, true, 'apple', pick.title, pick.url, pick.preview, pick.genre, pick.apple_id]
        : [a.artist_id, false, null, null, null, null, null, null]);
      summary.looked_up++;
      if (pick) summary.found++; else summary.missed++;
    } catch (err) {
      summary.errors++;
      log.warn('lookup failed', { artist: a.name, error: err instanceof Error ? err.message : String(err) });
      if (summary.errors >= 5) { log.warn('too many failures; stopping this run'); break; }
    }
  }
  summary.pending = Math.max(0, summary.pending - summary.looked_up);
  log.info('artist tracks done', { ...summary, ms: Date.now() - started });
  return summary;
}
