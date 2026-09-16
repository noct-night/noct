/**
 * GET /api/night?e=<uuid>[&radius_km=4][&limit=3] -> the event and the rooms nearby that stay open later.
 *
 * Public and cacheable: the answer depends only on the listings, which change once a day. 404 when the event is
 * not listed (or no longer is), 400 for a malformed id or range.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { nightFor, FeedParamError, NightNotFound } from '../src/feed/night.js';
import { createLogger } from '../src/lib/log.js';
import { firstParam, sendJson } from './_lib/respond.js';

/* max-age so a browser reopening the same sheet within a couple of minutes does not ask again */
const CACHE = { 'cache-control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=900' };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
    return;
  }
  const log = createLogger('api:night');
  try {
    const body = await nightFor({ e: firstParam(req.query.e), radiusKm: firstParam(req.query.radius_km), limit: firstParam(req.query.limit) });
    sendJson(res, 200, body, CACHE);
  } catch (err) {
    if (err instanceof FeedParamError) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    if (err instanceof NightNotFound) {
      sendJson(res, 404, { error: err.message }, CACHE);
      return;
    }
    log.error('night failed', { error: err instanceof Error ? err.message : String(err) });
    sendJson(res, 500, { error: 'night unavailable' });
  }
}
