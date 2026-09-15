/**
 * GET /api/img?src=<flyer url>&treatment=none|mono|crush|warm&fit=cover|contain — one flyer, treated, as JPEG.
 *
 * This one endpoint answers three separate problems at once: the review page can display a flyer that its
 * origin would otherwise not let it load, the browser can composite one into a canvas, and Meta can fetch
 * one from a public URL. That is why it is public and why it sends permissive CORS.
 *
 * Public does not mean open. `src` must be on the allowlist in src/post/image.ts, which is the set of image
 * CDNs the adapters actually put in `image_url` -- an image proxy that fetches anything is a server-side
 * request forgery hole, and this one fetches nine hostnames.
 *
 * Flyers do not change, so a rendered result is cached hard at the edge and Postgres is never involved.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchImage, ImageSourceError, treatedJpeg } from '../src/post/image.js';
import { fitSchema, treatmentSchema } from '../src/post/types.js';
import { createLogger } from '../src/lib/log.js';
import { firstParam, sendJson } from './_lib/respond.js';

const NO_STORE = { 'cache-control': 'no-store' };

/** A year at the edge. The URL names the flyer and the treatment, so the same URL is always the same JPEG. */
const CACHE = {
  'cache-control': 'public, max-age=3600, s-maxage=31536000, immutable',
  'vercel-cdn-cache-control': 's-maxage=31536000',
  'access-control-allow-origin': '*',
  'content-type': 'image/jpeg',
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD' });
    return;
  }
  const log = createLogger('api:img');
  const src = firstParam(req.query.src);
  if (!src) {
    sendJson(res, 400, { error: 'src is required' }, NO_STORE);
    return;
  }
  const treatment = treatmentSchema.safeParse(firstParam(req.query.treatment) ?? undefined);
  const fit = fitSchema.safeParse(firstParam(req.query.fit) ?? undefined);
  if (!treatment.success || !fit.success) {
    sendJson(res, 400, { error: 'treatment must be none|mono|crush|warm and fit cover|contain' }, NO_STORE);
    return;
  }

  try {
    const jpeg = await treatedJpeg(await fetchImage(src), treatment.data, fit.data);
    for (const [k, v] of Object.entries(CACHE)) res.setHeader(k, v);
    res.setHeader('content-length', String(jpeg.byteLength));
    res.status(200).end(req.method === 'HEAD' ? undefined : jpeg);
  } catch (err) {
    if (err instanceof ImageSourceError) {
      sendJson(res, err.status, { error: err.message }, NO_STORE);
      return;
    }
    const error = err instanceof Error ? err.message : String(err);
    log.error('img failed', { error });
    sendJson(res, 502, { error: 'could not fetch or treat that image' }, NO_STORE);
  }
}
