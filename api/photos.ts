/**
 * Photos added by hand in the studio. Studio session required.
 *
 *   POST   /api/photos?post=<uuid>&slide=<n>   body {data: base64, source}  attach a photo to one slide
 *   POST   /api/photos?post=<uuid>&slide=<n>   body {photo: <uuid>}          use one off the cover shelf
 *   DELETE /api/photos?post=<uuid>&slide=<n>                                 remove it (the flyer comes back)
 *   GET    /api/photos?archive=1                                             the cover shelf, newest first
 *   POST   /api/photos?archive=1               body {data, source}           put one on the shelf
 *   POST   /api/photos?archive=1               body {url, source}            the same, from an image link
 *   DELETE /api/photos?archive=1&id=<uuid>                                   take it off the shelf
 *   GET    /api/photos?id=<uuid>                                             the JPEG, for the studio's grid
 *
 * Human in the loop by design: a person chooses the photo and says where it is from, and that source is
 * credited in the caption when the post publishes. Nothing here finds images on its own.
 *
 * The studio resizes before uploading, so a phone photo arrives well under Vercel's 4.5 MB request limit;
 * the server re-encodes regardless, which is what strips a photo's location metadata.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import {
  archivedPhotos, attachCredits, attachPhoto, detachPhoto, loadPhoto, normalisePhoto, PhotoError, photoExists,
  savePhoto, unshelvePhoto,
} from '../src/post/photos.js';
import { fetchImage } from '../src/post/image.js';
import { getPost, patchPost, PostConflict } from '../src/post/store.js';
import { createLogger } from '../src/lib/log.js';
import { firstParam, sendJson } from './_lib/respond.js';
import { requireStudio } from './_lib/studio.js';

const NO_STORE = { 'cache-control': 'no-store' };

const source = z.string().trim().min(1, 'say where the photo is from').max(200);
/** The image, base64. A data: URL prefix is tolerated, since that is what a browser canvas hands over. */
const data = z.string().min(16).max(8_000_000);

const bodySchema = z.object({ data, source });

/**
 * What a POST to the shelf may carry: the bytes of a photo, or a link to one.
 *
 * The link is how a pin reaches the shelf. It is one image, named by a person, fetched from the allowlist
 * the renderer already uses -- not a board being read, which pinterest.com/robots.txt does not allow.
 */
const shelfSchema = z.union([
  z.object({ data, source, url: z.undefined().optional() }),
  z.object({ url: z.string().url().max(2000), source, data: z.undefined().optional() }),
]);

/** Using a photo that is already on the shelf, rather than uploading one. */
const reuseSchema = z.object({ photo: z.string().uuid() });

async function target(req: VercelRequest): Promise<{ id: string; n: number }> {
  const id = firstParam(req.query.post);
  const n = Number(firstParam(req.query.slide));
  if (!id || !Number.isInteger(n) || n < 0) throw new PhotoError(400, 'post and slide are required');
  return { id, n };
}

/** The bytes of one photo, for the studio's own grid. Private: it is the studio, not a CDN. */
async function serve(req: VercelRequest, res: VercelResponse, id: string): Promise<void> {
  const jpeg = await loadPhoto(id);
  res.setHeader('content-type', 'image/jpeg');
  res.setHeader('cache-control', 'private, max-age=300');
  res.setHeader('content-length', String(jpeg.byteLength));
  res.status(200).end(req.method === 'HEAD' ? undefined : jpeg);
}

/**
 * The cover shelf: photographs kept before any post needs them.
 *
 * A link is fetched through the renderer's own allowlist (src/post/image.ts), which is what keeps this from
 * being a proxy for anything on the internet. Pins are added one at a time, with the credit written down
 * while it is still known.
 */
async function shelf(req: VercelRequest, res: VercelResponse): Promise<void> {
  const log = createLogger('api:photos');
  if (req.method === 'GET') {
    sendJson(res, 200, { photos: await archivedPhotos() }, NO_STORE);
    return;
  }
  if (req.method === 'DELETE') {
    const id = firstParam(req.query.id);
    if (!id) throw new PhotoError(400, 'which photo?');
    // The row stays: a post already using it must keep rendering. Only the shelf forgets it.
    await unshelvePhoto(id);
    sendJson(res, 200, { photos: await archivedPhotos() }, NO_STORE);
    return;
  }
  const body = shelfSchema.safeParse(req.body);
  if (!body.success) throw new PhotoError(400, body.error.issues[0]?.message ?? 'body must be {data, source} or {url, source}');
  const raw = body.data.url
    ? await fetchImage(body.data.url)
    : Buffer.from(body.data.data!.replace(/^data:[^,]*,/, ''), 'base64');
  const { jpeg, width, height } = await normalisePhoto(raw);
  const photoId = await savePhoto(jpeg, width, height, body.data.source, true);
  log.info('photo shelved', { width, height, bytes: jpeg.byteLength, from: body.data.url ? 'link' : 'upload' });
  sendJson(res, 200, { photo: { id: photoId, source: body.data.source, width, height, added_at: new Date().toISOString() }, photos: await archivedPhotos() }, NO_STORE);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST' && req.method !== 'DELETE' && req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST, DELETE' });
    return;
  }
  if (!requireStudio(req, res)) return;
  const log = createLogger('api:photos');

  try {
    const one = firstParam(req.query.id);
    if (one && (req.method === 'GET' || req.method === 'HEAD')) return await serve(req, res, one);
    if (firstParam(req.query.archive)) return await shelf(req, res);
    if (req.method === 'GET' || req.method === 'HEAD') throw new PhotoError(400, 'nothing to get here');
    const { id, n } = await target(req);
    const post = await getPost(id);
    if (!post) throw new PhotoError(404, `no post ${id}`);
    if (!post.slides[n]) throw new PhotoError(400, `post has no slide ${n}`);

    if (req.method === 'DELETE') {
      const updated = await patchPost(id, { slides: detachPhoto(post.slides, n) });
      sendJson(res, 200, { post: (await attachCredits([updated]))[0] }, NO_STORE);
      return;
    }

    // Checked before saving, so a photo aimed at a slide that cannot show one is not stored for nothing.
    const slide = post.slides[n]!;
    if (slide.template !== 'cover' && slide.template !== 'event' && slide.template !== 'venue') {
      throw new PhotoError(400, `a ${slide.template} slide has no photo`);
    }

    // One off the shelf: no bytes travel, and the photo stays on the shelf for the next deck.
    const reuse = reuseSchema.safeParse(req.body);
    if (reuse.success) {
      if (!(await photoExists(reuse.data.photo))) throw new PhotoError(404, 'that photo is not here any more');
      const used = await patchPost(id, { slides: attachPhoto(post.slides, n, reuse.data.photo) });
      log.info('shelf photo used', { post: id, slide: n, photo: reuse.data.photo });
      sendJson(res, 200, { post: (await attachCredits([used]))[0] }, NO_STORE);
      return;
    }

    const body = bodySchema.safeParse(req.body);
    if (!body.success) throw new PhotoError(400, body.error.issues[0]?.message ?? 'body must be {data, source}');
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
