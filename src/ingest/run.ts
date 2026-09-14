/**
 * Ingest runner: for each adapter, open an ingest_run row, fetch, persist through upsert_listing(), resolve
 * listings into canonical events, close the run, and (when the fetch fully enumerated a date window) sweep
 * tombstones. One adapter failing never stops the next one; every outcome is a row in ingest_run so
 * /api/health and the sources screen can show what happened and why.
 *
 * Runs from three places with the same code: the CLI (`npm run ingest -- ra`), Vercel functions behind
 * /api/ingest/* (300 s cap, hence the time budget) and — through those functions — pg_cron on Supabase.
 */
import { query, withTx } from '../lib/db.js';
import { envInt, type Env } from '../lib/env.js';
import { BlockedError } from '../lib/http.js';
import { createLogger, type Logger } from '../lib/log.js';
import { localDatePlus } from '../lib/time.js';
import { enabledAdapters, getAdapter } from '../sources/registry.js';
import type { FetchContext, FetchWindow, SourceAdapter } from '../sources/types.js';
import { persistListings } from './persist.js';

export interface IngestOptions {
  env?: Env;
  log?: Logger;
  /** adapter keys; empty = all enabled (NOCT_SOURCES or the whole registry) */
  sources?: string[];
  /** YYYY-MM-DD New York; default today */
  fromDate?: string;
  /** YYYY-MM-DD New York; default today + 30 */
  toDate?: string;
  /** cap on listings per source (smoke tests). A capped fetch never sets a tombstone window. */
  limit?: number;
  /** bypass the registry entirely (tests) */
  adapters?: SourceAdapter[];
  /** recorded on ingest_run.trigger: 'cli' | 'http' | 'vercel_cron' | 'pg_cron' | 'test' */
  trigger?: string;
}

export type IngestRunStatus = 'ok' | 'partial' | 'failed' | 'skipped';

export interface IngestRunSummary {
  source: string;
  runId: number | null;
  status: IngestRunStatus;
  seen: number;
  created: number;
  changed: number;
  resolved: number;
  /** listings tombstoned by this run's sweep */
  gone: number;
  warnings: number;
  durationMs: number;
  error?: string;
}

export interface IngestSummary {
  runs: IngestRunSummary[];
  skipped: Array<{ key: string; reason: string }>;
  startedAt: string;
  durationMs: number;
}

/** Vercel functions are capped at 300 s (vercel.json maxDuration); leave room to write the last run row. */
const DEFAULT_BUDGET_MS = 270_000;
const DEFAULT_SOURCE_TIMEOUT_MS = 240_000;
/** Below this much remaining budget a source is not started at all — better a clean 'skipped' than a half run. */
const MIN_REMAINING_MS = 30_000;
/** Headroom kept after a fetch for persistence + resolution when the budget, not the source timeout, is the bound. */
const FETCH_HEADROOM_MS = 20_000;
/** A run still 'running' after this long was killed mid-flight (Vercel timeout, Ctrl-C): mark it and move on. */
const STALE_RUN_MINUTES = 15;
/** resolve_pending() work per transaction. Keeps transactions short on the pooler and lets the budget interrupt. */
const RESOLVE_CHUNK = 200;
const MAX_ERROR_LEN = 2000;

interface RunCounts {
  seen: number;
  created: number;
  changed: number;
  resolved: number;
}

type StartResult = { runId: number } | { busy: number };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The text stored in ingest_run.error. 'BLOCKED:<vendor>' is what the sources screen and docs key on. */
export function describeError(err: unknown): string {
  let text: string;
  if (err instanceof BlockedError) text = `BLOCKED:${err.vendor} ${err.message}`;
  else if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) text = `TIMEOUT: ${err.message}`;
  else text = message(err);
  return text.length > MAX_ERROR_LEN ? `${text.slice(0, MAX_ERROR_LEN)}…` : text;
}

/** Runs the process abandoned (killed at maxDuration, Ctrl-C) would otherwise show as 'running' forever. */
async function reapAbandonedRuns(): Promise<number> {
  const r = await query(
    `update ingest_run set status = 'failed', finished_at = now(), error = 'abandoned: process ended before the run finished'
     where status = 'running' and started_at < now() - make_interval(mins => $1)`,
    [STALE_RUN_MINUTES],
  );
  return r.rowCount ?? 0;
}

