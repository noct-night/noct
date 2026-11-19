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
 * There is no auto-publish. A weekly job may prepare a draft and send a nudge; a person presses the button.
 * The scheduler does reach one corner of this endpoint -- `POST ?refresh=token` keeps the 60-day credential
 * from lapsing while the account is quiet (see src/post/token.ts) -- and that is all it can do here: it
 * cannot name a post, and it never sees the token.
 *
 * Either kind of post can end in a third way. Meta fetches the media itself -- the rendered slides of a
 * deck, the MP4 of a reel -- and `media_publish` refuses the container until it has. A long clip can
 * outlast this function, and a deck can be a second or two behind its own containers. So a publish may end
 * as 202: the container is recorded as 'pending' and pressing Publish again resumes it, which is a normal
 * outcome rather than a failure. See `MediaNotReady` in src/post/publish.ts and
 * supabase/migrations/0033_ig_reel_pending.sql.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkCaption } from '../src/post/caption.js';
import { attachCredits, withCredits } from '../src/post/photos.js';
import {
  igUserId, MediaNotReady, publishCarousel, publishReel, PublishError, remainingQuota, resumeCarousel,
  resumeReel, verifyCredentials, warmMedia,
} from '../src/post/publish.js';
import { currentToken, daysUntilExpiry, keepTokenAlive, tokenStatus, TokenError } from '../src/post/token.js';
import { signedRenderPath } from '../src/post/sign.js';
import { RENDER_VERSION } from '../src/post/templates.js';
import {
  claimForPublish, clearPending, failPublish, finishPublish, pausePublish, PostConflict, recordContainers,
  resumableContainer,
} from '../src/post/store.js';
import type { Slide, Treatment } from '../src/post/types.js';
import { createLogger } from '../src/lib/log.js';
import { env } from '../src/lib/env.js';
import { firstParam, sendJson } from './_lib/respond.js';
import { isAuthorized } from './_lib/auth.js';
import { hasStudioSession, requireStudio } from './_lib/studio.js';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * Meta fetches `image_url` from the public internet, so the render URLs have to be absolute and reachable.
 * NOCT_PUBLIC_ORIGIN is the deployment's own canonical origin; VERCEL_URL is the per-deployment hostname,
 * which works but points at a preview URL on a preview deploy.
 */
export function publicOrigin(req: VercelRequest, source = process.env): string {
  const configured = env('NOCT_PUBLIC_ORIGIN', undefined, source);
  if (configured) return configured.replace(/\/+$/, '');
  // The host the studio is actually being used on, ahead of VERCEL_URL: it is the domain whose edge cache
  // the previews have already warmed, and on a preview deploy VERCEL_URL is a hostname nobody else knows.
  const host = firstParam(req.headers['x-forwarded-host']) ?? firstParam(req.headers.host);
  if (host && !host.startsWith('localhost')) {
    return `${firstParam(req.headers['x-forwarded-proto']) ?? 'https'}://${host}`;
  }
  const vercel = env('VERCEL_URL', undefined, source);
  if (vercel) return `https://${vercel}`;
  return `http://${host ?? 'localhost:3000'}`;
}

/**
 * GET /api/publish — does the Instagram credential work?
 *
 * Posts nothing. Asks the account for its own handle, reads the remaining daily quota, and reports how
 * long the token has left. Worth having because the alternative way to discover a bad token is a failed
 * carousel halfway through, and because on this API the token expires every 60 days.
 */
async function preflight(req: VercelRequest, res: VercelResponse): Promise<void> {
  const log = createLogger('api:publish');
  try {
    const token = await currentToken(log);
    const creds = { userId: igUserId(), token: token.token };
    const [account, quota] = await Promise.all([verifyCredentials(creds), remainingQuota(creds)]);
    sendJson(res, 200, {
      ok: true,
      account: account.username,
      token_days_left: daysUntilExpiry(token),
      posts_left_today: quota,
    }, NO_STORE);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('preflight failed', { error: message });
    sendJson(res, 200, { ok: false, error: message }, NO_STORE);
  }
}

