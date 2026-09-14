/**
 * GET /api/feed?from=YYYY-MM-DD&to=YYYY-MM-DD&area=Brooklyn — the nights in the shape index.html renders.
 * `&counts=1` returns per-night counts only (what the month calendar draws its grid from: ~1 KB instead of
 * the ~320 KB a month of full records would cost) and allows a wider range.
 * Public and read-only. Edge-cached five minutes, served stale for fifteen more while Vercel revalidates,
 * so a burst of phones on a Friday night costs one Postgres round trip per five minutes per range.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildCounts, buildFeed, FeedParamError } from '../src/feed/query.js';
import { feedCacheHeaders } from '../src/feed/shape.js';
import { createLogger } from '../src/lib/log.js';
import { firstParam, sendJson } from './_lib/respond.js';

const NO_STORE = { 'cache-control': 'no-store' };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
    return;
  }
  const log = createLogger('api:feed');
  try {
    const params = {
      from: firstParam(req.query.from),
      to: firstParam(req.query.to),
      area: firstParam(req.query.area),
      city: firstParam(req.query.city),
      includeAll: firstParam(req.query.all) === '1',
    };
    const body = firstParam(req.query.counts) === '1' ? await buildCounts(params) : await buildFeed(params);
    sendJson(res, 200, body, feedCacheHeaders());
  } catch (err) {
    if (err instanceof FeedParamError) {
      sendJson(res, 400, { error: err.message }, NO_STORE);
      return;
    }
    const error = err instanceof Error ? err.message : String(err);
    log.error('feed failed', { error });
    sendJson(res, 500, { error: 'feed unavailable' }, NO_STORE);
  }
}
