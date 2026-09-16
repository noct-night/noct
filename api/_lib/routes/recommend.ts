/**
 * GET /api/recommend — events picked from the caller's own going/saved history.
 *
 * The caller's Supabase access token is forwarded to PostgREST so `auth.uid()` inside recommend_events()
 * (0015/0016) is Supabase's own verdict on who this is: NOCT never verifies or stores a JWT itself, and cannot be
 * tricked into profiling somebody else. The ids that come back are then shaped through the same event_feed
 * read model and shapeEvent() the feed uses, so the UI renders a recommendation exactly like any other card.
 *
 * Private by definition: no caching.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { recommendationsFor, FeedParamError } from '../../../src/feed/recommend.js';
import { createLogger } from '../../../src/lib/log.js';
import { firstParam, sendJson } from '../respond.js';

const NO_STORE = { 'cache-control': 'private, no-store' };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
    return;
  }
  const auth = req.headers.authorization;
  if (!auth || !/^Bearer\s+\S/i.test(auth)) {
    sendJson(res, 401, { error: 'a Supabase access token is required' }, NO_STORE);
    return;
  }
  const log = createLogger('api:recommend');
  try {
    const body = await recommendationsFor(auth, {
      limit: firstParam(req.query.limit),
      city: firstParam(req.query.city),
      days: firstParam(req.query.days),
      perVenue: firstParam(req.query.per_venue),
      night: firstParam(req.query.night),
    });
    sendJson(res, 200, body, NO_STORE);
  } catch (err) {
    if (err instanceof FeedParamError) {
      sendJson(res, 400, { error: err.message }, NO_STORE);
      return;
    }
    const error = err instanceof Error ? err.message : String(err);
    log.error('recommend failed', { error });
    sendJson(res, 500, { error: 'recommendations unavailable' }, NO_STORE);
  }
}
