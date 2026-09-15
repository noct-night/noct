/**
 * GET /api/search?q=…            -> events, artists and venues matching the query
 * GET /api/search?artist=<uuid>  -> that artist's upcoming nights, shaped as feed cards
 *
 * Public and the same for everybody, so it caches briefly at the edge. Short, because a search that lags
 * behind tonight's ingest is worse than one that costs a query.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { artistEvents, search } from '../src/feed/search.js';
import { FeedParamError } from '../src/feed/query.js';
import { createLogger } from '../src/lib/log.js';
import { firstParam, sendJson } from './_lib/respond.js';

const CACHE = { 'cache-control': 'public, s-maxage=120, stale-while-revalidate=600' };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
    return;
  }
  const log = createLogger('api:search');
  try {
    const artist = firstParam(req.query.artist);
    if (artist) {
      sendJson(res, 200, await artistEvents(artist), CACHE);
      return;
    }
    sendJson(res, 200, await search(firstParam(req.query.q), firstParam(req.query.city), firstParam(req.query.limit)), CACHE);
  } catch (err) {
    if (err instanceof FeedParamError) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    log.error('search failed', { error: err instanceof Error ? err.message : String(err) });
    sendJson(res, 500, { error: 'search unavailable' });
  }
}
