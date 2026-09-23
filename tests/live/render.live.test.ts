/**
 * Opt-in network tests for the slide renderer: NOCT_LIVE=1 npx vitest run tests/live/render.live.test.ts
 *
 * These live here rather than in tests/unit because satori needs the real Red Hat Display files, and the honest
 * choices are fetching them or vendoring 440 KB of font binaries into the repo. The offline half of the
 * renderer -- tones, veil, grain, the treatment chains, the framing -- is covered in tests/unit and needs
 * no font at all, so what is gated here is specifically "does type land on the canvas".
 *
 * Set NOCT_FONT_DIR to a directory of RedHatDisplay-400/500/600/700.ttf to run these without the network.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { renderSlide, renderType, slideDigest } from '../../src/post/render.js';
import { parseFontCss } from '../../src/post/font.js';
import { CANVAS, slideSchema, type Slide } from '../../src/post/types.js';

const live = Boolean(process.env.NOCT_LIVE) || Boolean(process.env.NOCT_FONT_DIR);

/** A 1x1 grey PNG, so a slide with a photo renders without reaching an image CDN. */
const FAKE_FLYER = { src: 'https://images.ra.co/test.png', fit: 'cover' as const };
const fetchBytes = async (): Promise<Buffer> =>
  sharp({ create: { width: 1200, height: 1200, channels: 3, background: '#996633' } }).png().toBuffer();

const s = (o: unknown): Slide => slideSchema.parse(o);

const SLIDES: [string, Slide][] = [
  ['cover', s({ template: 'cover', data: { lede: 'Where to rave and dance in New York', date: 'Sep 18 to 20 weekend', foot: 'noct.pro' } })],
  ['event', s({ template: 'event', data: { position: 'Friday', name: 'SACRO by MESTIZA', venue: 'Brooklyn Storehouse', time: '22:00', genre: 'Techno', tex: 'x3', image: FAKE_FLYER } })],
  ['event without a flyer', s({ template: 'event', data: { position: 'Saturday', name: 'Mister Sunday', venue: 'Nowadays', time: '15:00', genre: 'Disco', tex: 'x5', image: null } })],
  ['table', s({ template: 'table', data: { kicker: 'Friday', when: 'Sep 18', rows: [
    { day: 'Fri', time: '22:00', event: 'SACRO by MESTIZA', venue: 'Brooklyn Storehouse' },
    { day: 'Fri', time: '', event: 'A billing long enough that it has to wrap onto a second line', venue: 'Knockdown Center' },
  ] } })],
  ['listing', s({ template: 'listing', data: { kicker: 'Tonight in New York', when: 'Thursday', events: [
    { time: '22:00', name: 'DAY+NIGHT', venue: 'BASEMENT', genre: 'Hard techno' },
  ] } })],
  ['venue', s({ template: 'venue', data: { index: '01 / 04', name: 'Nowadays', hood: 'Ridgewood, Queens', note: 'Dancefloor plus a backyard.', foot: '56-06 Cooper Ave', image: null } })],
  ['venuecover', s({ template: 'venuecover', data: { lede: 'Where to go', sub: 'Four New York venues', foot: 'noct.pro' } })],
  ['vinyl', s({ template: 'vinyl', data: { title: 'ART IS HOW\nWE DECORATE SPACE', sub: 'MUSIC IS HOW\nWE DECORATE TIME.', side: 'SIDE A', rpm: '33 1/3 RPM', note: 'A SENTIMENTAL SPACE\nFOR WANDERERS ONLY', foot: 'noct.pro' } })],
  ['note', s({ template: 'note', data: { text: 'One feed for New York nightlife', after: 'Every listing, every night.', foot: 'noct.pro' } })],
  ['cta', s({ template: 'cta', data: { question: 'sick of checking 10 places for one night out?', answer: 'NYC nightlife, all in one place', link: 'noct.pro', note: 'link in bio' } })],
];

/** Fraction of sampled pixels that are not the near-black ground: a cheap "did anything get drawn". */
async function inkCoverage(jpeg: Buffer): Promise<number> {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  let lit = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += info.channels * 13) {
    if (data[i]! > 60) lit++;
    n++;
  }
  return lit / n;
}

