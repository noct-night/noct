/**
 * Photos added by hand in the studio, and the credits that go with them.
 *
 * A person picks the photo and says where it came from. Nothing here searches for images or decides that a
 * picture is fine to use -- that judgement stays with whoever uploads it. What this module guarantees is the
 * mechanical part: the file is safe to store and render, the slide points at it, the credit is never lost,
 * and redrafting a post does not throw away a photo someone chose.
 */
import sharp from 'sharp';
import { query } from '../lib/db.js';
import type { Post, Slide, SlideImage } from './types.js';
import { PHOTO_SRC } from './types.js';

const PREFIX = 'photo:';

/** Slides that can show a photo: the cover's background, an event's flyer, a venue's band. */
type PhotoSlide = Extract<Slide, { template: 'cover' | 'event' | 'venue' }>;
const hasPhoto = (s: Slide): s is PhotoSlide => s.template === 'cover' || s.template === 'event' || s.template === 'venue';

/** The uuid in a `photo:<uuid>` src, or null for a flyer URL. */
export function photoIdOf(src: string | undefined | null): string | null {
  return src && PHOTO_SRC.test(src) ? src.slice(PREFIX.length) : null;
}

export class PhotoError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'PhotoError';
  }
}

/** Long edge after resizing. Twice the post canvas's width is plenty for a crop to still be sharp. */
export const PHOTO_MAX_EDGE = 2400;
/** What an upload may be before resizing. The studio resizes first, so this only catches a mistake. */
export const PHOTO_MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/**
 * Make an uploaded file safe to keep.
 *
 * Decoding it at all is the validation: anything sharp cannot read is not an image. `rotate()` bakes the
 * EXIF orientation into the pixels, because the re-encode drops metadata -- which is the point, since a phone
 * photo's EXIF includes where it was taken -- and without it a portrait photo would come out sideways.
 */
