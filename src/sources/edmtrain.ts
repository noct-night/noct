/**
 * EDMTrain — official Event Search API, client-key gated. https://edmtrain.com/developer-api
 *
 * OFF BY DEFAULT. EDMTrain's API Terms of Use (fetched 2026-09-13) contain a competition clause: the API may not be
 * used in "an event discovery service that combines our events with other event sources", which describes NOCT.
 * The adapter therefore refuses to run unless the operator sets NOCT_EDMTRAIN_ACCEPT_TERMS=1 in addition to the
 * key — an explicit acknowledgement that a written arrangement with EDM Train LLC exists. Terms we honour in code:
 * the event `link` is stored exactly as returned (attribution clause), and nothing but the API is touched (no
 * crawling clause). Two more are the runner's job and are documented in docs/sources/edmtrain.md: data older than
 * 24h must not be displayed, and past events must not be stored.
 *
 * Source quirks (docs + fixture tests/fixtures/edmtrain_docs_sample.json):
 *  - `name` is null unless the event has no artists (festivals, branded parties); otherwise the lineup is the title.
 *  - `b2bInd: true` means "back to back with the NEXT artist in the list", for runs of any length.
 *  - `startTime` / `endTime` exist only for livestreams; physical events are date-only, so hasTime is always false.
 *  - Auth/param failures come back as HTTP 200 with {"success":false,"message":"Invalid client"}; a request with no
 *    client key at all is an HTTP 400 HTML page (surfaces as HttpError).
 *  - No prices, ticket links, images or genres — only electronicGenreInd / otherGenreInd flags.
 *  - venue latitude/longitude carry 2–3 decimals (hundreds of metres): good enough for a borough, not for a pin.
 */
import { env, requireEnv, type Env } from '../lib/env.js';
import { fetchJson } from '../lib/http.js';
import { parseAge } from '../lib/normalize.js';
import { baseListing, type FetchContext, type FetchResult, type NormalizedListing, type SourceAdapter } from './types.js';

export const EDMTRAIN_EVENTS_URL = 'https://edmtrain.com/api/events';
/** EDMTrain location id for New York City. 38 is New York state (Buffalo, Syracuse, ... also match). */
export const EDMTRAIN_NYC_LOCATION_ID = 70;

const KEY_VAR = 'EDMTRAIN_CLIENT_KEY';
const ACK_VAR = 'NOCT_EDMTRAIN_ACCEPT_TERMS';

export interface EdmtrainArtist {
  id: number;
  name: string;
  link: string;
  /** true = performs back to back with the NEXT artist in artistList */
  b2bInd: boolean;
}

export interface EdmtrainVenue {
  id: number;
  name: string;
  /** "City, ST" */
  location: string;
  address: string | null;
  /** full state name, e.g. "New York" */
  state: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
}

export interface EdmtrainEvent {
  id: number;
  /** must be shown to users unmodified (API terms, Attribution) */
  link: string;
  name: string | null;
  /** "21+", "18+", "All Ages", ... or null */
  ages: string | null;
  festivalInd: boolean;
  livestreamInd: boolean;
  electronicGenreInd: boolean;
  otherGenreInd: boolean;
  /** local calendar date YYYY-MM-DD */
  date: string;
  /** livestreams only */
  startTime: string | null;
  endTime: string | null;
  createdDate: string;
  venue: EdmtrainVenue;
  artistList: EdmtrainArtist[];
}

export interface EdmtrainResponse {
  data: EdmtrainEvent[];
  success: boolean;
  /** set when success is false, e.g. "Invalid client" */
  message?: string;
}

export function edmtrainEnabled(e: Env): { ok: true } | { ok: false; reason: string } {
  const hasKey = Boolean(env(KEY_VAR, undefined, e));
  const hasAck = env(ACK_VAR, undefined, e) === '1';
  if (hasKey && hasAck) return { ok: true };
  const missing: string[] = [];
  if (!hasKey) missing.push(`${KEY_VAR} is not set`);
  if (!hasAck) missing.push(`${ACK_VAR} is not '1' (EDMTrain's API terms forbid multi-source discovery apps; set it only under a written arrangement with EDM Train LLC)`);
  return { ok: false, reason: missing.join('; ') };
}

export function buildEdmtrainUrl(p: { key: string; fromDate: string; toDate: string; locationId?: number }): string {
  const q = new URLSearchParams({
    locationIds: String(p.locationId ?? EDMTRAIN_NYC_LOCATION_ID),
    startDate: p.fromDate,
    endDate: p.toDate,
    // livestreams have a start time but no New York room; excluded server-side and again in parse
    livestreamInd: 'false',
    client: p.key,
  });
  return `${EDMTRAIN_EVENTS_URL}?${q}`;
}