/**
 * Open a run unless one for the same source is in flight. pg_cron and Vercel Cron can fire within seconds of
 * each other; the advisory lock makes the check-then-insert atomic so exactly one of them proceeds.
 */
async function startRun(sourceKey: string, trigger: string): Promise<StartResult> {
  return withTx(async (c) => {
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [`noct_ingest:${sourceKey}`]);
    const busy = await c.query<{ run_id: string }>(
      `select run_id from ingest_run where source_key = $1 and status = 'running'
         and started_at > now() - make_interval(mins => $2) order by started_at desc limit 1`,
      [sourceKey, STALE_RUN_MINUTES],
    );
    if (busy.rows[0]) return { busy: Number(busy.rows[0].run_id) };
    const ins = await c.query<{ run_id: string }>(
      `insert into ingest_run (source_key, status, trigger) values ($1, 'running', $2) returning run_id`,
      [sourceKey, trigger],
    );
    return { runId: Number(ins.rows[0]!.run_id) };
  });
}

async function recordSkip(sourceKey: string, trigger: string, reason: string): Promise<number> {
  const r = await query<{ run_id: string }>(
    `insert into ingest_run (source_key, status, trigger, finished_at, error) values ($1, 'skipped', $2, now(), $3) returning run_id`,
    [sourceKey, trigger, reason],
  );
  return Number(r.rows[0]!.run_id);
}

async function finishRun(runId: number, status: 'ok' | 'partial', counts: RunCounts, warnings: string[], window: FetchWindow | null): Promise<void> {
  await query(
    `update ingest_run set status = $2, finished_at = now(), listings_seen = $3, listings_new = $4, listings_changed = $5,
       listings_resolved = $6, warnings = $7, window_start = $8, window_end = $9 where run_id = $1`,
    [runId, status, counts.seen, counts.created, counts.changed, counts.resolved, warnings, window?.start ?? null, window?.end ?? null],
  );
}

async function failRun(runId: number, error: string): Promise<void> {
  await query(`update ingest_run set status = 'failed', finished_at = now(), error = $2 where run_id = $1`, [runId, error]);
}

/**
 * resolve_listing() builds a temp table ON COMMIT DROP, so it must run inside an explicit transaction; chunking
 * keeps each transaction short and lets a near-exhausted budget stop between chunks instead of mid-flight.
 */
async function resolvePending(sourceKey: string, deadline: number): Promise<{ resolved: number; warnings: string[] }> {
  let resolved = 0;
  for (;;) {
    const n = await withTx(async (c) => {
      const r = await c.query<{ n: number }>('select resolve_pending($1, $2) as n', [sourceKey, RESOLVE_CHUNK]);
      return Number(r.rows[0]?.n ?? 0);
    });
    resolved += n;
    if (n < RESOLVE_CHUNK) return { resolved, warnings: [] };
    if (Date.now() > deadline - MIN_REMAINING_MS / 2) {
      return { resolved, warnings: ['resolution paused by the time budget; remaining listings resolve on the next run'] };
    }
  }
}

async function sweep(runId: number): Promise<number> {
  const r = await query<{ n: number }>('select tombstone_sweep($1) as n', [runId]);
  return Number(r.rows[0]?.n ?? 0);
}