export async function normalisePhoto(input: Buffer): Promise<{ jpeg: Buffer; width: number; height: number }> {
  if (input.byteLength > PHOTO_MAX_UPLOAD_BYTES) {
    throw new PhotoError(413, `photo is ${Math.round(input.byteLength / 1e6)} MB; keep it under 12 MB`);
  }
  try {
    const { data, info } = await sharp(input, { failOn: 'error' })
      .rotate()
      .resize(PHOTO_MAX_EDGE, PHOTO_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { jpeg: data, width: info.width, height: info.height };
  } catch {
    throw new PhotoError(415, 'that file could not be read as an image; use a JPEG or PNG');
  }
}

export async function savePhoto(jpeg: Buffer, width: number, height: number, source: string): Promise<string> {
  const { rows } = await query<{ photo_id: string }>(
    `insert into ig_photo (bytes, width, height, source) values ($1, $2, $3, $4) returning photo_id`,
    [jpeg, width, height, source.trim()],
  );
  return rows[0]!.photo_id;
}

export async function loadPhoto(id: string): Promise<Buffer> {
  const { rows } = await query<{ bytes: Buffer }>(`select bytes from ig_photo where photo_id = $1`, [id]);
  if (!rows[0]) throw new PhotoError(404, `no photo ${id}`);
  return rows[0].bytes;
}

// ── Pure: slides and captions ─────────────────────────────────────────────────

/** The photo ids a deck uses, in slide order, without repeats. */
export function photoIdsIn(slides: Slide[]): string[] {
  const ids: string[] = [];
  for (const s of slides) {
    const image = 'image' in s.data ? (s.data.image as SlideImage | null) : null;
    const id = photoIdOf(image?.src);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** "Photo: <source>" per photo, in slide order, with a source used twice credited once. */
export function creditsFor(slides: Slide[], sources: Map<string, string>): string[] {
  const out: string[] = [];
  for (const id of photoIdsIn(slides)) {
    const source = sources.get(id);
    const line = source ? `Photo: ${source}` : null;
    if (line && !out.includes(line)) out.push(line);
  }
  return out;
}

/**
 * The caption as it publishes: the credits after the text and before the hashtags.
 *
 * Credits are added here, at publish time, rather than written into the stored caption when a photo is
 * attached. A stored line would be wiped by redrafting the post, left behind when the photo is removed, and
 * editable into something that no longer credits anyone.
 */
export function withCredits(caption: string, credits: string[]): string {
  if (credits.length === 0) return caption;
  const block = credits.join('\n');
  const lines = caption.replace(/\s+$/, '').split('\n');
  const last = lines[lines.length - 1] ?? '';
  if (/^\s*#/.test(last)) {
    const body = lines.slice(0, -1).join('\n').replace(/\s+$/, '');
    return `${body}\n\n${block}\n\n${last}`;
  }
  return `${lines.join('\n')}\n\n${block}`;
}

/** The slides with slide n showing a studio photo, remembering any flyer it covers. */
export function attachPhoto(slides: Slide[], n: number, photoId: string): Slide[] {
  return slides.map((s, i) => {
    if (i !== n) return s;
    if (!hasPhoto(s)) {
      throw new PhotoError(400, `a ${s.template} slide has no photo`);
    }
    const before = s.data.image;
    const flyer = before && !photoIdOf(before.src) ? before.src : before?.flyer;
    const image: SlideImage = { src: `${PREFIX}${photoId}`, fit: 'cover', ...(flyer ? { flyer } : {}) };
    return { ...s, data: { ...s.data, image } } as Slide;
  });
}

/** The slides with slide n's studio photo removed: back to its flyer if it had one, else no image. */
export function detachPhoto(slides: Slide[], n: number): Slide[] {
  return slides.map((s, i) => {
    if (i !== n || !hasPhoto(s)) return s;
    const before = s.data.image;
    if (!before || !photoIdOf(before.src)) return s;
    const image: SlideImage | null = before.flyer ? { src: before.flyer, fit: 'cover' } : null;
    return { ...s, data: { ...s.data, image } } as Slide;
  });
}

/** What identifies "the same slide" across two drafts of a post. */
function slideKey(s: Slide): string | null {
  // A deck has one cover, so its background carries to whatever the new cover says.
  if (s.template === 'cover') return 'cover';
  if (s.template === 'event') return `event|${s.data.name}|${s.data.venue}`;
  if (s.template === 'venue') return `venue|${s.data.name}`;
  return null;
}

/**
 * Keep the photos someone chose when a post is drafted again.
 *
 * Redrafting rebuilds the slides from the feed, and without this every hand-added photo would silently
 * vanish. A photo carries over to the slide for the same night at the same venue, or the same venue.
 */
export function carryPhotos(previous: Slide[], next: Slide[]): Slide[] {
  const kept = new Map<string, SlideImage>();
  for (const s of previous) {
    const key = slideKey(s);
    const image = 'image' in s.data ? (s.data.image as SlideImage | null) : null;
    if (key && image && photoIdOf(image.src)) kept.set(key, image);
  }
  if (kept.size === 0) return next;
  return next.map((s) => {
    const key = slideKey(s);
    const image = key ? kept.get(key) : undefined;
    if (!image || !hasPhoto(s)) return s;
    const flyer = s.data.image && !photoIdOf(s.data.image.src) ? s.data.image.src : image.flyer;
    return { ...s, data: { ...s.data, image: { ...image, ...(flyer ? { flyer } : {}) } } } as Slide;
  });
}

// ── The API's view ─────────────────────────────────────────────────────────

async function sourcesFor(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { rows } = await query<{ photo_id: string; source: string }>(
    `select photo_id, source from ig_photo where photo_id = any($1::uuid[])`, [ids],
  );
  return new Map(rows.map((r) => [r.photo_id, r.source]));
}

/** Posts with their credits attached, in one query for the whole list. */
export async function attachCredits(posts: Post[]): Promise<Post[]> {
  const sources = await sourcesFor([...new Set(posts.flatMap((p) => photoIdsIn(p.slides)))]);
  return posts.map((p) => ({ ...p, credits: creditsFor(p.slides, sources) }));
}
