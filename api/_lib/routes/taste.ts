/**
 * GET /api/taste            -> genres worth offering at onboarding, with how much each one has on
 * GET /api/taste?picks=1    -> a few real nights to tap, optionally narrowed by ?genres=a.b,c.d
 *
 * Public and identical for everybody, so it caches at the edge; nothing here depends on who is asking.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { tasteOptions, tastePicks } from '../../../src/feed/taste.js';
import { FeedParamError } from '../../../src/feed/query.js';
import { createLogger } from '../../../src/lib/log.js';
import { firstParam, sendJson } from '../respond.js';

const CACHE = { 'cache-control': 'public, s-maxage=1800, stale-while-revalidate=3600' };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
    return;
  }
  const log = createLogger('api:taste');
  try {
    const city = firstParam(req.query.city);
    if (firstParam(req.query.picks)) {
      const genres = (firstParam(req.query.genres) ?? '').split(',').map((g) => g.trim()).filter(Boolean);
      const limit = Math.min(Math.max(Number(firstParam(req.query.limit)) || 9, 1), 20);
      sendJson(res, 200, await tastePicks(city, genres, limit), CACHE);
      return;
    }
    sendJson(res, 200, await tasteOptions(city), CACHE);
  } catch (err) {
    if (err instanceof FeedParamError) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    log.error('taste failed', { error: err instanceof Error ? err.message : String(err) });
    sendJson(res, 500, { error: 'taste options unavailable' });
  }
}
