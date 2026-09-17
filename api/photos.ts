/**
 * Photos added by hand in the studio. Studio session required.
 *
 *   POST   /api/photos?post=<uuid>&slide=<n>   body {data: base64, source}  attach a photo to one slide
 *   DELETE /api/photos?post=<uuid>&slide=<n>                                 remove it (the flyer comes back)
 *
 * Human in the loop by design: a person chooses the photo and says where it is from, and that source is
 * credited in the caption when the post publishes. Nothing here finds images on its own.
 *
 * The studio resizes before uploading, so a phone photo arrives well under Vercel's 4.5 MB request limit;
 * the server re-encodes regardless, which is what strips a photo's location metadata.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { attachCredits, attachPhoto, detachPhoto, normalisePhoto, PhotoError, savePhoto } from '../src/post/photos.js';
import { getPost, patchPost, PostConflict } from '../src/post/store.js';
import { createLogger } from '../src/lib/log.js';
import { firstParam, sendJson } from './_lib/respond.js';
import { requireStudio } from './_lib/studio.js';

const NO_STORE = { 'cache-control': 'no-store' };

const bodySchema = z.object({
  /** The image, base64. A data: URL prefix is tolerated, since that is what a browser canvas hands over. */
  data: z.string().min(16).max(8_000_000),
  source: z.string().trim().min(1, 'say where the photo is from').max(200),
});

async function target(req: VercelRequest): Promise<{ id: string; n: number }> {
  const id = firstParam(req.query.post);
  const n = Number(firstParam(req.query.slide));
  if (!id || !Number.isInteger(n) || n < 0) throw new PhotoError(400, 'post and slide are required');
  return { id, n };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'POST, DELETE' });
    return;
  }
  if (!requireStudio(req, res)) return;
  const log = createLogger('api:photos');

  try {
    const { id, n } = await target(req);
    const post = await getPost(id);
    if (!post) throw new PhotoError(404, `no post ${id}`);
    if (!post.slides[n]) throw new PhotoError(400, `post has no slide ${n}`);

    if (req.method === 'DELETE') {
      const updated = await patchPost(id, { slides: detachPhoto(post.slides, n) });
      sendJson(res, 200, { post: (await attachCredits([updated]))[0] }, NO_STORE);
      return;
    }

    const body = bodySchema.safeParse(req.body);
    if (!body.success) throw new PhotoError(400, body.error.issues[0]?.message ?? 'body must be {data, source}');
    // Checked before saving, so a photo aimed at a slide that cannot show one is not stored for nothing.
    const slide = post.slides[n]!;
    if (slide.template !== 'cover' && slide.template !== 'event' && slide.template !== 'venue') {
      throw new PhotoError(400, `a ${slide.template} slide has no photo`);
    }
    const raw = Buffer.from(body.data.data.replace(/^data:[^,]*,/, ''), 'base64');
    const { jpeg, width, height } = await normalisePhoto(raw);
    const photoId = await savePhoto(jpeg, width, height, body.data.source);
    const updated = await patchPost(id, { slides: attachPhoto(post.slides, n, photoId) });
    log.info('photo attached', { post: id, slide: n, width, height, bytes: jpeg.byteLength });
    sendJson(res, 200, { post: (await attachCredits([updated]))[0] }, NO_STORE);
  } catch (err) {
    if (err instanceof PhotoError || err instanceof PostConflict) {
      sendJson(res, err instanceof PhotoError ? err.status : 409, { error: err.message }, NO_STORE);
      return;
    }
    const error = err instanceof Error ? err.message : String(err);
    log.error('photo failed', { error });
    sendJson(res, 500, { error: 'could not save that photo' }, NO_STORE);
  }
}
