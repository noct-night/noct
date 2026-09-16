/**
 * Red Hat Display, as the TTF bytes satori needs to turn type into outlines.
 *
 * The post design system is Red Hat Display 400/500/600/700 (docs/INSTAGRAM.md). Note this is NOT the
 * app's typeface -- index.html sets Google Sans -- so the two surfaces genuinely differ; see the
 * divergence note in docs/INSTAGRAM.md before "fixing" one to match the other.
 *
 * Google Fonts serves woff2 to anything modern and plain TTF to anything that looks old, and satori reads
 * TTF/OTF/WOFF but not woff2. Hence the deliberately ancient User-Agent: it is a content negotiation, not a
 * disguise, and it is the documented way to get static font files out of the css2 endpoint.
 *
 * Fonts are fetched once per lambda instance and kept in module scope. A cold start pays four small
 * requests (~110 KB each); every render after that pays nothing. NOCT_FONT_DIR points at a directory of
 * pre-downloaded .ttf files instead, for offline tests and for a deploy that would rather not reach out.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../lib/env.js';
import { politeFetch } from '../lib/http.js';

export const FONT_FAMILY = 'Red Hat Display';
/* A family of more than one word needs '+' in the Google Fonts query and no spaces at all in a
   filename, so the bare constant cannot be dropped into either. */
const FONT_QUERY = FONT_FAMILY.replace(/ /g, '+');
const FONT_FILE = FONT_FAMILY.replace(/ /g, '');
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

const CSS_URL = `https://fonts.googleapis.com/css2?family=${FONT_QUERY}:wght@${FONT_WEIGHTS.join(';')}`;

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

async function fromDisk(dir: string): Promise<LoadedFont[]> {
  return Promise.all(
    FONT_WEIGHTS.map(async (weight) => {
      const buf = await readFile(join(dir, `${FONT_FILE}-${weight}.ttf`));
      return { name: FONT_FAMILY, data: toArrayBuffer(buf), weight, style: 'normal' as const };
    }),
  );
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function download(): Promise<LoadedFont[]> {
  const css = await politeFetch(CSS_URL, { headers: { 'user-agent': TTF_UA }, timeoutMs: 10_000 }).then((r) => r.text());
  const urls = parseFontCss(css);
  const missing = FONT_WEIGHTS.filter((w) => !urls.has(w));
  if (missing.length) throw new Error(`Google Fonts returned no TTF for ${FONT_FAMILY} ${missing.join(', ')}`);
  return Promise.all(
    FONT_WEIGHTS.map(async (weight) => {
      const res = await politeFetch(urls.get(weight)!, { timeoutMs: 15_000, minIntervalMs: 0 });
      return { name: FONT_FAMILY, data: await res.arrayBuffer(), weight, style: 'normal' as const };
    }),
  );
}

let cached: Promise<LoadedFont[]> | undefined;

/** The four weights, loaded once per process. A failure is not cached, so the next render retries. */
export function loadFonts(): Promise<LoadedFont[]> {
  if (cached) return cached;
  const dir = env('NOCT_FONT_DIR');
  cached = (dir ? fromDisk(dir) : download()).catch((err) => {
    cached = undefined;
    throw err;
  });
  return cached;
}
