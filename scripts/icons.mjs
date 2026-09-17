/**
 * Build every favicon and app icon from the one logo file: `npm run icons`.
 *
 *   brand/noct-logo.png  ->  favicon.ico              16, 32, 48   (browser tabs, bookmarks)
 *                            icons/favicon-16.png, favicon-32.png
 *                            icons/apple-touch-icon.png  180       (iPhone home screen)
 *
 * The small sizes are cropped closer than the logo file. At 16px the logo's own padding leaves the letters
 * about ten pixels tall across two lines, and "NO / CT" turns to grey mush; cropped so the letters fill
 * most of the square, it stays legible. The home-screen icon keeps the original padding, because iOS
 * rounds its corners and the margin is what keeps the letters clear of them.
 *
 * Replace brand/noct-logo.png (square, black ground) and run this again.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import sharp from 'sharp';

const SRC = 'brand/noct-logo.png';
/** How much of the small icons the letters fill. */
const SMALL_FILL = 0.86;

/** The square around the letters, found by looking for the white pixels rather than hard-coded. */
async function tightCrop() {
  const { data, info } = await sharp(SRC).raw().toBuffer({ resolveWithObject: true });
  let x0 = info.width, y0 = info.height, x1 = 0, y1 = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (data[i] > 128 && data[i + 1] > 128 && data[i + 2] > 128) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 <= x0) throw new Error(`${SRC}: no light pixels found; the logo should be light letters on a dark ground`);
  const side = Math.min(info.width, info.height, Math.round(Math.max(x1 - x0, y1 - y0) / SMALL_FILL));
  const clamp = (v, max) => Math.max(0, Math.min(v, max - side));
  return {
    left: clamp(Math.round((x0 + x1) / 2 - side / 2), info.width),
    top: clamp(Math.round((y0 + y1) / 2 - side / 2), info.height),
    width: side, height: side,
  };
}

const png = (image, size) => image.clone().resize(size, size, { kernel: 'lanczos3' }).flatten({ background: '#000' }).png().toBuffer();

/** An .ico holding PNGs, which every browser in use reads. Header, one directory entry per size, then the data. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const small = sharp(SRC).extract(await tightCrop());
const full = sharp(SRC);
await mkdir('icons', { recursive: true });

const sizes = await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(small, size) })));
await writeFile('favicon.ico', ico(sizes));
await writeFile('icons/favicon-16.png', sizes[0].data);
await writeFile('icons/favicon-32.png', sizes[1].data);
await writeFile('icons/apple-touch-icon.png', await png(full, 180));
console.log('wrote favicon.ico (16, 32, 48), icons/favicon-16.png, icons/favicon-32.png, icons/apple-touch-icon.png');
