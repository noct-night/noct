/**
 * The title layer for a reel: one transparent 1080x1920 PNG that ffmpeg overlays on the video.
 *
 * Drawn with satori and sharp, the same two libraries that draw a carousel slide, and importing the same
 * constants. That is the whole reason it is done this way rather than with ffmpeg's own `drawtext`:
 * drawtext can put white letters on a video, but it cannot put *these* letters there. It has no access to
 * the tracking table in templates.ts, it needs a font file on the machine where a slide needs none, and
 * every value it takes would be a second copy of a number the design system already owns. A reel that does
 * not match the deck it goes out beside is the failure mode worth designing against.
 *
 * The scrim is part of this PNG rather than a separate ffmpeg filter. White type over unknown club footage
 * is illegible about half the time, and one composited layer means the type and the gradient that makes it
 * readable can never drift apart or be applied in the wrong order.
 */
import satori from 'satori';
import sharp from 'sharp';
import { DISPLAY_FONT, loadFonts } from '../post/font.js';
/** The deck's display face, so a reel title and the lineup on the carousel beside it are set alike. */
const TITLE_FONT = DISPLAY_FONT;
import { GROUND, linearGradient } from '../post/layers.js';
import { REEL, type TitlePosition } from './spec.js';

const WHITE = '#FFFFFF';
const G1 = 'rgba(255,255,255,.70)';

/**
 * The side margin and type sizes are the post system's, unchanged. 1080 wide is 1080 wide whether the
 * canvas is 1350 or 1920 tall, so nothing here is rescaled -- only the vertical placement differs.
 */
const PAD = 54;
const track = (fontSize: number, em: number): number => Math.round(fontSize * em * 1000) / 1000;

interface Node {
  type: string;
  props: { style?: Record<string, unknown>; children?: Node | Node[] | string };
}

const el = (style: Record<string, unknown>, children?: Node | Node[] | string): Node => ({
  type: 'div', props: { style, children },
});

/**
 * Where the type block sits, and how far up the scrim reaches with it.
 *
 * `low` is the default because the top of a reel belongs to Instagram: the account name, the audio strip
 * and the follow button all live up there, and so does the caption on some surfaces. `high` exists for
 * footage whose subject is in the lower half.
 */
const PLACEMENT: Record<TitlePosition, { justify: string; scrim: [number, number] }> = {
  // [scrim start, scrim end] as fractions down the canvas, in the direction the gradient runs.
  low: { justify: 'flex-end', scrim: [0.55, 1] },
  middle: { justify: 'center', scrim: [0.2, 0.8] },
  high: { justify: 'flex-start', scrim: [0, 0.45] },
};

export interface TitleInput {
  title: string;
  sub?: string;
  position?: TitlePosition;
  /** Draws NO / CT at the top, as every slide does. Off for a clip that is mostly someone else's footage. */
  wordmark?: boolean;
}

/**
 * The type tree. Composition is the event slide's: a heavy name with a lighter line under it, set against
 * the bottom margin, with the wordmark split to the edges at the top.
 */
export function titleTree(input: TitleInput): Node {
  const position = input.position ?? 'low';
  const { justify } = PLACEMENT[position];
  const children: Node[] = [];

  if (input.wordmark !== false) {
    children.push(
      el(
        {
          position: 'absolute', top: 50, left: PAD, right: PAD, display: 'flex',
          justifyContent: 'space-between', fontSize: 96, fontWeight: 700,
          letterSpacing: track(96, -0.04), lineHeight: 1, color: WHITE,
        },
        [el({ display: 'flex', fontSize: 96 }, 'NO'), el({ display: 'flex', fontSize: 96 }, 'CT')],
      ),
    );
  }

  const block: Node[] = [
    // 92 / -0.042 / 1.01 is the event slide's headliner, unchanged. A reel title is the same kind of line
    // in the same place, so it is the same numbers; clamped at four so a long one cannot run off the frame.
    el(
      {
        display: 'flex', fontSize: 92, fontWeight: 700, letterSpacing: track(92, -0.042),
        lineHeight: 1.01, color: WHITE, lineClamp: 4,
      },
      input.title,
    ),
  ];
  if (input.sub) {
    block.push(
      el(
        {
          display: 'flex', fontSize: 48, fontWeight: 400, letterSpacing: track(48, -0.01),
          lineHeight: 1.15, color: G1, marginTop: 20, lineClamp: 2,
        },
        input.sub,
      ),
    );
  }

  children.push(
    el(
      {
        position: 'absolute', top: 0, bottom: 0, left: PAD, right: PAD,
        display: 'flex', flexDirection: 'column', justifyContent: justify,
        // Clear of the bottom margin by more than a slide would be: Instagram's own caption and action
        // rail sit over the bottom ~14% of a reel, and type under that is type nobody reads.
        paddingTop: position === 'high' ? 210 : 0,
        paddingBottom: position === 'low' ? 320 : 0,
      },
      block,
    ),
  );

  return el(
    { width: REEL.w, height: REEL.h, display: 'flex', position: 'relative', fontFamily: TITLE_FONT, color: WHITE },
    children,
  );
}

/**
 * The scrim: a one-directional wash of the ground colour, heaviest where the type is.
 *
 * Reuses `linearGradient` from the slide layers so the gradient maths stays in one place -- it takes the
 * canvas size, which is the only reason it works unchanged at 1920 tall.
 */
export function scrimSvg(position: TitlePosition): Buffer {
  const [from, to] = PLACEMENT[position].scrim;
  // 180deg runs top to bottom; for `high` the wash is heaviest at the top, so the stops are reversed
  // rather than the angle, which keeps every offset reading as "fraction down the canvas".
  const heavyAtTop = position === 'high';
  const stops = heavyAtTop
    ? [
        { at: from, color: GROUND, opacity: 0.86 },
        { at: (from + to) / 2, color: GROUND, opacity: 0.45 },
        { at: to, color: GROUND, opacity: 0 },
      ]
    : [
        { at: from, color: GROUND, opacity: 0 },
        { at: (from + to) / 2, color: GROUND, opacity: 0.5 },
        { at: to, color: GROUND, opacity: 0.9 },
      ];
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${REEL.w}" height="${REEL.h}">` +
      `<defs>${linearGradient('s', 180, stops, REEL.w, REEL.h)}</defs>` +
      `<rect width="${REEL.w}" height="${REEL.h}" fill="url(#s)"/></svg>`,
  );
}

/**
 * Scrim and type as one transparent PNG, ready to be handed to ffmpeg's overlay filter.
 *
 * PNG and not JPEG: this one has to keep its alpha, which is the opposite of the constraint on a slide
 * (Instagram rejects PNG on the media endpoints -- but this never reaches an endpoint, only ffmpeg).
 */
export async function renderTitle(input: TitleInput): Promise<Buffer> {
  const fonts = await loadFonts({ body: TITLE_FONT, display: TITLE_FONT });
  const svg = await satori(titleTree(input) as never, { width: REEL.w, height: REEL.h, fonts });
  const type = await sharp(Buffer.from(svg)).png().toBuffer();
  return sharp(scrimSvg(input.position ?? 'low'))
    .composite([{ input: type }])
    .png()
    .toBuffer();
}
