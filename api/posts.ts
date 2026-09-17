/**
 * The studio's data API. Studio session required on every method.
 *
 *   GET    /api/posts                  every post, newest slot first
 *   GET    /api/posts?status=approved  one review state
 *   POST   /api/posts?draft=weekend    draft the coming weekend from the feed, or return the existing draft
 *   POST   /api/posts?draft=genre      draft up to three genre editions of the coming weekend
 *   POST   /api/posts?draft=spotlight  draft the three most anticipated nights of the next two weeks
 *   POST   /api/posts?draft=venue      draft a post for each of the four busiest venues of the next two weeks
 *   GET    /api/posts?candidates=<uuid> the nights a weekend deck or genre edition can be built from
 *   POST   /api/posts?rebuild=<uuid>   rebuild that deck around chosen nights: {events: [feed event id, ...]}
 *   GET    /api/posts?cta=1            the words every new draft closes with
 *   PUT    /api/posts?cta=1            change them: {question, answer, link, note}
 *   PATCH  /api/posts?id=<uuid>        caption, status, slides, treatment, grain
 *
 * Read-only for the account: nothing here reaches Instagram. Publishing is /api/publish and takes a
 * separate, deliberate action, so a mis-aimed PATCH cannot put anything in public.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { buildFeed } from '../src/feed/query.js';
import { candidatesFor, cannotChoose, deckSource, deckWindow } from '../src/post/choose.js';
import { ctaSlide, currentCta, saveCta } from '../src/post/cta.js';
import type { FeedResponse } from '../src/feed/shape.js';
import { draftWeekend, HERO_MAX, type DeckOptions } from '../src/post/draft.js';
import { draftGenreEditions, draftSpotlights, draftVenuePosts, type EditionDraft } from '../src/post/editions.js';
import { attachCredits } from '../src/post/photos.js';
import { localDatePlus } from '../src/lib/time.js';
import { getPost, listPosts, patchPost, PostConflict, upsertDraft } from '../src/post/store.js';
import { ctaDataSchema, postPatchSchema, STATUSES, type Post, type PostStatus } from '../src/post/types.js';
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
  sendJson(res, 200, { posts: await attachCredits(await listPosts(status as PostStatus | undefined)) }, NO_STORE);
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
  const deck = draftWeekend(feed, { cta: ctaSlide(await currentCta()) });
  if (!deck) {
    sendJson(res, 200, { post: null, note: `the feed has no events for ${from} to ${to}` }, NO_STORE);
    return;
  }
  try {
    const post = await upsertDraft({ series: 'weekend', slot: deck.slot, slides: deck.slides, caption: deck.caption });
    log.info('weekend drafted', { slot: deck.slot, slides: deck.slides.length });
    sendJson(res, 200, { post: (await attachCredits([post]))[0] }, NO_STORE);
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
async function draftEditions(res: VercelResponse, kind: 'genre' | 'spotlight' | 'venue'): Promise<void> {
  const log = createLogger('api:posts');
  const { from, to } = kind === 'genre' ? weekendRange() : { from: localDatePlus(0), to: localDatePlus(SPOTLIGHT_DAYS - 1) };
  const feed = await buildFeed({ from, to });
  const cta = ctaSlide(await currentCta());
  const drafts: EditionDraft[] = kind === 'genre'
    ? draftGenreEditions(feed, undefined, undefined, cta)
    : kind === 'venue' ? draftVenuePosts(feed, undefined, undefined, cta) : draftSpotlights(feed, undefined, cta);
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
  sendJson(res, 200, { posts: await attachCredits(posts), skipped }, NO_STORE);
}

interface Deck {
  post: Post;
  feed: FeedResponse;
  opts: DeckOptions;
}

/** The post a choose-nights request is about, with the feed it is drawn from, or null once an error is sent. */
async function deckFor(res: VercelResponse, id: string | undefined): Promise<Deck | null> {
  if (!id) {
    sendJson(res, 400, { error: 'a post id is required' }, NO_STORE);
    return null;
  }
  const post = await getPost(id);
  if (!post) {
    sendJson(res, 404, { error: `no post ${id}` }, NO_STORE);
    return null;
  }
  const why = cannotChoose(post);
  if (why) {
    sendJson(res, 409, { error: why }, NO_STORE);
    return null;
  }
  const feed = await buildFeed(deckWindow(post.slot!));
  return { post, ...deckSource(post, feed) };
}

