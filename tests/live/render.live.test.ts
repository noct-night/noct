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
  ['note', s({ template: 'note', data: { text: 'One feed for New York nightlife', after: 'Every listing, every night.', foot: 'noct.pro' } })],
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

  it('changes the digest when the look changes', async () => {
    const slide = SLIDES[1]![1];
    const mono = await slideDigest(slide, 'mono', false);
    expect(await slideDigest(slide, 'mono', false)).toBe(mono);
    expect(await slideDigest(slide, 'crush', false)).not.toBe(mono);
    expect(await slideDigest(slide, 'mono', true)).not.toBe(mono);
  });
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
