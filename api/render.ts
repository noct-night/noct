/**
 * The slide renderer.
 *
 *   GET  /api/render?p=<payload>&sig=<hmac>  -> the composed 1080x1350 JPEG
 *   POST /api/render                          -> signed GET URLs for a deck (studio session required)
 *
 * The split exists because two different callers need two different kinds of permission. The review page
 * is a person with a session and can be asked to sign in. Meta is a fetcher on someone else's infrastructure
 * that arrives with no credentials at all and simply requests the `image_url` it was handed -- so the GET
 * has to be open to anyone holding the URL, and the signature is what makes holding the URL mean something.
 *
 * JPEG rather than PNG: Instagram rejects PNG on the media endpoints.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { renderSlide } from '../src/post/render.js';
import { decodePayload, SignatureError, signedRenderPath, verify } from '../src/post/sign.js';
import { ImageSourceError } from '../src/post/image.js';
import {
  CAROUSEL_MAX, renderRequestSchema, slideSchema, treatmentSchema, type RenderRequest,
} from '../src/post/types.js';
import { createLogger } from '../src/lib/log.js';
import { firstParam, sendJson } from './_lib/respond.js';
import { requireStudio } from './_lib/studio.js';

const NO_STORE = { 'cache-control': 'no-store' };

/** What POST /api/render accepts: a whole deck under one look, so one round trip re-signs every slide. */
const renderDeckSchema = z.object({
  slides: z.array(slideSchema).min(1).max(CAROUSEL_MAX),
  treatment: treatmentSchema,
  grain: z.boolean().default(false),
});

/**
 * The payload names every input that affects the pixels, so one URL is always one image. A day at the edge
 * is plenty: Meta fetches within seconds of the publish, and the review page re-requests while she works.
 */
const CACHE = {
  'cache-control': 'public, max-age=300, s-maxage=86400',
  'vercel-cdn-cache-control': 's-maxage=86400',
  'access-control-allow-origin': '*',
  'content-type': 'image/jpeg',
};

async function renderOne(req: VercelRequest, res: VercelResponse): Promise<void> {
  const log = createLogger('api:render');
  const payload = firstParam(req.query.p);
  const sig = firstParam(req.query.sig);
  if (!payload || !sig) {
    sendJson(res, 400, { error: 'p and sig are required' }, NO_STORE);
    return;
  }
  try {
    verify(payload, sig);
  } catch (err) {
    // A deployment with no signing secret is a misconfiguration, not a bad request, and saying "bad
    // signature" would send someone looking at the caller instead of at the environment.
    if (err instanceof SignatureError && err.message.includes('NOCT_RENDER_SECRET')) {
      log.error('render is not configured to verify signatures', { error: err.message });
      sendJson(res, 503, { error: err.message }, NO_STORE);
      return;
    }
    // Otherwise deliberately terse: a signature oracle should not explain itself.
    sendJson(res, 403, { error: 'bad signature' }, NO_STORE);
    return;
  }

  let request: RenderRequest;
  try {
    request = renderRequestSchema.parse(decodePayload(payload));
  } catch (err) {
    sendJson(res, 400, { error: `invalid slide: ${err instanceof Error ? err.message : String(err)}` }, NO_STORE);
    return;
  }

  try {
    const jpeg = await renderSlide(request.slide, { treatment: request.treatment, grain: request.grain });
    for (const [k, v] of Object.entries(CACHE)) res.setHeader(k, v);
    res.setHeader('content-length', String(jpeg.byteLength));
    res.status(200).end(req.method === 'HEAD' ? undefined : jpeg);
  } catch (err) {
    if (err instanceof ImageSourceError) {
      sendJson(res, err.status, { error: err.message }, NO_STORE);
      return;
    }
    const error = err instanceof Error ? err.message : String(err);
    log.error('render failed', { error, template: request.slide.template });
    sendJson(res, 500, { error: 'could not render that slide' }, NO_STORE);
  }
}

/** Sign a deck's worth of slides. The queue calls this whenever the slides or the look change. */
async function signDeck(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireStudio(req, res)) return;
  const body = renderDeckSchema.safeParse(req.body);
  if (!body.success) {
    sendJson(res, 400, { error: 'body must be {slides: Slide[], treatment, grain}' }, NO_STORE);
    return;
  }
  const { slides, treatment, grain } = body.data;
  sendJson(
    res,
    200,
    { urls: slides.map((slide) => signedRenderPath({ slide, treatment, grain })) },
    NO_STORE,
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      await renderOne(req, res);
      return;
    }
    if (req.method === 'POST') {
      await signDeck(req, res);
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD, POST' });
  } catch (err) {
    if (err instanceof SignatureError) {
      sendJson(res, 500, { error: err.message }, NO_STORE);
      return;
    }
    throw err;
  }
}
