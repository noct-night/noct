/**
 * Fetching a promoter flyer and putting one treatment on it.
 *
 * Promoter artwork is wildly inconsistent -- different photographers, different crops, different amounts of
 * type burned into the image. One treatment applied across all of it is what makes a feed read as one brand
 * rather than a scrapbook, so the treatment is a property of the post and never of the slide.
 *
 * The filter chains are the CSS ones from the review prototype, translated to sharp. CSS `contrast(c)` then
 * `brightness(b)` on a channel normalised to 0..1 is `b*((x - .5)*c + .5)`, which in sharp's 0..255 linear()
 * is a multiplier of `b*c` and an offset of `255*b*(.5 - .5c)`. Getting that wrong turns a flyer into a
 * smooth grey gradient, which is exactly what it looked like the first time.
 */
import sharp from 'sharp';
import { CANVAS, type Fit, type Treatment } from './types.js';
import { GROUND } from './layers.js';
import { env } from '../lib/env.js';
import { politeFetch } from '../lib/http.js';

/**
 * Hosts /api/img is willing to fetch from. An open image proxy is a server-side request forgery hole and a
 * free bandwidth laundry for anyone who finds it, so this is an allowlist and not a blocklist: these are the
 * CDNs the adapters in src/sources actually put in `image_url`. Extend with NOCT_IMG_HOSTS (comma separated)
 * rather than by loosening the check.
 */
export const DEFAULT_IMAGE_HOSTS = [
  'images.ra.co',
  'dice-media.imgix.net',
  's1.ticketm.net',
  'media.ticketmaster.com',
  'www.datocms-assets.com',
  'publicrecords.nyc',
  'www.publicrecords.nyc',
  'goodroombk.com',
  'www.goodroombk.com',
] as const;

/** 20 MB. A flyer that big is a mistake somewhere; decoding it on a 1 GB lambda is a worse one. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export class ImageSourceError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ImageSourceError';
  }
}

export function allowedImageHosts(source = process.env): Set<string> {
  const extra = (env('NOCT_IMG_HOSTS', '', source) as string)
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return new Set<string>([...DEFAULT_IMAGE_HOSTS, ...extra]);
}

/**
 * Parse and check a candidate flyer URL. Returns the URL when it is one we will fetch; throws otherwise.
 * http and https only: `file:` and `data:` would read the filesystem and the request body respectively.
 */
export function assertFetchableImage(raw: string, source = process.env): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ImageSourceError(400, 'url must be an absolute http(s) URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ImageSourceError(400, `unsupported scheme ${url.protocol}`);
  }
  if (!allowedImageHosts(source).has(url.hostname.toLowerCase())) {
    throw new ImageSourceError(403, `host ${url.hostname} is not an allowed image source`);
  }
  return url;
}

