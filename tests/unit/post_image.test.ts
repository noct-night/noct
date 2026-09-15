import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  allowedImageHosts, assertFetchableImage, DEFAULT_IMAGE_HOSTS, ImageSourceError, treatedJpeg, TREATMENT_OPS,
} from '../../src/post/image.js';
import { CANVAS } from '../../src/post/types.js';

describe('the flyer host allowlist', () => {
  it('allows the CDNs the source adapters actually use', () => {
    expect(() => assertFetchableImage('https://images.ra.co/abc.jpg')).not.toThrow();
    expect(() => assertFetchableImage('https://dice-media.imgix.net/abc.jpg')).not.toThrow();
  });

  it('refuses anything else, which is what stops it being an SSRF hole', () => {
    for (const url of [
      'https://evil.example.com/x.jpg',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:5432/',
      'https://images.ra.co.evil.example.com/x.jpg',
    ]) {
      expect(() => assertFetchableImage(url), url).toThrow(ImageSourceError);
    }
  });

  it('refuses schemes that would read something other than the web', () => {
    expect(() => assertFetchableImage('file:///etc/passwd')).toThrow(/unsupported scheme/);
    expect(() => assertFetchableImage('data:image/png;base64,iVBOR')).toThrow(/unsupported scheme/);
    expect(() => assertFetchableImage('not a url')).toThrow(/absolute http/);
  });

  it('matches the host case-insensitively', () => {
    expect(() => assertFetchableImage('https://IMAGES.RA.CO/abc.jpg')).not.toThrow();
  });

  it('extends through NOCT_IMG_HOSTS without loosening the default set', () => {
    const hosts = allowedImageHosts({ NOCT_IMG_HOSTS: 'cdn.example.com, other.example.com' });
    expect(hosts.has('cdn.example.com')).toBe(true);
    expect(hosts.has('other.example.com')).toBe(true);
    for (const h of DEFAULT_IMAGE_HOSTS) expect(hosts.has(h)).toBe(true);
    expect(hosts.has('evil.example.com')).toBe(false);
  });
});

describe('treatment filter chains', () => {
  it('leaves a raw image alone', () => {
    expect(TREATMENT_OPS.none).toMatchObject({ grayscale: false, multiply: 1, offset: 0, matrix: null });
  });

  it('translates contrast then brightness into sharp’s linear() terms', () => {
    // mono is contrast(1.08) brightness(.94): multiply = b*c, offset = 255*b*(.5 - .5c).
    expect(TREATMENT_OPS.mono.multiply).toBeCloseTo(0.94 * 1.08, 6);
    expect(TREATMENT_OPS.mono.offset).toBeCloseTo(255 * 0.94 * (0.5 - 0.54), 6);
    // crush darkens hard, so its offset is strongly negative.
    expect(TREATMENT_OPS.crush.offset).toBeLessThan(TREATMENT_OPS.mono.offset);
  });

  it('folds warm’s whole colour transform into one matrix, with no separate greyscale step', () => {
    // Chaining .grayscale() before .recomb() can leave sharp on a single-channel colourspace, where a
    // 3x3 recombination is an error.
    expect(TREATMENT_OPS.warm.grayscale).toBe(false);
    expect(TREATMENT_OPS.warm.matrix).not.toBeNull();
    const m = TREATMENT_OPS.warm.matrix!;
    expect(m).toHaveLength(3);
    for (const row of m) expect(row).toHaveLength(3);
    // Greyed first, then tinted: every row reads the same luminance mix, so identical input channels stay
    // identical, and the red row ends up warmer than the blue one.
    const rowSum = (r: number[]): number => r.reduce((a, b) => a + b, 0);
    expect(rowSum(m[0]!)).toBeGreaterThan(rowSum(m[2]!));
  });
});

describe('treatedJpeg', () => {
  /** A 4:3 source, so framing to the 4:5 canvas has to do real work. */
  async function source(): Promise<Buffer> {
    return sharp({ create: { width: 800, height: 600, channels: 3, background: '#7788AA' } }).png().toBuffer();
  }

  it('always returns the post canvas, whatever went in', async () => {
    const out = await treatedJpeg(await source(), 'mono');
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([CANVAS.w, CANVAS.h]);
    expect(meta.format).toBe('jpeg');
  });

  it('greys a colour flyer under mono', async () => {
    const out = await treatedJpeg(await source(), 'mono');
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    // A grey pixel has near-equal channels; the source was distinctly blue.
    expect(Math.abs(data[0]! - data[2]!)).toBeLessThan(6);
  });

  it('keeps colour under none', async () => {
    const out = await treatedJpeg(await source(), 'none');
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(Math.abs(data[0]! - data[2]!)).toBeGreaterThan(20);
  });

  it('letterboxes onto the ground under contain, rather than cropping', async () => {
    const out = await treatedJpeg(await source(), 'none', 'contain');
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    // Top-left is the ground (#0B0B0B) because a 4:3 image fitted into 4:5 leaves bars above and below.
    expect(data[0]).toBeLessThan(30);
    expect([info.width, info.height]).toEqual([CANVAS.w, CANVAS.h]);
  });

  it('fills the frame under cover, leaving no bars', async () => {
    const out = await treatedJpeg(await source(), 'none', 'cover');
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(30);
  });

  it('flattens a transparent PNG onto the ground instead of compositing it as black', async () => {
    const rgba = await sharp({
      create: { width: 100, height: 100, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } },
    }).png().toBuffer();
    const out = await treatedJpeg(rgba, 'none');
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeLessThan(30);
  });
});
