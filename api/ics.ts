/**
 * GET /api/ics?e=<uuid> -> the night as an .ics file.
 *
 * iOS Safari opens text/calendar straight into the Add to Calendar sheet; everything else downloads it and
 * the calendar app imports. Public and cacheable: it is the same file for everybody.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { icsFor } from '../src/feed/ics.js';
import { FeedParamError } from '../src/feed/query.js';
import { createLogger } from '../src/lib/log.js';
import { firstParam, sendJson } from './_lib/respond.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
    return;
  }
  const log = createLogger('api:ics');
  try {
    const { filename, body } = await icsFor(firstParam(req.query.e));
    res.setHeader('content-type', 'text/calendar; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${filename}"`);
    res.setHeader('cache-control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).send(body);
  } catch (err) {
    if (err instanceof FeedParamError) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    log.error('ics failed', { error: err instanceof Error ? err.message : String(err) });
    sendJson(res, 500, { error: 'calendar file unavailable' });
  }
}
