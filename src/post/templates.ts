/**
 * The seven slide layouts, as satori element trees.
 *
 * Every number here is transcribed from the review prototype's CSS, which is authored at true 1080x1350.
 * They are roughly 2.45x the app's 440px scale on purpose: a feed post is judged at thumbnail size, so the
 * type has to carry further than it does in the app. They have been pushed up twice. Do not shrink them.
 *
 * Two translations happen on the way in, because satori is not a browser:
 *
 *  - CSS `letter-spacing` in em becomes px, because satori takes a number. The em value is kept in the
 *    call so the source of each number stays readable: `track(96, -0.04)`, not `-3.84`.
 *  - CSS grid and `transform: translateY(-50%)` have no equivalent, so a grid row becomes a flex row with a
 *    fixed first column, and a vertically centred block becomes a full-height flex box with centred content.
 *
 * Only type is drawn here. Photos, tones, the veil and the grain are composited underneath by sharp
 * (src/post/render.ts), which is also why none of these trees sets a background.
 */
import type { Slide } from './types.js';
import { CANVAS, TABLE_ROWS_MAX } from './types.js';
import { FONT_FAMILY } from './font.js';

/** A satori element. Plain objects, so nothing in the render path needs React. */
export interface Node {
  type: string;
  props: { style?: Record<string, unknown>; children?: Node | Node[] | string };
}

const PAD = 54;
/** The type column, inside the side margins. Every fixed width below is measured against it. */
const CONTENT_W = CANVAS.w - PAD * 2;
/** The table's day+time gutter, and the gap to the event beside it. */
const TABLE_GUTTER = 184;
const TABLE_GAP = 28;
/** The listing's time column. */
const LISTING_TIME_W = 158;
const LISTING_GAP = 28;

const WHITE = '#FFFFFF';
const G1 = 'rgba(255,255,255,.70)';
const G2 = 'rgba(255,255,255,.44)';
const G3 = 'rgba(255,255,255,.26)';

/** CSS letter-spacing in em, as the px satori wants. */
const track = (fontSize: number, em: number): number => Math.round(fontSize * em * 1000) / 1000;

const el = (style: Record<string, unknown>, children?: Node | Node[] | string): Node => ({
  type: 'div',
  props: { style, children },
});

/** A block of type. `clamp` truncates at a line count the way `-webkit-line-clamp` does on the page. */
const text = (
  value: string,
  style: Record<string, unknown> & { fontSize: number },
  clamp?: number,
): Node =>
  el(
    {
      display: 'flex',
      color: WHITE,
      ...style,
      ...(clamp ? { lineClamp: clamp } : {}),
    },
    value,
  );

/** A row that pushes its two ends apart, the way the wordmark and the feet all do. */
const spread = (style: Record<string, unknown>, children: Node[]): Node =>
  el({ display: 'flex', justifyContent: 'space-between', ...style }, children);

const column = (style: Record<string, unknown>, children: Node[]): Node =>
  el({ display: 'flex', flexDirection: 'column', ...style }, children);

/** NO left, CT right, split to the edges. On every slide, at the same place, at the same size. */
const wordmark = (): Node =>
  spread(
    {
      position: 'absolute', top: 50, left: PAD, right: PAD,
      fontSize: 96, fontWeight: 700, letterSpacing: track(96, -0.04), lineHeight: 1, color: WHITE,
    },
    [text('NO', { fontSize: 96 }), text('CT', { fontSize: 96 })],
  );

/** The foot line: one thing on the left, one on the right, either of which may be empty. */
const foot = (left: string, right = '', size = 40, color = G1): Node =>
  spread(
    { position: 'absolute', bottom: PAD, left: PAD, right: PAD, alignItems: 'baseline', fontSize: size, color },
    [text(left, { fontSize: size, color }), text(right, { fontSize: size, color })],
  );

/** A block centred on the canvas. Replaces `top: 50%; transform: translateY(-50%)`. */
const centred = (children: Node[]): Node =>
  column(
    { position: 'absolute', top: 0, bottom: 0, left: PAD, right: PAD, justifyContent: 'center' },
    children,
  );

const slab = (
  value: string, fontSize: number, em: number, lineHeight: number, color = WHITE, extra: Record<string, unknown> = {},
): Node => text(value, { fontSize, fontWeight: 700, letterSpacing: track(fontSize, em), lineHeight, color, ...extra });

// ── The seven templates ─────────────────────────────────────────────────────