describe.skipIf(!live)('rendering a slide', () => {
  it.each(SLIDES)('renders %s at 1080x1350 JPEG', async (_name, slide) => {
    const jpeg = await renderSlide(slide, { treatment: 'mono', grain: false, fetchBytes });
    const meta = await sharp(jpeg).metadata();
    expect([meta.width, meta.height]).toEqual([CANVAS.w, CANVAS.h]);
    // JPEG, not PNG: Instagram rejects PNG on the media endpoints.
    expect(meta.format).toBe('jpeg');
  }, 60_000);

  it.each(SLIDES)('puts visible type on %s', async (_name, slide) => {
    const jpeg = await renderSlide(slide, { treatment: 'mono', grain: false, fetchBytes });
    // The wordmark alone guarantees some ink; a blank canvas would mean satori silently laid out nothing.
    expect(await inkCoverage(jpeg)).toBeGreaterThan(0.002);
  }, 60_000);

  it('keeps the type layer transparent so what is under it shows through', async () => {
    const png = await renderType(SLIDES[0]![1]);
    const meta = await sharp(png).metadata();
    expect(meta.channels).toBe(4);
    expect(meta.hasAlpha).toBe(true);
  }, 60_000);

  it('renders the same slide identically twice, so a signed URL is one image', async () => {
    const opts = { treatment: 'mono' as const, grain: false, fetchBytes };
    const [a, b] = await Promise.all([renderSlide(SLIDES[0]![1], opts), renderSlide(SLIDES[0]![1], opts)]);
    expect(a.equals(b)).toBe(true);
  }, 60_000);

  it('draws a photo in the look chosen for its slide, and in the post\'s look otherwise', async () => {
    const colourAt = async (image: object): Promise<number> => {
      const slide = s({ template: 'event', data: { name: 'x', tex: 'x1', image } });
      const jpeg = await renderSlide(slide, { treatment: 'mono', grain: false, fetchBytes });
      // Above the veil and the type, where the photo shows as it was treated.
      const { data } = await sharp(jpeg).extract({ left: 540, top: 300, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
      return Math.abs(data[0]! - data[2]!);
    };
    expect(await colourAt(FAKE_FLYER)).toBeLessThan(6);
    expect(await colourAt({ ...FAKE_FLYER, treatment: 'none' })).toBeGreaterThan(40);
  });

  it('changes the digest when the look changes', async () => {
    const slide = SLIDES[1]![1];
    const mono = await slideDigest(slide, 'mono', false);
    expect(await slideDigest(slide, 'mono', false)).toBe(mono);
    expect(await slideDigest(slide, 'crush', false)).not.toBe(mono);
    expect(await slideDigest(slide, 'mono', true)).not.toBe(mono);
  });
});

/** Topmost and bottom-most rows holding bright pixels, ignoring the wordmark band at the top. */
async function inkRows(png: Buffer, fromY = 200): Promise<{ top: number; bottom: number }> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let top = -1;
  let bottom = -1;
  for (let y = fromY; y < info.height; y++) {
    for (let x = 0; x < info.width; x += 2) {
      const i = (y * info.width + x) * info.channels;
      // The type layer is transparent PNG: count only opaque, bright pixels.
      if (data[i]! > 150 && (info.channels < 4 || data[i + 3]! > 150)) {
        if (top < 0) top = y;
        bottom = y;
        break;
      }
    }
  }
  return { top, bottom };
}

const LONG = 'Nonstop: Batu, DJ Masda, JASSS b2b MORENXXX, Mariposa, Roza Terenzi, Vlada b2b Vaahzer, and a long list of friends besides';

describe.skipIf(!live)('the review fixes stay fixed', () => {
  it('caps an event name at three lines', async () => {
    // satori ignores lineClamp on a flex box, so every clamp silently did nothing until a five-line billing ran
    // up a flyer. Unclamped, this name is seven lines and its block starts around y=640; clamped, well below 760.
    const png = await renderType(s({ template: 'event', data: { position: 'Saturday', name: LONG, venue: 'Nowadays', time: '22:00', genre: 'Club', tex: 'x1', image: null } }));
    const { top } = await inkRows(png);
    expect(top).toBeGreaterThan(760);
  }, 60_000);

  it('ends a full table above the bottom margin', async () => {
    // The worst case: seven rows, every name wrapping to two lines, every venue present.
    const rows = Array.from({ length: 7 }, (_, i) => ({ day: 'Fri', time: '22:00', event: `${LONG} ${i}`, venue: 'Brooklyn Storehouse' }));
    const png = await renderType(s({ template: 'table', data: { kicker: 'The rest of the weekend', when: 'Friday', rows } }));
    const { bottom } = await inkRows(png);
    expect(bottom).toBeGreaterThan(0);
    expect(bottom).toBeLessThan(CANVAS.h - 54);
  }, 60_000);
});

describe('the Google Fonts response', () => {
  it('pulls a TTF url per weight out of the css2 payload', () => {
    const css = `@font-face {
  font-family: 'Red Hat Display';
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/archivo/v25/a.ttf) format('truetype');
}
@font-face {
  font-family: 'Red Hat Display';
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/archivo/v25/b.ttf) format('truetype');
}`;
    const urls = parseFontCss(css);
    expect(urls.get(400)).toBe('https://fonts.gstatic.com/s/archivo/v25/a.ttf');
    expect(urls.get(700)).toBe('https://fonts.gstatic.com/s/archivo/v25/b.ttf');
  });

  it('ignores woff2, which satori cannot read', () => {
    const css = `@font-face { font-family: 'Red Hat Display'; font-weight: 400;
      src: url(https://fonts.gstatic.com/s/archivo/v25/a.woff2) format('woff2'); }`;
    expect(parseFontCss(css).size).toBe(0);
  });
});
