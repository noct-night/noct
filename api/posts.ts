/**
 * The studio's data API. Studio session required on every method.
 *
 *   GET    /api/posts                  every post, newest slot first
 *   GET    /api/posts?status=approved  one review state
 *   POST   /api/posts?draft=weekend    draft the coming weekend from the feed, or return the existing draft
 *   PATCH  /api/posts?id=<uuid>        caption, status, slides, treatment, grain
 *
 * Read-only for the account: nothing here reaches Instagram. Publishing is /api/publish and takes a
 * separate, deliberate action, so a mis-aimed PATCH cannot put anything in public.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildFeed } from '../src/feed/query.js';
import { draftWeekend } from '../src/post/draft.js';
import { listPosts, patchPost, PostConflict, upsertDraft } from '../src/post/store.js';
import { postPatchSchema, STATUSES, type PostStatus } from '../src/post/types.js';
import { weekendRange } from '../src/post/weekend.js';
import { createLogger } from '../src/lib/log.js';
import { firstParam, sendJson } from './_lib/respond.js';
import { requireStudio } from './_lib/studio.js';

const NO_STORE = { 'cache-control': 'no-store' };

async function list(req: VercelRequest, res: VercelResponse): Promise<void> {
  const status = firstParam(req.query.status);
  if (status !== undefined && !STATUSES.includes(status as PostStatus)) {
    sendJson(res, 400, { error: `status must be one of ${STATUSES.join(', ')}` }, NO_STORE);
    return;
  }
  sendJson(res, 200, { posts: await listPosts(status as PostStatus | undefined) }, NO_STORE);
}

/**
 * Draft the coming weekend.
 *
 * Idempotent by weekend: a second call updates the queued draft for that Friday rather than adding another.
 * If the deck for that weekend has already been approved, passed or published, it is left exactly as it is
 * and returned -- a decision she made is not something a redraft gets to undo.
 */
async function draft(req: VercelRequest, res: VercelResponse): Promise<void> {
  const log = createLogger('api:posts');
  const { from, to } = weekendRange();
  const feed = await buildFeed({ from, to });
  const deck = draftWeekend(feed);
  if (!deck) {
    sendJson(res, 200, { post: null, note: `the feed has no events for ${from} to ${to}` }, NO_STORE);
    return;
  }
  try {
    const post = await upsertDraft({ series: 'weekend', slot: deck.slot, slides: deck.slides, caption: deck.caption });
    log.info('weekend drafted', { slot: deck.slot, slides: deck.slides.length });
    sendJson(res, 200, { post }, NO_STORE);
  } catch (err) {
    if (err instanceof PostConflict) {
      sendJson(res, 409, { error: err.message }, NO_STORE);
      return;
    }
    throw err;
  }
}

async function patch(req: VercelRequest, res: VercelResponse): Promise<void> {
  const id = firstParam(req.query.id);
  if (!id) {
    sendJson(res, 400, { error: 'id is required' }, NO_STORE);
    return;
  }
  const body = postPatchSchema.safeParse(req.body);
  if (!body.success) {
    sendJson(res, 400, { error: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, NO_STORE);
    return;
  }
  try {
    sendJson(res, 200, { post: await patchPost(id, body.data) }, NO_STORE);
  } catch (err) {
    if (err instanceof PostConflict) {
      sendJson(res, 409, { error: err.message }, NO_STORE);
      return;
    }
    throw err;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!requireStudio(req, res)) return;
  const log = createLogger('api:posts');
  try {
    if (req.method === 'GET') return await list(req, res);
    if (req.method === 'POST' && firstParam(req.query.draft) === 'weekend') return await draft(req, res);
    if (req.method === 'PATCH') return await patch(req, res);
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST, PATCH' });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error('posts endpoint failed', { error, method: req.method });
    sendJson(res, 500, { error: 'studio unavailable' }, NO_STORE);
  }
}