/** Says plainly what the post is, then the date. One block, one size, the way it is scanned in the feed. */
function cover(d: { lede: string; date: string; foot: string }): Node[] {
  return [
    wordmark(),
    centred([
      slab(d.lede, 84, -0.042, 1.07),
      ...(d.date ? [slab(d.date, 84, -0.042, 1.07, G1, { marginTop: 14 })] : []),
    ]),
    spread(
      {
        position: 'absolute', bottom: PAD, left: PAD, right: PAD, alignItems: 'baseline',
        fontSize: 38, color: G2, letterSpacing: track(38, 0.02),
      },
      [text(d.foot, { fontSize: 38, color: G2 }), text('Swipe', { fontSize: 38, color: G2 })],
    ),
  ];
}

/** Full-bleed photo with the type at the foot. The composition that marks a weekend slide. */
function event(d: { position: string; name: string; venue: string; time: string; genre: string }): Node[] {
  const meta = [d.venue, d.time].filter(Boolean).join('  /  ');
  return [
    wordmark(),
    column({ position: 'absolute', left: PAD, right: PAD, bottom: 152, gap: 20 }, [
      ...(d.position ? [text(d.position, { fontSize: 46, fontWeight: 500, letterSpacing: track(46, 0.01) })] : []),
      slab(d.name, 92, -0.042, 1.01, WHITE, {}),
      ...(meta ? [text(meta, { fontSize: 48, color: G1, letterSpacing: track(48, -0.01) })] : []),
    ]),
    foot(d.genre),
  ];
}

/**
 * The weekend table. A day+time gutter does the scanning work and the event name wraps rather than
 * truncating: a name cut mid-word is worse than a deeper row. Seven rows is the most that stays legible at
 * feed size, so an eighth event starts a second table slide instead of shrinking the type.
 */
function table(d: { kicker: string; when: string; rows: { day: string; time: string; event: string; venue: string }[] }): Node[] {
  return [
    wordmark(),
    column({ position: 'absolute', top: 190, left: PAD, right: PAD }, [
      ...(d.kicker ? [text(d.kicker, { fontSize: 40, color: G1, letterSpacing: track(40, 0.01), marginBottom: 14 })] : []),
      slab(d.when, 92, -0.045, 0.94),
    ]),
    column({ position: 'absolute', top: 404, left: PAD, right: PAD, bottom: PAD, gap: 30 }, [
      ...d.rows.slice(0, TABLE_ROWS_MAX).map((r) =>
        el({ display: 'flex', flexDirection: 'row', gap: TABLE_GAP, alignItems: 'flex-start' }, [
          column({ width: TABLE_GUTTER, flexShrink: 0, gap: 5, paddingTop: 6 }, [
            text(r.day.toUpperCase(), { fontSize: 27, letterSpacing: track(27, 0.15), color: G2 }),
            text(r.time || 'TBC', { fontSize: 38, color: WHITE, letterSpacing: track(38, -0.01) }),
          ]),
          // An explicit width, not flex-grow: satori will happily let a long name run off the canvas
          // rather than wrap it, and a clipped headliner is the one thing this slide must never do.
          column({ width: CONTENT_W - TABLE_GUTTER - TABLE_GAP, flexShrink: 0, gap: 6 }, [
            text(r.event, { fontSize: 46, fontWeight: 600, letterSpacing: track(46, -0.025), lineHeight: 1.08 }, 2),
            ...(r.venue ? [text(r.venue, { fontSize: 32, color: G1 })] : []),
          ]),
        ]),
      ),
    ]),
  ];
}

/** Tonight: four events, more air per row than the table, and a genre line. */
function listing(d: { kicker: string; when: string; events: { time: string; name: string; venue: string; genre: string }[] }): Node[] {
  return [
    wordmark(),
    column({ position: 'absolute', top: 214, left: PAD, right: PAD }, [
      text(d.kicker, { fontSize: 42, color: G1, letterSpacing: track(42, 0.01), marginBottom: 16 }),
      slab(d.when, 110, -0.045, 0.94),
    ]),
    column({ position: 'absolute', top: 516, left: PAD, right: PAD, gap: 54 }, [
      ...d.events.slice(0, 4).map((e) =>
        column({ gap: 10 }, [
          el({ display: 'flex', flexDirection: 'row', gap: LISTING_GAP, alignItems: 'baseline' }, [
            text(e.time, { fontSize: 44, color: G2, width: LISTING_TIME_W, flexShrink: 0 }),
            text(
              e.name,
              {
                fontSize: 60, fontWeight: 600, letterSpacing: track(60, -0.028), lineHeight: 1.06,
                width: CONTENT_W - LISTING_TIME_W - LISTING_GAP, flexShrink: 0,
              },
              2,
            ),
          ]),
          text([e.venue, e.genre].filter(Boolean).join('  /  '), { fontSize: 42, color: G1, marginLeft: 186 }),
        ]),
      ),
    ]),
  ];
}