/** Fetch the bytes of a flyer, re-checking the host after redirects so a 302 cannot walk off the allowlist. */
export async function fetchImage(raw: string, source = process.env): Promise<Buffer> {
  const url = assertFetchableImage(raw, source);
  const res = await politeFetch(url.toString(), { timeoutMs: 15_000, retries: 1, minIntervalMs: 250 });
  const landed = new URL(res.url || url.toString());
  if (!allowedImageHosts(source).has(landed.hostname.toLowerCase())) {
    throw new ImageSourceError(403, `redirected to disallowed host ${landed.hostname}`);
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new ImageSourceError(413, `image is ${declared} bytes, over the ${MAX_IMAGE_BYTES} limit`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    throw new ImageSourceError(413, `image is ${buf.byteLength} bytes, over the ${MAX_IMAGE_BYTES} limit`);
  }
  return buf;
}

/** CSS filter chain -> the sharp operations that reproduce it. Exported for the unit tests. */
export interface TreatmentOps {
  grayscale: boolean;
  /** sharp linear(): out = multiply * in + offset, per channel, 0..255. */
  multiply: number;
  offset: number;
  /** The whole colour transform as a 3x3 recombination, or null when a plain greyscale does the job. */
  matrix: Matrix3 | null;
}

/** contrast(c) then brightness(b), in sharp's 0..255 linear() terms. */
function levels(contrast: number, brightness: number): Pick<TreatmentOps, 'multiply' | 'offset'> {
  return { multiply: brightness * contrast, offset: 255 * brightness * (0.5 - 0.5 * contrast) };
}

/** Rows spelled out as fixed-length tuples, which is the shape sharp's recomb() takes. */
type Row3 = [number, number, number];
type Matrix3 = [Row3, Row3, Row3];

const IDENTITY: Matrix3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
/** Rec. 709 luminance, the coefficients the CSS filter-effects spec uses for saturate and grayscale. */
const LUMA = [0.213, 0.715, 0.072];

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** a * b, so `b` is the transform applied first. */
function multiplyMatrix(a: Matrix3, b: Matrix3): Matrix3 {
  return a.map((row) => [0, 1, 2].map((j) => row.reduce((acc, v, k) => acc + v * b[k]![j]!, 0))) as Matrix3;
}

/** CSS `saturate(s)`: interpolate away from luminance. s = 0 is `grayscale(1)`, which is how it is used here. */
function saturateMatrix(s: number): Matrix3 {
  return IDENTITY.map((row, i) => row.map((v, j) => lerp(LUMA[j]!, i === j ? v : 0, s))) as Matrix3;
}

/** CSS `sepia(a)`: interpolate towards the sepia primaries. */
function sepiaMatrix(a: number): Matrix3 {
  const SEPIA: Matrix3 = [
    [0.393, 0.769, 0.189],
    [0.349, 0.686, 0.168],
    [0.272, 0.534, 0.131],
  ];
  return IDENTITY.map((row, i) => row.map((v, j) => lerp(v, SEPIA[i]![j]!, a))) as Matrix3;
}

/**
 * `warm`'s whole colour transform as one matrix: grayscale(1), then sepia(.4), then saturate(1.3).
 *
 * Folded into a single recomb rather than chaining sharp's .grayscale() before .recomb(), because
 * .grayscale() can leave the pipeline on a single-channel colourspace and a 3x3 recombination of one
 * channel is an error. One matrix also makes the order unambiguous: greyed first, then tinted, which is why
 * warm stays a duotone -- saturate(1.3) on an already-grey image only amplifies the sepia it just gained.
 */
function warmMatrix(): Matrix3 {
  return multiplyMatrix(saturateMatrix(1.3), multiplyMatrix(sepiaMatrix(0.4), saturateMatrix(0)));
}

/**
 * The four treatments, exactly as the prototype's CSS declares them.
 *   none   raw
 *   mono   grayscale(1) contrast(1.08) brightness(.94)
 *   crush  grayscale(1) contrast(1.5)  brightness(.68)
 *   warm   grayscale(1) sepia(.4) contrast(1.16) brightness(.86) saturate(1.3)
 * `warm` greys the image first and then tints it, which is why it stays a duotone rather than becoming a
 * saturated photo: saturate(1.3) on an already-grey image only amplifies the sepia it just gained.
 */
export const TREATMENT_OPS: Record<Treatment, TreatmentOps> = {
  none: { grayscale: false, multiply: 1, offset: 0, matrix: null },
  mono: { grayscale: true, ...levels(1.08, 0.94), matrix: null },
  crush: { grayscale: true, ...levels(1.5, 0.68), matrix: null },
  warm: { grayscale: false, ...levels(1.16, 0.86), matrix: warmMatrix() },
};

/**
 * Frame a flyer to the post canvas and apply the treatment.
 *
 * `cover` is the design: full bleed, type at the bottom. It is also a crop, and promoter flyers put their
 * own type near the edges -- a square flyer centred into 4:5 loses 10% off each side, which can be the first
 * letter of the headliner. `contain` is the escape hatch, letterboxed onto the ground, chosen per slide by
 * whoever is looking at the result.
 */
export async function treatImage(
  input: Buffer, treatment: Treatment, fit: Fit = 'cover', size: { w: number; h: number } = CANVAS,
): Promise<sharp.Sharp> {
  const ops = TREATMENT_OPS[treatment];
  // `failOn: 'none'` keeps a slightly-corrupt promoter JPEG renderable instead of failing the whole deck.
  let img = sharp(input, { failOn: 'none' }).resize(size.w, size.h, {
    fit: fit === 'contain' ? 'contain' : 'cover',
    position: 'centre',
    background: GROUND,
  });
  // A flyer arriving as a PNG with alpha would composite as transparent; flatten it onto the ground first.
  img = img.flatten({ background: GROUND });
  if (ops.grayscale) img = img.grayscale();
  if (ops.matrix) img = img.recomb(ops.matrix);
  if (ops.multiply !== 1 || ops.offset !== 0) img = img.linear(ops.multiply, ops.offset);
  return img;
}

/** A treated flyer as a JPEG, which is what /api/img serves and what Instagram will accept. */
export async function treatedJpeg(
  input: Buffer, treatment: Treatment, fit: Fit = 'cover', quality = 90,
): Promise<Buffer> {
  const img = await treatImage(input, treatment, fit);
  return img.jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer();
}
