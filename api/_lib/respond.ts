/**
 * Request parsing + JSON responses shared by the ingest endpoints. /api/ingest/[source] and /api/ingest/all
 * are thin so Vercel's file routing stays obvious; the behaviour lives here.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runIngest } from '../../src/ingest/run.js';
import { createLogger } from '../../src/lib/log.js';
import { ADAPTERS } from '../../src/sources/registry.js';
import { requireCron } from './auth.js';

export class HttpProblem extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpProblem';
  }
}

export function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function sendJson(res: VercelResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.status(status).json(body);
}

/** A real calendar date in YYYY-MM-DD form: the shape alone lets 2026-13-01 through, so round-trip it. */
export function isCalendarDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function dateParam(q: VercelRequest['query'], key: string): string | undefined {
  const v = firstParam(q[key]);
  if (v === undefined || v === '') return undefined;
  if (!isCalendarDate(v)) throw new HttpProblem(400, `${key} must be a valid YYYY-MM-DD date`);
  return v;
}

function limitParam(q: VercelRequest['query']): number | undefined {
  const v = firstParam(q.limit);
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 10_000) throw new HttpProblem(400, 'limit must be an integer between 1 and 10000');
  return n;
}

/** What to record in ingest_run.trigger. Vercel Cron marks its calls; pg_cron sets x-noct-trigger in noct_call(). */
export function triggerOf(req: VercelRequest): string {
  const ua = firstParam(req.headers['user-agent']) ?? '';
  if (req.headers['x-vercel-cron-schedule'] || /^vercel-cron\//i.test(ua)) return 'vercel_cron';
  return firstParam(req.headers['x-noct-trigger']) ?? 'http';
}

/**
 * GET|POST with optional from, to (YYYY-MM-DD) and limit. Per-source failures are reported inside the 200
 * summary (each source has its own ingest_run row); only a failure of the runner itself is a 500.
 */
export async function handleIngest(req: VercelRequest, res: VercelResponse, source: string | undefined): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST' });
    return;
  }
  if (!requireCron(req, res)) return;
  const log = createLogger('api:ingest');
  try {
    const key = source && source !== 'all' ? source : undefined;
    if (key && !ADAPTERS.some((a) => a.key === key)) {
      throw new HttpProblem(404, `unknown source "${key}"; known: ${ADAPTERS.map((a) => a.key).join(', ')}, all`);
    }
    const fromDate = dateParam(req.query, 'from');
    const toDate = dateParam(req.query, 'to');
    const limit = limitParam(req.query);
    const trigger = triggerOf(req);
    const summary = await runIngest({ sources: key ? [key] : [], fromDate, toDate, limit, trigger, log });
    sendJson(res, 200, { ok: !summary.runs.some((r) => r.status === 'failed'), trigger, fromDate, toDate, limit, ...summary });
  } catch (err) {
    if (err instanceof HttpProblem) {
      sendJson(res, err.status, { error: err.message });
      return;
    }
    const error = err instanceof Error ? err.message : String(err);
    log.error('ingest endpoint failed', { error });
    sendJson(res, 500, { ok: false, error });
  }
}
