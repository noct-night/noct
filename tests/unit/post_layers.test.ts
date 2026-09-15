import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { grainSvg, linearGradient, TONE_SVG, toneSvg, veilSvg } from '../../src/post/layers.js';
import { CANVAS, TONES } from '../../src/post/types.js';

/** Average luminance of a horizontal band, as a rough but stable read on "is this darker than that". */
async function bandLuma(png: Buffer, fromY: number, toY: number): Promise<number> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let total = 0;
  let n = 0;
  for (let y = fromY; y < toY; y += 4) {
    for (let x = 0; x < info.width; x += 8) {
      const i = (y * info.width + x) * info.channels;
      total += 0.213 * data[i]! + 0.715 * data[i + 1]! + 0.072 * data[i + 2]!;
      n++;
    }
  }
  return total / n;
}

describe('linearGradient', () => {
  it('runs top to bottom for a CSS 180deg', () => {
    const svg = linearGradient('g', 180, [{ at: 0, color: '#000' }, { at: 1, color: '#fff' }], 100, 200);
    expect(svg).toContain('x1="50" y1="0"');
    expect(svg).toContain('x2="50" y2="200"');
  });

  it('runs left to right for a CSS 90deg', () => {
    const svg = linearGradient('g', 90, [{ at: 0, color: '#000' }, { at: 1, color: '#fff' }], 100, 200);
    expect(svg).toContain('x1="0" y1="100"');
    expect(svg).toContain('x2="100" y2="100"');
  });

  it('covers the corners on a diagonal, which is what the CSS gradient line length does', () => {
    // 160deg on 1080x1350: |w sin a| + |h cos a| is longer than either side.
    const svg = linearGradient('g', 160, [{ at: 0, color: '#000' }, { at: 1, color: '#fff' }]);
    const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map((k) => Number(new RegExp(`${k}="([-\\d.]+)"`).exec(svg)![1]));
    expect(Math.hypot(x2! - x1!, y2! - y1!)).toBeGreaterThan(CANVAS.h);
  });
});

describe('the placeholder tones', () => {
  it('has one for every tone the feed can hand out', () => {
    expect(Object.keys(TONE_SVG).sort()).toEqual([...TONES].sort());
  });

  it.each(TONES)('renders %s at the post canvas', async (tone) => {
    const png = await sharp(toneSvg(tone)).png().toBuffer();
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([CANVAS.w, CANVAS.h]);
  });

  it.each(TONES)('keeps %s dark enough to carry white type', async (tone) => {
    const png = await sharp(toneSvg(tone)).png().toBuffer();
    // Everything lives in NOCT's near-black. A tone averaging mid-grey would bury the wordmark.
    expect(await bandLuma(png, 0, CANVAS.h)).toBeLessThan(90);
  });

  it.each(TONES)('actually draws a pattern in %s rather than a flat field', async (tone) => {
    const { data, info } = await sharp(toneSvg(tone)).raw().toBuffer({ resolveWithObject: true });
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += info.channels * 37) seen.add(data[i]!);
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('the veil', () => {
  it('is dark at the top, clearest a third down, and near solid at the foot', async () => {
    // Composited over white so the veil's own opacity is what the luminance reads.
    const white = sharp({ create: { width: CANVAS.w, height: CANVAS.h, channels: 3, background: '#FFFFFF' } });
    const png = await white.composite([{ input: veilSvg(), blend: 'over' }]).png().toBuffer();

    const top = await bandLuma(png, 0, 40);
    const clear = await bandLuma(png, Math.round(CANVAS.h * 0.29), Math.round(CANVAS.h * 0.31));
    const foot = await bandLuma(png, CANVAS.h - 40, CANVAS.h);

    expect(clear).toBeGreaterThan(top);
    expect(top).toBeGreaterThan(foot);
    // The foot has to be dark enough for white type at 92px to hold against a bright flyer.
    expect(foot).toBeLessThan(40);
  });
});

describe('the grain', () => {
  it('renders as noise rather than a flat layer', async () => {
    const { data, info } = await sharp(grainSvg()).raw().toBuffer({ resolveWithObject: true });
    const seen = new Set<number>();
    for (let i = 0; i < 4000 * info.channels; i += info.channels) seen.add(data[i]!);
    expect(seen.size).toBeGreaterThan(20);
  });
});
