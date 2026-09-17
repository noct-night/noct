/**
 * The studio's data API. Studio session required on every method.
 *
 *   GET    /api/posts                  every post, newest slot first
 *   GET    /api/posts?status=approved  one review state
 *   POST   /api/posts?draft=weekend    draft the coming weekend from the feed, or return the existing draft
 *   POST   /api/posts?draft=genre      draft up to three genre editions of the coming weekend
 *   POST   /api/posts?draft=spotlight  draft the three most anticipated nights of the next two weeks
 *   PATCH  /api/posts?id=<uuid>        caption, status, slides, treatment, grain
 *
 * Read-only for the account: nothing here reaches Instagram. Publishing is /api/publish and takes a
 * separate, deliberate action, so a mis-aimed PATCH cannot put anything in public.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildFeed } from '../src/feed/query.js';
import { draftWeekend } from '../src/post/draft.js';
import { draftGenreEditions, draftSpotlights, type EditionDraft } from '../src/post/editions.js';
import { localDatePlus } from '../src/lib/time.js';
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

/** How far ahead a spotlight may be. Two weeks: far enough to build anticipation, near enough to be listed. */
const SPOTLIGHT_DAYS = 14;

/**
 * Draft a batch of editions and store each one.
 *
 * One edition already approved, passed or published is a decision, so it is skipped and reported rather than
 * failing the whole batch -- the other two genre editions should still be drafted.
 */
async function draftEditions(res: VercelResponse, kind: 'genre' | 'spotlight'): Promise<void> {
  const log = createLogger('api:posts');
  const { from, to } = kind === 'genre' ? weekendRange() : { from: localDatePlus(0), to: localDatePlus(SPOTLIGHT_DAYS - 1) };
  const feed = await buildFeed({ from, to });
  const drafts: EditionDraft[] = kind === 'genre' ? draftGenreEditions(feed) : draftSpotlights(feed);
  if (drafts.length === 0) {
    const note = kind === 'genre'
      ? `no genre has enough nights for an edition between ${from} and ${to}`
      : `the feed has no events between ${from} and ${to}`;
    sendJson(res, 200, { posts: [], note }, NO_STORE);
    return;
  }

  const posts = [];
  const skipped: string[] = [];
  for (const d of drafts) {
    try {
      posts.push(await upsertDraft({ series: d.series, slot: d.slot, edition: d.edition, slides: d.slides, caption: d.caption }));
    } catch (err) {
      if (!(err instanceof PostConflict)) throw err;
      skipped.push(err.message);
    }
  }
  log.info(`${kind} editions drafted`, { drafted: posts.length, skipped: skipped.length, from, to });
  sendJson(res, 200, { posts, skipped }, NO_STORE);
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
    if (req.method === 'POST' && firstParam(req.query.draft) === 'genre') return await draftEditions(res, 'genre');
    if (req.method === 'POST' && firstParam(req.query.draft) === 'spotlight') return await draftEditions(res, 'spotlight');
    if (req.method === 'PATCH') return await patch(req, res);
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST, PATCH' });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error('posts endpoint failed', { error, method: req.method });
    sendJson(res, 500, { error: 'studio unavailable' }, NO_STORE);
  }
}