/**
 * Publish a reel, resuming a container from an earlier attempt when there is one.
 *
 * Resuming is not an optimisation. Submitting the same video again would start a second transcode at Meta
 * and leave the first container to expire unused, and the 24-hour window on it is exactly what makes a
 * timed-out publish recoverable in the first place.
 */
async function publishTheReel(
  post: { id: string; caption: string; video_url: string | null; cover_url: string | null },
  runId: string,
  creds: { userId: string; token: string },
  log: ReturnType<typeof createLogger>,
) {
  const pending = await resumableContainer(post.id);
  if (pending) {
    log.info('found a container to resume', { post: post.id, container: pending.containerId });
    return await resumeReel(pending.containerId, creds, log);
  }
  return await publishReel(
    { videoUrl: post.video_url!, coverUrl: post.cover_url, caption: post.caption },
    creds, log,
    { onContainer: (id) => recordContainers(runId, [], id) },
  );
}

/**
 * Publish a carousel, resuming the container from an earlier attempt when there is one.
 *
 * Same reasoning as a reel: the containers from the parked run are valid for 24 hours, and building a
 * second set would re-render every slide and leave the first set to expire unused.
 */
async function publishTheDeck(
  post: { id: string; slides: Slide[]; treatment: Treatment; grain: boolean },
  runId: string,
  creds: { userId: string; token: string },
  log: ReturnType<typeof createLogger>,
  origin: string,
  caption: string,
) {
  const pending = await resumableContainer(post.id);
  if (pending) {
    log.info('found a deck container to resume', { post: post.id, container: pending.containerId });
    return await resumeCarousel(pending.containerId, creds, log);
  }
  const urls = post.slides.map(
    (slide) => `${origin}${signedRenderPath({ slide, treatment: post.treatment, grain: post.grain, v: RENDER_VERSION })}`,
  );
  // Rendered and cached before Meta is told about them: see warmMedia.
  await warmMedia(urls, log);
  return await publishCarousel(
    urls,
    caption, creds, log,
    {
      onChildren: (ids) => recordContainers(runId, ids),
      onCarousel: (containerId) => recordContainers(runId, [], containerId),
    },
  );
}

/**
 * POST /api/publish?refresh=token — the weekly keep-alive. Posts nothing, says nothing in public.
 *
 * 503 rather than 500 when the token is past saving: the deployment is one credential away from working,
 * and the message says which one. The failure is loud on purpose -- it is the only warning anybody gets
 * before a Thursday deck has nowhere to go.
 */
async function refresh(res: VercelResponse): Promise<void> {
  const log = createLogger('api:publish');
  try {
    const { days_left, refreshed } = await keepTokenAlive(log);
    log.info('token keep-alive', { days_left, refreshed });
    sendJson(res, 200, { ok: true, refreshed, token_days_left: days_left }, NO_STORE);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('token keep-alive failed', { error: message });
    sendJson(res, 503, { ok: false, error: message }, NO_STORE);
  }
}

/**
 * GET /api/publish?status=token — how long the credential has, read from the row and nothing else.
 *
 * Separate from the preflight above because the studio asks this on every dashboard load and the preflight
 * costs two Graph calls. This one is a single column: enough to put a warning on the dashboard while the
 * token can still be saved, which is the part that was missing when it lapsed.
 */
async function status(res: VercelResponse): Promise<void> {
  sendJson(res, 200, await tokenStatus(), NO_STORE);
}

/**
 * Who may ask for this.
 *
 * A studio session, as ever. And the scheduler, for the keep-alive alone: refreshing a credential is the
 * one thing here that publishes nothing, and it has to happen on weeks when nobody opens the studio --
 * which is precisely how the token lapsed in November. Everything else on this endpoint still wants a
 * person, because everything else can speak under NOCT's name.
 */
