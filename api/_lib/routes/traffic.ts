/**
 * GET /api/traffic?days=30 — the traffic report (src/ops/traffic.ts) for the studio's Traffic tab: visits and
 * devices over the window with a seven-day slice, the daily series, sources, entry, city, device, language,
 * campaigns, action counts and the funnel. Aggregates over anonymous accounts, nothing per person.
 *
 * Studio session required: this is the owner's view of the owner's numbers. /api/health stays public and no
 * longer carries the block. Never cached: it is read by one person who just pressed Refresh.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '../../../src/lib/log.js';
import { trafficReport, WINDOW_DAYS } from '../../../src/ops/traffic.js';
import { firstParam, sendJson } from '../respond.js';
import { requireStudio } from '../studio.js';

/** the longest window the studio offers; the daily series follows it */
export const MAX_DAYS = 90;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
    return;
  }
  if (!requireStudio(req, res)) return;
  const days = Math.min(Math.max(Math.round(Number(firstParam(req.query.days))) || WINDOW_DAYS, 1), MAX_DAYS);
  const log = createLogger('api:traffic');
  try {
    sendJson(res, 200, await trafficReport(days), { 'cache-control': 'private, no-store' });
  } catch (err) {
    log.error('traffic report failed', { error: err instanceof Error ? err.message : String(err) });
    sendJson(res, 500, { error: 'traffic report unavailable' }, { 'cache-control': 'no-store' });
  }
}
