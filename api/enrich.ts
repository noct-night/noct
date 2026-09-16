/**
 * GET|POST /api/enrich — run the genre / vibe enrichment pass (src/enrich/run.ts).
 * Called by pg_cron through noct_call() (0008_cron.sql), by Vercel Cron (vercel.json) and by hand.
 *
 *   ?limit=50          max events to classify in this call (default 50, max 500 — one Opus call is ~1-3 s)
 *   ?force=1           re-run even when input_hash is unchanged (after a prompt or rules change)
 *   ?event_id=<uuid>   only these events (repeatable or comma-separated); still skipped when unchanged unless force
 *
 * Auth is the ingest endpoints' bearer gate: `Authorization: Bearer $CRON_SECRET`; with CRON_SECRET unset the
 * route is open only outside production. Per-event classifier failures are reported inside the 200 summary
 * (each event has its own classification_run row); only a failure of the runner itself is a 500.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runEnrichment, type EnrichSummary } from '../src/enrich/run.js';
import { resolveArtistTracks, type ArtistTracksSummary } from '../src/enrich/artist_tracks.js';
import { createLogger } from '../src/lib/log.js';
import { requireCron } from './_lib/auth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIMIT = 500;

/** Vercel hands repeated query keys over as arrays. */
function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function parseLimit(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  return n;
}

function parseEventIds(v: string | string[] | undefined): string[] {
  const ids = (Array.isArray(v) ? v : v ? [v] : []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  const bad = ids.find((id) => !UUID_RE.test(id));
  if (bad) throw new Error(`event_id "${bad}" is not a uuid`);
  return ids;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('allow', 'GET, POST');
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  if (!requireCron(req, res)) return;
  const log = createLogger('api:enrich');
  const started = Date.now();
  let limit: number | undefined;
  let eventIds: string[];
  try {
    limit = parseLimit(first(req.query.limit));
    eventIds = parseEventIds(req.query.event_id);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const force = ['1', 'true', 'yes'].includes((first(req.query.force) ?? '').toLowerCase());
  try {
    const summary: EnrichSummary = await runEnrichment({ limit, force, eventIds: eventIds.length ? eventIds : undefined, log });
    // Then, in whatever the classifier left of the 300 s, look up representative tracks for artists on
    // upcoming nights (Apple allows ~20 calls a minute, so this is a few dozen names a day; the backlog is
    // worked off with `npm run noct -- tracks`). Its failures never fail the run: it is a lookup, not a write
    // anyone is waiting on.
    let tracks: ArtistTracksSummary | { error: string } | undefined;
    if (!eventIds.length) {
      const left = 285_000 - (Date.now() - started);
      if (left > 15_000) {
        try { tracks = await resolveArtistTracks({ budgetMs: left - 10_000, log: log.child('tracks') }); }
        catch (err) { tracks = { error: err instanceof Error ? err.message : String(err) }; }
      }
    }
    // With a fallback chain, a primary that is out of quota is the chain working, not the run failing: every
    // event still got classified. Report failure only when something was actually left undone.
    const ok = summary.errors.length === 0
      || (summary.classified + summary.skipped >= summary.considered && !summary.deferred && !summary.quotaStopped);
    res.status(200).json({ ok, force, limit, eventIds, ...summary, tracks, ms: Date.now() - started });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error('enrich run failed', { error });
    res.status(500).json({ ok: false, error, ms: Date.now() - started });
  }
}
