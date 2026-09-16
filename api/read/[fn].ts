/**
 * One Serverless Function for the small read endpoints.
 *
 * Vercel Hobby allows twelve functions per deployment and the repository passed that with the post studio.
 * search, taste, night, ics, health and recommend are each a few milliseconds of work behind a stable URL, so
 * they share this function: vercel.json rewrites /api/search -> /api/read/search and so on, the public URLs and
 * every handler's own headers, caching and status codes are unchanged, and the handlers themselves live in
 * api/_lib/routes/ (an underscored directory is not a function of its own).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { firstParam, sendJson } from '../_lib/respond.js';
import health from '../_lib/routes/health.js';
import ics from '../_lib/routes/ics.js';
import night from '../_lib/routes/night.js';
import recommend from '../_lib/routes/recommend.js';
import search from '../_lib/routes/search.js';
import taste from '../_lib/routes/taste.js';

type Route = (req: VercelRequest, res: VercelResponse) => Promise<void>;
const ROUTES: Record<string, Route> = { search, taste, night, ics, health, recommend };
const NAMES = Object.keys(ROUTES).join('|');
const FROM_PATH = new RegExp(`^/api/(?:read/)?(${NAMES})(?:/|\\?|$)`);

/** The endpoint asked for: from the request path when it names one (before or after the rewrite), else the route segment. */
export function routeName(req: Pick<VercelRequest, 'url' | 'query'>): string | null {
  const m = FROM_PATH.exec(req.url ?? '');
  if (m) return m[1] as string;
  const fn = firstParam(req.query.fn);
  return fn && Object.prototype.hasOwnProperty.call(ROUTES, fn) ? fn : null;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const name = routeName(req);
  const route = name ? ROUTES[name] : undefined;
  if (!route) {
    sendJson(res, 404, { error: 'no such endpoint' });
    return;
  }
  // the routes read their own parameters; `fn` belongs to the rewrite, not to the caller
  if (Array.isArray(req.query.fn) || req.query.fn !== undefined) delete req.query.fn;
  await route(req, res);
}