/** The request URL with the client key masked, for logs and error messages. */
export function redactEdmtrainUrl(url: string): string {
  return url.replace(/([?&]client=)[^&]*/, '$1***');
}

/** Fold b2bInd chains into billing lines: [A(b2b), B, C] -> ["A b2b B", "C"]. */
export function groupLineup(artists: EdmtrainArtist[] | null | undefined): string[] {
  const lines: string[] = [];
  let run: string[] = [];
  for (const a of artists ?? []) {
    const name = a.name?.trim();
    if (!name) continue;
    run.push(name);
    if (!a.b2bInd) {
      lines.push(run.join(' b2b '));
      run = [];
    }
  }
  // a dangling b2bInd on the last artist has nothing to chain to; close the group rather than drop it
  if (run.length) lines.push(run.join(' b2b '));
  return lines;
}

function finiteOrNull(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function toListing(ev: EdmtrainEvent): NormalizedListing {
  const lineup = groupLineup(ev.artistList);
  const v = ev.venue;
  return baseListing({
    source: 'edmtrain',
    sourceId: String(ev.id),
    sourceUrl: ev.link,
    raw: ev,
    title: ev.name?.trim() || lineup.join(', ') || `Event at ${v.name}`,
    hasTime: false,
    night: ev.date,
    venueName: v.name ?? null,
    venueAddress: v.address ?? v.location ?? null,
    venueSourceId: v.id === undefined || v.id === null ? null : String(v.id),
    venueLat: finiteOrNull(v.latitude),
    venueLng: finiteOrNull(v.longitude),
    lineup,
    ageMin: parseAge(ev.ages),
    sourceTags: {
      festivalInd: ev.festivalInd,
      electronicGenreInd: ev.electronicGenreInd,
      otherGenreInd: ev.otherGenreInd,
      createdDate: ev.createdDate,
      ages: ev.ages,
      artist_ids: (ev.artistList ?? []).map((a) => a.id),
    },
  });
}

/**
 * Pure: API payload -> listings. Throws when the API reports failure (HTTP 200 + success:false is how EDMTrain
 * signals a bad key). Livestreams and out-of-state venues are dropped and counted in warnings.
 */
export function parseEdmtrainEvents(payload: EdmtrainResponse): { listings: NormalizedListing[]; warnings: string[] } {
  if (!payload.success) throw new Error(`EDMTrain API error: ${payload.message ?? 'success=false without a message'}`);
  const listings: NormalizedListing[] = [];
  let livestreams = 0;
  let outOfState = 0;
  let undated = 0;
  for (const ev of payload.data ?? []) {
    if (ev.livestreamInd) { livestreams++; continue; }
    // locationIds=70 should already be NYC-only; the state check guards against a location-id mix-up upstream
    if (ev.venue?.state !== 'New York') { outOfState++; continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.date ?? '')) { undated++; continue; }
    listings.push(toListing(ev));
  }
  const warnings: string[] = [];
  if (livestreams) warnings.push(`skipped ${livestreams} livestream(s)`);
  if (outOfState) warnings.push(`skipped ${outOfState} event(s) whose venue.state is not "New York"`);
  if (undated) warnings.push(`skipped ${undated} event(s) without a YYYY-MM-DD date`);
  return { listings, warnings };
}

export const edmtrain: SourceAdapter = {
  key: 'edmtrain',
  displayName: 'EDMTrain',
  kind: 'api',
  priority: 40,
  feesIncludedDefault: false,
  tosNote:
    'Official Event Search API with an EDMTrain-issued client key (edmtrain.com/developer-api). The API Terms of Use ' +
    'forbid use in "an event discovery service that combines our events with other event sources", require the event ' +
    'link to be shown unmodified, cap cached data at 24 hours and forbid storing past events. Disabled unless both ' +
    'EDMTRAIN_CLIENT_KEY and NOCT_EDMTRAIN_ACCEPT_TERMS=1 are set. Date-only listings: no prices, images or genres.',
  enabled: edmtrainEnabled,
  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const url = buildEdmtrainUrl({ key: requireEnv(KEY_VAR, ctx.env), fromDate: ctx.fromDate, toDate: ctx.toDate });
    ctx.log.info('GET', { url: redactEdmtrainUrl(url) });
    const payload = await fetchJson<EdmtrainResponse>(url, { signal: ctx.signal });
    const { listings, warnings } = parseEdmtrainEvents(payload);
    ctx.log.info('parsed', { events: payload.data?.length ?? 0, listings: listings.length });
    const capped = ctx.limit !== undefined && listings.length > ctx.limit;
    return {
      listings: capped ? listings.slice(0, ctx.limit) : listings,
      // a capped run did not hand back everything it saw, so it must not drive tombstoning
      window: capped ? null : { start: ctx.fromDate, end: ctx.toDate },
      warnings,
    };
  },
};
