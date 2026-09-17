/**
 * One slide in, one 1080x1350 JPEG out.
 *
 * The slide is built in layers rather than in a browser, because the repo carries no browser and a lambda
 * that boots Chromium to draw a rectangle is its own kind of problem. satori lays the type out and returns
 * SVG with the glyphs already converted to outlines -- which is the reason no font has to exist on the
 * machine doing the rasterising -- and sharp stacks everything else underneath it.
 *
 *   event   photo (treated, cover) or tone -> grain -> veil -> type
 *   venue   ground -> photo band at the foot -> type
 *   rest    ground -> type
 *
 * JPEG, not PNG: Instagram rejects PNG on the media endpoints, and a deck that renders beautifully and then
 * cannot be published is worse than one that never rendered.
 */
import satori from 'satori';
import sharp from 'sharp';
import { loadFonts, POST_TYPEFACES, type Typefaces } from './font.js';
import { fetchImage, treatImage } from './image.js';
import { loadPhoto, photoIdOf } from './photos.js';
import { coverVeilSvg, GROUND, grainSvg, toneSvg, veilSvg } from './layers.js';
import { slideTree, VENUE_BAND_PLACEHOLDER } from './templates.js';
import { CANVAS, type Slide, type SlideImage, type Tone, type Treatment } from './types.js';

export interface RenderOptions {
  treatment: Treatment;
  grain: boolean;
  /** Fetches a flyer's bytes. Swapped in tests so nothing touches the network. */
  fetchBytes?: (src: string) => Promise<Buffer>;
  /** JPEG quality. 90 keeps flyer type crisp without pushing a slide past Instagram's comfort. */
  quality?: number;
}

/** The type layer: transparent PNG at canvas size, glyphs already outlined by satori. */
export async function renderType(slide: Slide, type: Typefaces = POST_TYPEFACES): Promise<Buffer> {
  const fonts = await loadFonts(type);
  const svg = await satori(slideTree(slide, type) as never, { width: CANVAS.w, height: CANVAS.h, fonts });
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A slide's image bytes: a studio photo from the database, or a flyer fetched from its allowlisted host. */
async function imageBytes(src: string, opts: RenderOptions): Promise<Buffer> {
  if (opts.fetchBytes) return opts.fetchBytes(src);
  const id = photoIdOf(src);
  return id ? loadPhoto(id) : fetchImage(src);
}

/** A flat rectangle of the ground, the base every slide starts from. */
function ground(): sharp.Sharp {
  return sharp({
    create: { width: CANVAS.w, height: CANVAS.h, channels: 3, background: GROUND },
  });
}

/** The photo layer for an event slide, or the tone when there is no photo yet. */
async function eventBase(
  image: SlideImage | null, tone: Tone, opts: RenderOptions,
): Promise<{ base: Buffer; hasPhoto: boolean }> {
  if (image) {
    const bytes = await imageBytes(image.src, opts);
    const treated = await treatImage(bytes, opts.treatment, image.fit);
    return { base: await treated.png().toBuffer(), hasPhoto: true };
  }
  const base = await sharp(toneSvg(tone)).png().toBuffer();
  return { base, hasPhoto: false };
}

/** The band of photograph at the foot of a venue slide, or the placeholder that stands in for one. */
async function venueBand(image: SlideImage, opts: RenderOptions): Promise<Buffer> {
  const { height } = VENUE_BAND_PLACEHOLDER;
  const bytes = await imageBytes(image.src, opts);
  // Framed straight to the band's own proportions. Framing to the full canvas first and cropping that to
  // the band would crop twice, throwing away more of the photograph than either step intended.
  const treated = await treatImage(bytes, opts.treatment, image.fit, { w: CANVAS.w, h: height });
  return treated.png().toBuffer();
}

/** Compose one slide and encode it. */
export async function renderSlide(slide: Slide, opts: RenderOptions): Promise<Buffer> {
  const type = await renderType(slide);
  const layers: sharp.OverlayOptions[] = [];
  let canvas: sharp.Sharp;

  if (slide.template === 'event') {
    const { base, hasPhoto } = await eventBase(slide.data.image, slide.data.tex, opts);
    canvas = sharp(base);
    // Grain sits on the photograph, under the veil, the way the prototype stacks them -- and only where
    // there is a photograph to grain. Over a flat tone it reads as noise rather than film.
    if (hasPhoto && opts.grain) layers.push({ input: grainSvg(), blend: 'overlay' });
    layers.push({ input: veilSvg(), blend: 'over' });
  } else if (slide.template === 'cover' && slide.data.image) {
    const treated = await treatImage(await imageBytes(slide.data.image.src, opts), opts.treatment, slide.data.image.fit);
    canvas = sharp(await treated.png().toBuffer());
    if (opts.grain) layers.push({ input: grainSvg(), blend: 'overlay' });
    layers.push({ input: coverVeilSvg(), blend: 'over' });
  } else if (slide.template === 'venue') {
    canvas = ground();
    if (slide.data.image) {
      layers.push({ input: await venueBand(slide.data.image, opts), top: CANVAS.h - VENUE_BAND_PLACEHOLDER.height, left: 0 });
    }
  } else {
    canvas = ground();
  }

  layers.push({ input: type, blend: 'over' });
  return canvas
    .composite(layers)
    .jpeg({ quality: opts.quality ?? 90, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer();
}

/**
 * A stable fingerprint of everything that affects the pixels, used as the cache key for a rendered slide.
 * Two requests for the same slide under the same look must produce the same URL, or Instagram fetches a
 * different image than the one that was reviewed.
 */
export async function slideDigest(slide: Slide, treatment: Treatment, grain: boolean): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256')
    .update(JSON.stringify({ slide, treatment, grain }))
    .digest('hex')
    .slice(0, 32);
}
