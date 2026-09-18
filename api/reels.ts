/**
 * POST /api/reels?sign=1 — mint signed upload URLs for one reel's files
 * POST /api/reels        — queue the uploaded reel as a draft
 *
 * This exists so that cutting video needs no database password and no service-role key on the machine
 * doing the cutting. `npm run clip` used to connect to Postgres directly and upload with the service-role
 * key, which meant a credential that can read and write every table in the project had to sit in a file on
 * a laptop. Now the laptop holds the studio password -- the one a person already knows -- and this
 * endpoint, which already has both credentials, does the two privileged parts on its behalf.
 *
 * The bytes deliberately do not pass through here. A Vercel function may not receive a body over 4.5 MB
 * and a reel is tens of megabytes, so `?sign=1` returns URLs that write exactly one object each and the
 * CLI sends the file straight to storage. Nothing else about the shape of the studio changes: this queues
 * a draft and stops, the same as `POST /api/posts?draft=weekend`, and publishing stays behind
 * /api/publish and a person pressing a button.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createLogger } from '../src/lib/log.js';
import { checkCaption } from '../src/post/caption.js';
import { upsertReel } from '../src/post/store.js';
import { CAPTION_MAX, videoMetaSchema } from '../src/post/types.js';
import { ensureBucket, publicUrl, signUpload, verifyPublic } from '../src/video/storage.js';
import { firstParam, sendJson } from './_lib/respond.js';
import { requireStudio } from './_lib/studio.js';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * One reel's files live under one uuid, so a post's video and cover stay together and a deleted post is
 * one prefix to clear. The names inside it are fixed rather than taken from the request: a client-supplied
 * path is a client-supplied place to write, and there is no reason to accept one.
 */
const VIDEO_NAME = 'reel.mp4';
const COVER_NAME = 'cover.jpg';

const draftSchema = z.object({
  /** The prefix a previous `?sign=1` handed out. Rejected unless it is a uuid, so it cannot walk a path. */
  prefix: z.string().uuid(),
  caption: z.string().max(CAPTION_MAX).default(''),
  /** The night the clip is about, if it is about one. */
  slot: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  cover: z.boolean().default(false),
  meta: videoMetaSchema.default({}),
}).strict();

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
    return;
  }
  if (!requireStudio(req, res)) return;

  const log = createLogger('api:reels');

  if (firstParam(req.query.sign)) {
    // The prefix is minted here rather than accepted from the client, so the only paths that can ever be
    // written are ones this endpoint chose.
    const prefix = randomUUID();
    try {
      await ensureBucket();
      const [video, cover] = await Promise.all([
        signUpload(`${prefix}/${VIDEO_NAME}`),
        signUpload(`${prefix}/${COVER_NAME}`),
      ]);
      log.info('signed a reel upload', { prefix });
      sendJson(res, 200, { prefix, video: video.putUrl, cover: cover.putUrl }, NO_STORE);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('could not sign a reel upload', { error: message });
      sendJson(res, 503, { error: message }, NO_STORE);
    }
    return;
  }

  const parsed = draftSchema.safeParse(req.body);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'bad request', detail: parsed.error.issues.map((i) => i.message) }, NO_STORE);
    return;
  }
  const { prefix, caption, slot, cover, meta } = parsed.data;

  const videoUrl = publicUrl(`${prefix}/${VIDEO_NAME}`);
  const coverUrl = cover ? publicUrl(`${prefix}/${COVER_NAME}`) : null;

  try {
    // The request Meta will make at publish time, made now. It proves two things at once: the upload
    // actually arrived, and the bucket is readable without credentials. Discovering either of those at
    // publish time means an opaque Graph API error about a video it could not read.
    await verifyPublic(videoUrl);
    if (coverUrl) await verifyPublic(coverUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 422, { error: `the uploaded reel is not readable: ${message}` }, NO_STORE);
    return;
  }

  // Reported, never enforced, and never rewritten -- the same rule the studio's caption box follows. The
  // words are hers; a draft with an em dash in it is still a draft worth reviewing.
  const problems = checkCaption(caption);

  const post = await upsertReel({ slot, caption, videoUrl, coverUrl, videoMeta: meta });
  log.info('queued a reel', { post: post.id, prefix });
  sendJson(res, 201, { post, problems }, NO_STORE);
}