/** The order of work for one adapter; every branch ends with the run row closed. */
async function runOne(
  adapter: SourceAdapter,
  runId: number,
  base: Omit<FetchContext, 'log' | 'signal'>,
  deadline: number,
  sourceTimeoutMs: number,
  log: Logger,
): Promise<IngestRunSummary> {
  const t0 = Date.now();
  const slog = log.child(adapter.key);
  const out: IngestRunSummary = { source: adapter.key, runId, status: 'ok', seen: 0, created: 0, changed: 0, resolved: 0, gone: 0, warnings: 0, durationMs: 0 };
  try {
    const fetchMs = Math.max(5_000, Math.min(sourceTimeoutMs, deadline - Date.now() - FETCH_HEADROOM_MS));
    const result = await adapter.fetch({ ...base, log: slog, signal: AbortSignal.timeout(fetchMs) });
    const persisted = await persistListings(result.listings, runId, slog);
    if (persisted.failed > 0 && persisted.seen === 0) {
      throw new Error(`none of ${result.listings.length} listings could be stored: ${persisted.warnings[0] ?? 'unknown'}`);
    }
    const pending = await resolvePending(adapter.key, deadline);
    const warnings = [...result.warnings, ...persisted.warnings, ...pending.warnings];

    // A window authorises tombstoning everything in it that this run did not see, so it is only honoured when the
    // fetch was complete: not capped by --limit, and not empty (an empty page from a changed site must not wipe a source).
    const truncated = base.limit !== undefined && result.listings.length >= base.limit;
    let window: FetchWindow | null = null;
    if (result.window && !truncated) {
      if (result.listings.length === 0) warnings.push('empty result with a window: window ignored, nothing tombstoned');
      else window = result.window;
    }

    const status = persisted.failed > 0 ? 'partial' : 'ok';
    Object.assign(out, { status, seen: persisted.seen, created: persisted.created, changed: persisted.changed, resolved: pending.resolved, warnings: warnings.length });
    await finishRun(runId, status, out, warnings, window);
    // tombstone_sweep() itself refuses anything but a completed 'ok' run with a window
    if (window && status === 'ok') out.gone = await sweep(runId);
    out.durationMs = Date.now() - t0;
    slog.info(`${adapter.key} ${status}`, {
      runId, seen: out.seen, new: out.created, changed: out.changed, resolved: out.resolved, gone: out.gone,
      warnings: out.warnings, window: window ? `${window.start}..${window.end}` : null, ms: out.durationMs,
    });
    return out;
  } catch (err) {
    const error = describeError(err);
    out.status = 'failed';
    out.error = error;
    out.durationMs = Date.now() - t0;
    await failRun(runId, error).catch((e) => slog.error('could not record the failure', { runId, error: message(e) }));
    slog.error(`${adapter.key} failed`, { runId, error, ms: out.durationMs });
    return out;
  }
}

function planAdapters(env: Env, opts: IngestOptions): SourceAdapter[] {
  if (opts.adapters) return opts.adapters;
  const { run, skipped } = enabledAdapters(env, opts.sources);
  // disabled adapters are kept in the plan so they get a 'skipped' run row saying why (missing key, licence)
  return [...run, ...skipped.map((s) => getAdapter(s.key))];
}

export async function runIngest(opts: IngestOptions = {}): Promise<IngestSummary> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? createLogger('ingest');
  const trigger = opts.trigger ?? 'cli';
  const t0 = Date.now();
  const deadline = t0 + envInt('NOCT_RUN_BUDGET_MS', DEFAULT_BUDGET_MS, env);
  const sourceTimeoutMs = envInt('NOCT_SOURCE_TIMEOUT_MS', DEFAULT_SOURCE_TIMEOUT_MS, env);
  const base: Omit<FetchContext, 'log' | 'signal'> = {
    env,
    fromDate: opts.fromDate ?? localDatePlus(0),
    toDate: opts.toDate ?? localDatePlus(30),
    limit: opts.limit,
  };
  const summary: IngestSummary = { runs: [], skipped: [], startedAt: new Date(t0).toISOString(), durationMs: 0 };

  const reaped = await reapAbandonedRuns();
  if (reaped) log.warn(`marked ${reaped} abandoned run(s) as failed`);

  const skip = async (adapter: SourceAdapter, reason: string): Promise<void> => {
    const runId = await recordSkip(adapter.key, trigger, reason);
    summary.skipped.push({ key: adapter.key, reason });
    summary.runs.push({ source: adapter.key, runId, status: 'skipped', seen: 0, created: 0, changed: 0, resolved: 0, gone: 0, warnings: 0, durationMs: 0, error: reason });
    log.info(`${adapter.key} skipped`, { runId, reason });
  };

  for (const adapter of planAdapters(env, opts)) {
    const enabled = adapter.enabled(env);
    if (!enabled.ok) {
      await skip(adapter, enabled.reason);
      continue;
    }
    if (deadline - Date.now() < MIN_REMAINING_MS) {
      await skip(adapter, 'time budget');
      continue;
    }
    const started = await startRun(adapter.key, trigger);
    if ('busy' in started) {
      await skip(adapter, `already running (run ${started.busy})`);
      continue;
    }
    summary.runs.push(await runOne(adapter, started.runId, base, deadline, sourceTimeoutMs, log));
  }

  summary.durationMs = Date.now() - t0;
  const by = (s: IngestRunStatus) => summary.runs.filter((r) => r.status === s).length;
  log.info('ingest finished', { trigger, ok: by('ok'), partial: by('partial'), failed: by('failed'), skipped: by('skipped'), ms: summary.durationMs });
  return summary;
}