export function mayProceed(req: VercelRequest, res: VercelResponse): boolean {
  if (hasStudioSession(req)) return true;
  // Nothing but the keep-alive: a caller that also names a post is not the keep-alive, whichever branch
  // below would have won, and the scheduler has no reason to know a post id in the first place.
  const refreshing = req.method === 'POST'
    && firstParam(req.query.refresh) === 'token'
    && !firstParam(req.query.id);
  if (refreshing && isAuthorized(req)) {
    createLogger('api:publish').info('refreshing the token for the scheduler');
    return true;
  }
  return requireStudio(req, res);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST' && req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST' });
    return;
  }
  if (!mayProceed(req, res)) return;
  if (req.method === 'POST' && firstParam(req.query.refresh) === 'token') return await refresh(res);
  if (req.method === 'GET' && firstParam(req.query.status) === 'token') return await status(res);
  if (req.method === 'GET') return await preflight(req, res);

  const log = createLogger('api:publish');
  const id = firstParam(req.query.id);
  if (!id) {
    sendJson(res, 400, { error: 'id is required' }, NO_STORE);
    return;
  }

  let creds;
  try {
    // The id comes from the environment; the token comes from the store, which refreshes it when it is
    // within two weeks of its 60-day expiry. Doing this before the claim means a dead credential fails
    // without marking a publish attempt against the post.
    const token = await currentToken(log);
    creds = { userId: igUserId(), token: token.token };
    const left = daysUntilExpiry(token);
    if (left !== null && left < 7) log.warn('Instagram token is close to expiry', { days_left: left });
  } catch (err) {
    // Named explicitly: this is the failure someone will hit on a fresh deploy, and "unavailable" would
    // send them looking in the wrong place.
    const detail = err instanceof TokenError ? err.message : 'IG_USER_ID and IG_ACCESS_TOKEN are not set on this deployment';
    sendJson(res, 503, { error: detail }, NO_STORE);
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
  // Photo credits join the caption here, at the last moment, so redrafting or editing can never drop one.
  // The house rules and the 2200 limit are checked against what will actually be posted.
  const [withPhotos] = await attachCredits([post]);
  const caption = withCredits(post.caption, withPhotos?.credits ?? []);
  const problems = checkCaption(caption);
  if (problems.length) {
    await failPublish(runId, problems.map((p) => p.message).join(' '));
    sendJson(res, 422, { error: 'the caption needs fixing first', problems }, NO_STORE);
    return;
  }
  // Each kind is checked for its own media before anything reaches the Graph API. The database enforces
  // this too (ig_post_kind_has_media), but a 422 naming the problem beats a 23514 from Postgres.
  if (post.kind === 'reel') {
    if (!post.video_url || post.video_url.startsWith('pending:')) {
      await failPublish(runId, 'no video');
      sendJson(res, 422, { error: 'this reel has no uploaded video; run npm run clip again' }, NO_STORE);
      return;
    }
  } else if (post.slides.length === 0) {
    await failPublish(runId, 'no slides');
    sendJson(res, 422, { error: 'this post has no slides' }, NO_STORE);
    return;
  }

  try {
    const left = await remainingQuota(creds);
    if (left !== null && left < 1) {
      await failPublish(runId, 'content publishing quota exhausted');
      sendJson(res, 429, { error: 'Instagram’s 24 hour publishing quota is used up' }, NO_STORE);
      return;
    }

    const result = post.kind === 'reel'
      ? await publishTheReel(post, runId, creds, log)
      : await publishTheDeck(post, runId, creds, log, publicOrigin(req), caption);

    // A resumed publish may have gone out from a run other than this one's original container, so any
    // other pending run for this post is closed out before the post is marked posted.
    await clearPending(post.id, runId);
    const updated = await finishPublish(runId, post.id, result.mediaId, result.permalink);
    log.info('published', {
      post: post.id, kind: post.kind, media: result.mediaId,
      ...(post.kind === 'reel' ? {} : { slides: post.slides.length }),
    });
    sendJson(res, 200, { post: updated, permalink: result.permalink }, NO_STORE);
  } catch (err) {
    // Not a failure: the container is alive and the work is resumable, so the run is parked rather than
    // failed and the studio is told to press Publish again. Failing here would strand the container.
    if (err instanceof MediaNotReady) {
      await pausePublish(runId, err.containerId, err.message);
      log.info('media still processing; parked as pending', { post: post.id, kind: post.kind, container: err.containerId });
      sendJson(res, 202, { pending: true, error: err.message, container: err.containerId }, NO_STORE);
      return;
    }
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