async function candidates(req: VercelRequest, res: VercelResponse): Promise<void> {
  const deck = await deckFor(res, firstParam(req.query.candidates));
  if (!deck) return;
  sendJson(res, 200, { ...candidatesFor(deck.feed, deck.post.slides), max: HERO_MAX }, NO_STORE);
}

const rebuildSchema = z.object({ events: z.array(z.string().min(1).max(200)).min(1).max(HERO_MAX) }).strict();

/**
 * Rebuild a deck around the nights she chose. Same path as a redraft (upsertDraft), so photos, per-slide
 * looks and rewritten slides for nights that stay in the deck are kept. Only a queued deck: an approved one
 * is a decision, and changing what it shows should start with taking the approval back.
 */
async function rebuild(req: VercelRequest, res: VercelResponse): Promise<void> {
  const log = createLogger('api:posts');
  const body = rebuildSchema.safeParse(req.body);
  if (!body.success) {
    sendJson(res, 400, { error: `choose between 1 and ${HERO_MAX} nights` }, NO_STORE);
    return;
  }
  const deck = await deckFor(res, firstParam(req.query.rebuild));
  if (!deck) return;
  if (deck.post.status !== 'queued') {
    sendJson(res, 409, { error: 'move this post back to the queue before changing its nights' }, NO_STORE);
    return;
  }
  const known = new Set(deck.feed.events.map((e) => e.id));
  const missing = body.data.events.filter((id) => !known.has(id));
  if (missing.length) {
    sendJson(res, 400, { error: `${missing.length} of those nights are no longer in the feed; reload the list` }, NO_STORE);
    return;
  }
  const draft = draftWeekend(deck.feed, { ...deck.opts, heroIds: body.data.events, cta: ctaSlide(await currentCta()) });
  if (!draft) {
    sendJson(res, 409, { error: 'the feed has no events for this weekend any more' }, NO_STORE);
    return;
  }
  try {
    const post = await upsertDraft({
      series: deck.post.series, slot: deck.post.slot, edition: deck.post.edition, slides: draft.slides, caption: draft.caption,
    });
    log.info('deck rebuilt with chosen nights', { id: post.id, nights: body.data.events.length });
    sendJson(res, 200, { post: (await attachCredits([post]))[0] }, NO_STORE);
  } catch (err) {
    if (err instanceof PostConflict) {
      sendJson(res, 409, { error: err.message }, NO_STORE);
      return;
    }
    throw err;
  }
}

/**
 * The closing slide's words, read and written.
 *
 * A setting rather than a constant because it is the one piece of copy on every post that gets rewritten,
 * and rewriting it should not need a deploy. Changing it changes what the *next* draft closes with; decks
 * already in the queue keep the words they were drafted with, which is also what makes them reviewable.
 */
async function cta(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === 'GET') {
    sendJson(res, 200, { cta: await currentCta() }, NO_STORE);
    return;
  }
  const body = ctaDataSchema.safeParse(req.body);
  if (!body.success) {
    sendJson(res, 400, { error: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, NO_STORE);
    return;
  }
  sendJson(res, 200, { cta: await saveCta(body.data) }, NO_STORE);
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
    sendJson(res, 200, { post: (await attachCredits([await patchPost(id, body.data)]))[0] }, NO_STORE);
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
    if (firstParam(req.query.cta) && (req.method === 'GET' || req.method === 'PUT')) return await cta(req, res);
    if (req.method === 'GET' && firstParam(req.query.candidates)) return await candidates(req, res);
    if (req.method === 'GET') return await list(req, res);
    if (req.method === 'POST' && firstParam(req.query.rebuild)) return await rebuild(req, res);
    if (req.method === 'POST' && firstParam(req.query.draft) === 'weekend') return await draft(req, res);
    if (req.method === 'POST' && firstParam(req.query.draft) === 'genre') return await draftEditions(res, 'genre');
    if (req.method === 'POST' && firstParam(req.query.draft) === 'spotlight') return await draftEditions(res, 'spotlight');
    if (req.method === 'POST' && firstParam(req.query.draft) === 'venue') return await draftEditions(res, 'venue');
    if (req.method === 'PATCH') return await patch(req, res);
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST, PUT, PATCH' });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error('posts endpoint failed', { error, method: req.method });
    sendJson(res, 500, { error: 'studio unavailable' }, NO_STORE);
  }
}
