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
  props: { style?: Record<string, unknown>; children?: Node | Node[] | string; [attr: string]: unknown };
}

/**
 * Bump whenever a template changes how anything looks.
 *
 * Rendered slides are cached at the edge for a day, keyed by their signed URL, and the URL is built from the
 * slide's data. Change a layout without changing the data and the URL stays the same -- so the CDN keeps
 * serving the old design for up to 24 hours, in the studio and to Meta alike. The version rides in the URL
 * so a design change is a new URL.
 */
export const RENDER_VERSION = 2;

const PAD = 54;
/** The type column, inside the side margins. Every fixed width below is measured against it. */
const CONTENT_W = CANVAS.w - PAD * 2;
/** The table's day+time gutter, and the gap to the event beside it. */
const TABLE_GUTTER = 150;
const TABLE_GAP = 24;
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
      // satori honours lineClamp only on a block box. On the flex box every other text node uses, it is
      // accepted and silently ignored -- which is how every clamp in these templates did nothing until a
      // five-line billing ran up an event slide. tests/live/render.live.test.ts now measures it.
      ...(clamp ? { display: 'block', lineClamp: clamp } : {}),
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
      ...lines(d.lede).map((line) => slab(line, 84, -0.042, 1.07)),
      ...(d.date ? [slab(d.date, 84, -0.042, 1.07, G1, { marginTop: 14 })] : []),
    ]),
    swipeFoot(d.foot),
  ];
}

/**
 * A lede broken where its author broke it. Left to the wrapper, "Where to rave and dance in New York" split
 * as "...dance in / New York", which reads as two thoughts; a newline in the data keeps "in New York" whole.
 */
const lines = (value: string): string[] => value.split('\n').map((l) => l.trim()).filter(Boolean);

/** The covers' foot: the site on the left, and a prompt to swipe that points the way it wants you to go. */
const swipeFoot = (left: string): Node =>
  spread(
    {
      position: 'absolute', bottom: PAD, left: PAD, right: PAD, alignItems: 'baseline',
      fontSize: 38, color: G2, letterSpacing: track(38, 0.02),
    },
    [
      text(left, { fontSize: 38, color: G2 }),
      el({ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12 }, [
        text('Swipe', { fontSize: 38, color: G2 }),
        { type: 'img', props: { src: SWIPE_ARROW, width: 40, height: 28, style: { width: 40, height: 28 } } },
      ]),
    ],
  );

/**
 * The arrow after "Swipe", drawn: the post typeface has no U+2192, and a missing glyph renders as an empty box
 * rather than failing. Same grey as the word, stroked at the type's weight.
 */
const SWIPE_ARROW = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 28" fill="none" stroke="#FFFFFF" stroke-opacity="0.44" ' +
  'stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14h33"/><path d="M24 3l12 11-12 11"/></svg>',
).toString('base64')}`;

/** Full-bleed photo with the type at the foot. The composition that marks a weekend slide. */
function event(d: { position: string; name: string; venue: string; time: string; genre: string }): Node[] {
  const meta = [d.venue, d.time].filter(Boolean).join('  /  ');
  return [
    wordmark(),
    // Sized down from 46/92/48 after review: at the old size a long billing ran five lines up the flyer and
    // sat on its artwork. Three lines is the cap -- the veil darkens exactly the band this block occupies.
    column({ position: 'absolute', left: PAD, right: PAD, bottom: 132, gap: 14 }, [
      ...(d.position ? [text(d.position, { fontSize: 36, fontWeight: 500, letterSpacing: track(36, 0.01) })] : []),
      text(d.name, { fontSize: 70, fontWeight: 700, letterSpacing: track(70, -0.04), lineHeight: 1.04, width: CONTENT_W }, 3),
      ...(meta ? [text(meta, { fontSize: 38, color: G1, letterSpacing: track(38, -0.01) })] : []),
    ]),
    foot(d.genre, '', 32),
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
    column({ position: 'absolute', top: 186, left: PAD, right: PAD }, [
      ...(d.kicker ? [text(d.kicker, { fontSize: 34, color: G1, letterSpacing: track(34, 0.01), marginBottom: 10 })] : []),
      slab(d.when, 76, -0.045, 0.94),
    ]),
    // Sized down from 46/38/32 after review: seven two-line rows ran into the bottom edge. At these sizes the
    // worst case (every name wrapping, every venue present) ends clear of PAD; tests/live renders it.
    column({ position: 'absolute', top: 350, left: PAD, right: PAD, gap: 20 }, [
      ...d.rows.slice(0, TABLE_ROWS_MAX).map((r) =>
        el({ display: 'flex', flexDirection: 'row', gap: TABLE_GAP, alignItems: 'flex-start' }, [
          column({ width: TABLE_GUTTER, flexShrink: 0, gap: 3, paddingTop: 5 }, [
            text(r.day.toUpperCase(), { fontSize: 23, letterSpacing: track(23, 0.15), color: G2 }),
            text(r.time || 'TBC', { fontSize: 32, color: WHITE, letterSpacing: track(32, -0.01) }),
          ]),
          // An explicit width, not flex-grow: satori will happily let a long name run off the canvas
          // rather than wrap it, and a clipped headliner is the one thing this slide must never do.
          column({ width: CONTENT_W - TABLE_GUTTER - TABLE_GAP, flexShrink: 0, gap: 4 }, [
            text(r.event, {
              fontSize: 37, fontWeight: 600, letterSpacing: track(37, -0.02), lineHeight: 1.08,
              width: CONTENT_W - TABLE_GUTTER - TABLE_GAP,
            }, 2),
            ...(r.venue ? [text(r.venue, { fontSize: 26, color: G1 })] : []),
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
    swipeFoot(d.foot),
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

/**
 * The link glyph, drawn rather than typed. The copy asked for 🔗, but the post type has no emoji and a colour
 * emoji would be the only accent on a system that has none -- so it is the same symbol in the type's own
 * white, at the type's own weight.
 */
const LINK_ICON = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.4" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
  '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
).toString('base64')}`;

/**
 * The last slide: why NOCT exists, then where to find it. The question is the hook and gets the size; the
 * answer sits under it in grey; the link and its instruction sit at the foot where a thumb is.
 */
function cta(d: { question: string; answer: string; link: string; note: string }): Node[] {
  return [
    wordmark(),
    centred([
      ...lines(d.question).map((line) => slab(line, 80, -0.04, 1.08)),
      ...(d.answer ? [slab(d.answer, 56, -0.03, 1.12, G1, { marginTop: 28 })] : []),
    ]),
    column({ position: 'absolute', left: PAD, right: PAD, bottom: PAD, gap: 10 }, [
      ...(d.link
        ? [el({ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 16 }, [
            { type: 'img', props: { src: LINK_ICON, width: 50, height: 50, style: { width: 50, height: 50 } } },
            text(d.link, { fontSize: 56, fontWeight: 700, letterSpacing: track(56, -0.03) }),
          ])]
        : []),
      ...(d.note ? [text(d.note, { fontSize: 36, color: G2, letterSpacing: track(36, 0.01) })] : []),
    ]),
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
      case 'cta': return cta(slide.data);
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
