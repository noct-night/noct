/**
 * POST /api/publish?id=<uuid> — put one approved deck on Instagram.
 *
 * The only endpoint in the repo that says something in public under NOCT's name, so it is the most careful
 * one. Four things have to be true before a single Graph API call happens:
 *
 *   1. a valid studio session (api/_lib/studio.ts)
 *   2. the post's status is exactly 'approved' -- not queued, not passed, not already posted
 *   3. no other publish is in flight for it (claimed in a transaction, so two clicks cannot both win)
 *   4. the caption passes the house rules, and the deck fits a carousel
 *
 * There is no auto-publish and no cron that calls this. A weekly job may prepare a draft and send a nudge;
 * a person presses the button.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkCaption } from '../src/post/caption.js';
import { igCredentials, publishCarousel, PublishError, remainingQuota } from '../src/post/publish.js';
import { signedRenderPath } from '../src/post/sign.js';
import { claimForPublish, failPublish, finishPublish, PostConflict, recordContainers } from '../src/post/store.js';
import { createLogger } from '../src/lib/log.js';
import { env } from '../src/lib/env.js';
import { firstParam, sendJson } from './_lib/respond.js';
import { requireStudio } from './_lib/studio.js';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * Meta fetches `image_url` from the public internet, so the render URLs have to be absolute and reachable.
 * NOCT_PUBLIC_ORIGIN is the deployment's own canonical origin; VERCEL_URL is the per-deployment hostname,
 * which works but points at a preview URL on a preview deploy.
 */
function publicOrigin(req: VercelRequest, source = process.env): string {
  const configured = env('NOCT_PUBLIC_ORIGIN', undefined, source);
  if (configured) return configured.replace(/\/+$/, '');
  const vercel = env('VERCEL_URL', undefined, source);
  if (vercel) return `https://${vercel}`;
  const host = firstParam(req.headers['x-forwarded-host']) ?? firstParam(req.headers.host);
  const proto = firstParam(req.headers['x-forwarded-proto']) ?? 'https';
  return `${proto}://${host ?? 'localhost:3000'}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
    return;
  }
  if (!requireStudio(req, res)) return;

  const log = createLogger('api:publish');
  const id = firstParam(req.query.id);
  if (!id) {
    sendJson(res, 400, { error: 'id is required' }, NO_STORE);
    return;
  }

  let creds;
  try {
    creds = igCredentials();
  } catch {
    // Named explicitly: this is the failure someone will hit on a fresh deploy, and "unavailable" would
    // send them looking in the wrong place.
    sendJson(res, 503, { error: 'IG_USER_ID and IG_ACCESS_TOKEN are not set on this deployment' }, NO_STORE);
    return;
  }

  let claim;
  try {
    claim = await claimForPublish(id);
  } catch (err) {
    if (err instanceof PostConflict) {
      sendJson(res, 409, { error: err.message }, NO_STORE);
      return;
    }
    throw err;
  }

  const { post, runId } = claim;
  const problems = checkCaption(post.caption);
  if (problems.length) {
    await failPublish(runId, problems.map((p) => p.message).join(' '));
    sendJson(res, 422, { error: 'the caption needs fixing first', problems }, NO_STORE);
    return;
  }
  if (post.slides.length === 0) {
    await failPublish(runId, 'no slides');
    sendJson(res, 422, { error: 'this post has no slides' }, NO_STORE);
    return;
  }

  const origin = publicOrigin(req);
  const urls = post.slides.map(
    (slide) => `${origin}${signedRenderPath({ slide, treatment: post.treatment, grain: post.grain })}`,
  );

  try {
    const left = await remainingQuota(creds);
    if (left !== null && left < 1) {
      await failPublish(runId, 'content publishing quota exhausted');
      sendJson(res, 429, { error: 'Instagram’s 24 hour publishing quota is used up' }, NO_STORE);
      return;
    }

    const result = await publishCarousel(urls, post.caption, creds, log, {
      onChildren: (ids) => recordContainers(runId, ids),
      onCarousel: (containerId) => recordContainers(runId, [], containerId),
    });
    const updated = await finishPublish(runId, post.id, result.mediaId, result.permalink);
    log.info('published', { post: post.id, media: result.mediaId, slides: post.slides.length });
    sendJson(res, 200, { post: updated, permalink: result.permalink }, NO_STORE);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failPublish(runId, message);
    if (err instanceof PublishError) {
      log.error('publish failed', { post: post.id, step: err.step, error: message });
      sendJson(res, 502, { error: message, step: err.step }, NO_STORE);
      return;
    }
    log.error('publish failed', { post: post.id, error: message });
    sendJson(res, 500, { error: 'publish failed' }, NO_STORE);
  }
}