/**
 * A venue slide inverts the event composition: type at the top, photo in a band at the foot. That, plus the
 * running series index, is the only thing separating the two series -- both live in the same near-black.
 */
function venue(d: { index: string; name: string; hood: string; note: string; foot: string; image: unknown }): Node[] {
  return [
    // Venue photography still has to be shot or licensed, so a slide without one says so plainly rather
    // than showing an empty band that reads as a rendering fault.
    ...(d.image
      ? []
      : [
          el(
            {
              position: 'absolute', left: 0, right: 0, bottom: 0, height: VENUE_BAND_PLACEHOLDER.height,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            },
            [text(VENUE_BAND_PLACEHOLDER.label, { fontSize: 32, color: G3, letterSpacing: track(32, 0.06) })],
          ),
        ]),
    wordmark(),
    column({ position: 'absolute', top: 192, left: PAD, right: PAD, gap: 16 }, [
      spread({ fontSize: 28, letterSpacing: track(28, 0.2), color: G2 }, [
        text('VENUES', { fontSize: 28, letterSpacing: track(28, 0.2), color: G2 }),
        text(d.index.toUpperCase(), { fontSize: 28, letterSpacing: track(28, 0.2), color: G2 }),
      ]),
      slab(d.name, 104, -0.046, 0.97, WHITE, {}),
      ...(d.hood ? [text(d.hood, { fontSize: 44, fontWeight: 500, color: G1, letterSpacing: track(44, -0.005) })] : []),
      ...(d.note ? [text(d.note, { fontSize: 40, color: G1, lineHeight: 1.38, maxWidth: 900, marginTop: 10 }, 5)] : []),
    ]),
    ...(d.foot ? [text(d.foot, { position: 'absolute', left: PAD, bottom: 472, fontSize: 34, color: G2 })] : []),
  ];
}

/** The venues cover. Larger than the weekend cover because it carries no date line. */
function venueCover(d: { lede: string; sub: string; foot: string }): Node[] {
  return [
    wordmark(),
    centred([
      slab(d.lede, 96, -0.046, 1.04),
      ...(d.sub ? [slab(d.sub, 96, -0.046, 1.04, G1, { marginTop: 14 })] : []),
    ]),
    spread(
      {
        position: 'absolute', bottom: PAD, left: PAD, right: PAD, alignItems: 'baseline',
        fontSize: 38, color: G2, letterSpacing: track(38, 0.02),
      },
      [text(d.foot, { fontSize: 38, color: G2 }), text('Swipe', { fontSize: 38, color: G2 })],
    ),
  ];
}

/** One sentence, big. The slide that says something in NOCT's own voice rather than a promoter's. */
function note(d: { text: string; after: string; foot: string }): Node[] {
  return [
    wordmark(),
    centred([
      slab(d.text, 94, -0.045, 1.08),
      ...(d.after ? [text(d.after, { fontSize: 42, color: G1, marginTop: 40, maxWidth: 800, lineHeight: 1.42 })] : []),
    ]),
    foot(d.foot),
  ];
}

/** The placeholder a venue band shows before there is a photograph of the venue to put in it. */
export const VENUE_BAND_PLACEHOLDER = { height: 430, color: G3, label: 'Photo of the venue' };

/**
 * A slide as one satori tree. The root is the canvas: transparent, because everything behind the type is
 * composited by sharp.
 */
export function slideTree(slide: Slide): Node {
  const children = ((): Node[] => {
    switch (slide.template) {
      case 'cover': return cover(slide.data);
      case 'event': return event(slide.data);
      case 'table': return table(slide.data);
      case 'listing': return listing(slide.data);
      case 'venue': return venue(slide.data);
      case 'venuecover': return venueCover(slide.data);
      case 'note': return note(slide.data);
    }
  })();
  return el(
    {
      width: CANVAS.w, height: CANVAS.h, display: 'flex', position: 'relative',
      fontFamily: FONT_FAMILY, color: WHITE,
    },
    children,
  );
}
