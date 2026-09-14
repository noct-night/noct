/**
 * SILO Brooklyn — venue-direct adapter.
 *
 * SILO's own website (www.silobrooklyn.com, Next.js) server-renders its DICE ticket widget, so the page's
 * `__NEXT_DATA__.props.pageProps.events.data` is the venue's full upcoming calendar in the DICE Events API v2
 * shape: ticket tiers with all-in prices, per-tier sold-out, genre_tags / type_tags, exact start/end, age.
 * We read the venue's public homepage (one GET a day), never DICE's API — no key involved. Records reuse the
 * DICE normaliser so a real DICE listing for the same event (same 6-char hash) would be the identical row.
 */
import { fetchText, BlockedError } from '../lib/http.js';
import { localMidnight } from '../lib/time.js';
import { normalizeEvent, parseStatus, type DiceEvent } from './dice.js';
import type { FetchContext, FetchResult, NormalizedListing, SourceAdapter } from './types.js';

export const SILO_URL = 'https://www.silobrooklyn.com/';

/** Pull the SSR event list out of the homepage HTML. Throws when the page shape changed (so the run fails loudly). */
export function parseSiloPage(html: string): { events: DiceEvent[]; buildId: string | null } {
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('silo: __NEXT_DATA__ not found — page layout changed?');
  let data: { buildId?: string; props?: { pageProps?: { events?: { data?: unknown } } } };
  try {
    data = JSON.parse(m[1] as string);
  } catch {
    throw new Error('silo: __NEXT_DATA__ is not JSON');
  }
  const list = data.props?.pageProps?.events?.data;
  if (!Array.isArray(list)) throw new Error('silo: pageProps.events.data missing — page layout changed?');
  return { events: list as DiceEvent[], buildId: data.buildId ?? null };
}

/** DICE rows re-keyed as SILO listings: same hash id, venue pinned to SILO, hard link to the DICE id. */
export function siloListing(e: DiceEvent): NormalizedListing {
  const l = normalizeEvent(e);
  return {
    ...l,
    source: 'silo',
    venueName: 'SILO Brooklyn',
    externalRefs: [{ source: 'dice', id: l.sourceId }],
    sourceTags: { ...l.sourceTags, via: 'silobrooklyn.com', dice_status: e.status ?? null, dice_flags_status: parseStatus(e.flags) },
  };
}

export function buildSiloListings(events: DiceEvent[], fromDate: string, toDate: string, limit?: number): { listings: NormalizedListing[]; dropped: number } {
  const from = localMidnight(fromDate).getTime();
  const to = localMidnight(toDate).getTime() + 30 * 3_600_000; // through 06:00 the morning after toDate
  const out: NormalizedListing[] = [];
  let dropped = 0;
  for (const e of events) {
    const l = siloListing(e);
    const start = l.startsAt ? Date.parse(l.startsAt) : NaN;
    if (!Number.isFinite(start) || start < from || start > to) { dropped++; continue; }
    out.push(l);
    if (limit && out.length >= limit) break;
  }
  return { listings: out, dropped };
}

async function fetchSilo(ctx: FetchContext): Promise<FetchResult> {
  let html: string;
  try {
    html = await fetchText(SILO_URL, { minIntervalMs: 2_000, signal: ctx.signal });
  } catch (err) {
    if (err instanceof BlockedError) ctx.log.warn('silo: blocked', { vendor: err.vendor, status: err.status });
    throw err;
  }
  const { events, buildId } = parseSiloPage(html);
  const { listings, dropped } = buildSiloListings(events, ctx.fromDate, ctx.toDate, ctx.limit);
  ctx.log.info('silo page parsed', { buildId, events: events.length, kept: listings.length, dropped });
  const truncated = ctx.limit !== undefined && listings.length >= ctx.limit;
  // The page lists every upcoming DICE event for the venue, so within the requested range it is complete.
  return { listings, window: truncated ? null : { start: ctx.fromDate, end: ctx.toDate }, warnings: [] };
}

export const silo: SourceAdapter = {
  key: 'silo',
  displayName: 'DICE · SILO',
  kind: 'feed',
  priority: 75,
  feesIncludedDefault: true,
  tosNote:
    "SILO Brooklyn's own website embeds its DICE calendar as page data; NOCT reads that public page once a day. " +
    'Ticket links point to dice.fm. No DICE API, no key. Same posture as the other venue-direct feeds.',
  enabled: () => ({ ok: true }),
  fetch: fetchSilo,
};
