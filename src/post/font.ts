/**
 * The post typefaces, as the TTF bytes satori needs to turn type into outlines.
 *
 * Two families. BODY_FONT sets almost everything on a slide -- covers, venue notes, tables, the CTA -- and is
 * Google Sans, the same face as the app, so a post and the site it advertises read as one thing. DISPLAY_FONT
 * sets the DJ lineup and the NO / CT wordmark: the names are what a post is about, and the wordmark should be
 * the logo's own face. Both came from review of the first real decks.
 *
 * Google Fonts serves woff2 to anything modern and plain TTF to anything that looks old, and satori reads
 * TTF/OTF/WOFF but not woff2. Hence the deliberately ancient User-Agent: it is a content negotiation, not a
 * disguise, and it is the documented way to get static font files out of the css2 endpoint.
 *
 * Fonts are fetched once per lambda instance and kept in module scope. A cold start pays eight small
 * requests; every render after that pays nothing. NOCT_FONT_DIR points at a directory of pre-downloaded
 * .ttf files instead (GoogleSans-700.ttf and so on), for offline tests and for a deploy that would rather
 * not reach out.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../lib/env.js';
import { politeFetch } from '../lib/http.js';

export const BODY_FONT = 'Google Sans';
/** Archivo: the face the NO / CT logo is set in, so the lineup and the wordmark match the mark itself. */
export const DISPLAY_FONT = 'Archivo';
/** The two faces a slide is set in. Passed around as a pair so a comparison render can try another. */
export interface Typefaces {
  body: string;
  display: string;
}
export const POST_TYPEFACES: Typefaces = { body: BODY_FONT, display: DISPLAY_FONT };

/* A family of more than one word needs '+' in the Google Fonts query and no spaces at all in a filename. */
const query = (family: string): string => family.replace(/ /g, '+');
const fileStem = (family: string): string => family.replace(/ /g, '');
export const FONT_WEIGHTS = [400, 500, 600, 700] as const;
export type FontWeight = (typeof FONT_WEIGHTS)[number];

/** What satori wants: one entry per weight, with the raw font bytes. */
export interface LoadedFont {
  name: string;
  data: ArrayBuffer;
  weight: FontWeight;
  style: 'normal';
}

/** A UA old enough that Google Fonts falls back to `format('truetype')`. */
const TTF_UA = 'Mozilla/5.0 (Windows NT 6.1)';

const cssUrl = (family: string): string =>
  `https://fonts.googleapis.com/css2?family=${query(family)}:wght@${FONT_WEIGHTS.join(';')}`;

/** Pull `weight -> url` out of the @font-face blocks the css2 endpoint returns, in declaration order. */
export function parseFontCss(css: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const block of css.split('@font-face')) {
    const weight = /font-weight:\s*(\d+)/.exec(block);
    const src = /src:\s*url\((https:[^)]+\.ttf)\)/.exec(block);
    if (weight && src) out.set(Number(weight[1]), src[1]!);
  }
  return out;
}

async function fromDisk(dir: string, family: string): Promise<LoadedFont[]> {
  return Promise.all(
    FONT_WEIGHTS.map(async (weight) => {
      const buf = await readFile(join(dir, `${fileStem(family)}-${weight}.ttf`));
      return { name: family, data: toArrayBuffer(buf), weight, style: 'normal' as const };
    }),
  );
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function download(family: string): Promise<LoadedFont[]> {
  const css = await politeFetch(cssUrl(family), { headers: { 'user-agent': TTF_UA }, timeoutMs: 10_000 }).then((r) => r.text());
  const urls = parseFontCss(css);
  const missing = FONT_WEIGHTS.filter((w) => !urls.has(w));
  if (missing.length) throw new Error(`Google Fonts returned no TTF for ${family} ${missing.join(', ')}`);
  return Promise.all(
    FONT_WEIGHTS.map(async (weight) => {
      const res = await politeFetch(urls.get(weight)!, { timeoutMs: 15_000, minIntervalMs: 0 });
      return { name: family, data: await res.arrayBuffer(), weight, style: 'normal' as const };
    }),
  );
}

const cached = new Map<string, Promise<LoadedFont[]>>();

/** One family's four weights, loaded once per process. A failure is not cached, so the next render retries. */
function loadFamily(family: string): Promise<LoadedFont[]> {
  const hit = cached.get(family);
  if (hit) return hit;
  const dir = env('NOCT_FONT_DIR');
  const p = (dir ? fromDisk(dir, family) : download(family)).catch((err) => {
    cached.delete(family);
    throw err;
  });
  cached.set(family, p);
  return p;
}

/** Every weight of both faces a slide needs. */
export async function loadFonts(type: Typefaces = POST_TYPEFACES): Promise<LoadedFont[]> {
  const families = [...new Set([type.body, type.display])];
  return (await Promise.all(families.map(loadFamily))).flat();
}
