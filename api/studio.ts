/**
 * GET /studio — the review page, assembled and served by a function rather than as a static file.
 *
 * A static page cannot be gated: Vercel would serve it to anyone, and a `?studio=1` in the markup would be
 * decoration. Serving it from here means an unauthenticated visitor gets the sign-in door and nothing else
 * -- not the review markup, not the endpoint names, not the shape of the API.
 *
 * The source is four files under studio/ for the same reason the app is index.html + app.css + app.js: UI
 * work and page logic should not collide in one file. They are inlined into a single response because the
 * response is gated and its parts would otherwise need gating of their own.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createLogger } from '../src/lib/log.js';
import { sendJson } from './_lib/respond.js';
import { hasStudioSession, studioConfigured } from './_lib/studio.js';

/**
 * Where studio/ ends up depends on how the function was built, so try the candidates rather than assume.
 * vercel.json's `includeFiles` puts the directory in the bundle; locally the repo root is the cwd.
 */
function candidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(process.cwd(), 'studio'), join(here, '..', 'studio'), join(here, 'studio')];
}

async function readAsset(name: string): Promise<string> {
  const tried: string[] = [];
  for (const dir of candidates()) {
    const path = join(dir, name);
    try {
      return await readFile(path, 'utf8');
    } catch {
      tried.push(path);
    }
  }
  throw new Error(`could not find studio/${name}; looked in ${tried.join(', ')}`);
}

/** Inlined into <style> and <script>, so a literal </script> in the source must not end the block early. */
const safe = (s: string): string => s.replace(/<\/(script|style)/gi, '<\\/$1');

/** Both variants are static once built, so each is assembled once per instance and reused. */
const built = new Map<'in' | 'out', Promise<string>>();

/**
 * The page as a signed-in visitor sees it, or as a stranger does.
 *
 * Signed out gets the door and gate.js and nothing else: no studio markup, and no page.js, which would
 * otherwise describe every endpoint and every action the studio can take. The endpoints are gated
 * server-side either way -- this is not what stands between a stranger and the account -- but a page with
 * nothing to offer should not enumerate everything it would have offered.
 */
async function buildPage(signedIn: boolean): Promise<string> {
  const [html, css, gate, js] = await Promise.all([
    readAsset('page.html'), readAsset('page.css'), readAsset('gate.js'), readAsset('page.js'),
  ]);
  const base = html.replace('/*noct:css*/', () => safe(css)).replace('/*noct:gate*/', () => safe(gate));
  return signedIn
    ? base.replace('/*noct:js*/', () => safe(js))
    : stripStudio(base).replace('/*noct:js*/', '');
}

function pageFor(signedIn: boolean): Promise<string> {
  const key = signedIn ? 'in' : 'out';
  let p = built.get(key);
  if (!p) {
    p = buildPage(signedIn);
    built.set(key, p);
  }
  return p;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD' });
    return;
  }
  const log = createLogger('api:studio');

  if (!studioConfigured()) {
    // Fails closed exactly like api/_lib/auth.ts: a production deploy with no password does not get a
    // wide-open publish button, it gets nothing.
    sendJson(res, 503, { error: 'the studio has no STUDIO_PASSWORD set on this deployment' }, { 'cache-control': 'no-store' });
    return;
  }

  try {
    // The door and the studio are one document, and the server decides which half exists. Without a
    // session the studio half is cut out of the response rather than hidden behind an attribute: markup
    // that is never sent is markup that cannot be read.
    const body = await pageFor(hasStudioSession(req));
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('x-robots-tag', 'noindex, nofollow');
    res.status(200).end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    built.clear();
    const error = err instanceof Error ? err.message : String(err);
    log.error('studio page failed', { error });
    sendJson(res, 500, { error: 'studio page unavailable' }, { 'cache-control': 'no-store' });
  }
}

const STUDIO_START = '<!--noct:studio-start-->';
const STUDIO_END = '<!--noct:studio-end-->';

/**
 * Everything between the studio markers, removed, and the door revealed in its place.
 *
 * Explicit markers rather than searching for a tag: the boundary of what a stranger may receive should be
 * stated in the markup, not inferred from whichever element happens to come next.
 */
export function stripStudio(html: string): string {
  const start = html.indexOf(STUDIO_START);
  const end = html.indexOf(STUDIO_END);
  if (start < 0 || end < 0) return html;
  return `${html.slice(0, start)}${html.slice(end + STUDIO_END.length)}`
    .replace('<div class="wrap" id="gateView" hidden>', '<div class="wrap" id="gateView">');
}
