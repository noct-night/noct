/**
 * The seven slide layouts, as satori element trees.
 *
 * Every number here began as a transcription of the review prototype's CSS, authored at true 1080x1350, at
 * roughly 2.45x the app's 440px scale: a feed post is judged at thumbnail size, so the type has to carry
 * further than it does in the app. It was pushed up twice on that reasoning, and this file used to end the
 * paragraph "do not shrink them".
 *
 * Every display size then came down about 8% on request, deliberately and all at once so the scale stays a
 * scale. Small type -- anything at or under 46 -- did not move: it is already at the floor for a phone. If a
 * headline ever stops reading in the feed, this is the paragraph that explains why, and the sizes here are
 * the ones to put back.
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
import { GROUND } from './layers.js';
import { POST_TYPEFACES, type Typefaces } from './font.js';

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
export const RENDER_VERSION = 9;

/** The margin at the top and bottom edges. */
const PAD = 54;
/**
 * The margin at the left and right edges. Wider than PAD after review: at 54 the type ran close enough to the
 * sides to feel cramped, and a carousel is judged edge to edge as it is swiped, so every slide shares it.
 */
const SIDE = 68;
/** The type column, inside the side margins. Every fixed width below is measured against it. */
const CONTENT_W = CANVAS.w - SIDE * 2;
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
const wordmark = (type: Typefaces): Node =>
  spread(
    {
      position: 'absolute', top: 50, left: SIDE, right: SIDE,
      fontFamily: type.display, fontSize: 96, fontWeight: 700, letterSpacing: track(96, -0.04), lineHeight: 1, color: WHITE,
    },
    [text('NO', { fontSize: 96 }), text('CT', { fontSize: 96 })],
  );

/** The foot line: one thing on the left, one on the right, either of which may be empty. */
const foot = (left: string, right = '', size = 40, color = G1): Node =>
  spread(
    { position: 'absolute', bottom: PAD, left: SIDE, right: SIDE, alignItems: 'baseline', fontSize: size, color },
    [text(left, { fontSize: size, color }), text(right, { fontSize: size, color })],
  );

/** A block centred on the canvas. Replaces `top: 50%; transform: translateY(-50%)`. */
const centred = (children: Node[]): Node =>
  column(
    { position: 'absolute', top: 0, bottom: 0, left: SIDE, right: SIDE, justifyContent: 'center' },
    children,
  );

const slab = (
  value: string, fontSize: number, em: number, lineHeight: number, color = WHITE, extra: Record<string, unknown> = {},
): Node => text(value, { fontSize, fontWeight: 700, letterSpacing: track(fontSize, em), lineHeight, color, ...extra });

// ── The seven templates ─────────────────────────────────────────────────────

/**
 * Says plainly what the post is, then the date. One block, one size, the way it is scanned in the feed.
 *
 * 60, not the 78 the other display sizes came down to: the cover is the only slide whose type sits directly
 * under the wordmark with nothing between them, and at 78 the two blocks read as one heavy mass. It was
 * looked at on a real render at 78, 72, 66 and 60, and 60 is the one that was chosen.
 */
function cover(d: { lede: string; date: string; foot: string }, type: Typefaces): Node[] {
  return [
    wordmark(type),
    centred([
      ...lines(d.lede).map((line) => slab(line, 60, -0.042, 1.07)),
      ...(d.date ? [slab(d.date, 60, -0.042, 1.07, G1, { marginTop: 14 })] : []),
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
      position: 'absolute', bottom: PAD, left: SIDE, right: SIDE, alignItems: 'baseline',
      fontSize: FOOT_SIZE, color: G2, letterSpacing: track(FOOT_SIZE, 0.02),
    },
    [
      text(left, { fontSize: FOOT_SIZE, color: G2 }),
      el({ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }, [
        text('Swipe', { fontSize: FOOT_SIZE, color: G2 }),
        { type: 'img', props: { src: SWIPE_ARROW, width: 34, height: 24, style: { width: 34, height: 24 } } },
      ]),
    ],
  );

/** The site and the swipe prompt. Sized down from 38 after review: a footnote, not a second headline. */
const FOOT_SIZE = 31;

/**
 * The arrow after "Swipe", drawn: the post typeface has no U+2192, and a missing glyph renders as an empty box
 * rather than failing. Same grey as the word, stroked at the type's weight.
 */
const SWIPE_ARROW = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 28" fill="none" stroke="#FFFFFF" stroke-opacity="0.44" ' +
  'stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14h33"/><path d="M24 3l12 11-12 11"/></svg>',
).toString('base64')}`;

/** Full-bleed photo with the type at the foot. The composition that marks a weekend slide. */
function event(d: { position: string; name: string; venue: string; time: string; genre: string }, type: Typefaces): Node[] {
  const meta = [d.venue, d.time].filter(Boolean).join('  /  ');
  return [
    wordmark(type),
    // Sized down from 46/92/48 after review: at the old size a long billing ran five lines up the flyer and
    // sat on its artwork. Three lines is the cap -- the veil darkens exactly the band this block occupies.
    column({ position: 'absolute', left: SIDE, right: SIDE, bottom: 132, gap: 14 }, [
      ...(d.position ? [text(d.position, { fontSize: 36, fontWeight: 500, letterSpacing: track(36, 0.01) })] : []),
      text(d.name, { fontFamily: type.display, fontSize: 64, fontWeight: 700, letterSpacing: track(64, -0.04), lineHeight: 1.04, width: CONTENT_W }, 3),
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
function table(d: { kicker: string; when: string; rows: { day: string; time: string; event: string; venue: string }[] }, type: Typefaces): Node[] {
  return [
    wordmark(type),
    column({ position: 'absolute', top: 186, left: SIDE, right: SIDE }, [
      ...(d.kicker ? [text(d.kicker, { fontSize: 34, color: G1, letterSpacing: track(34, 0.01), marginBottom: 10 })] : []),
      slab(d.when, 70, -0.045, 0.94),
    ]),
    // Sized down from 46/38/32 after review: seven two-line rows ran into the bottom edge. At these sizes the
    // worst case (every name wrapping, every venue present) ends clear of PAD; tests/live renders it.
    column({ position: 'absolute', top: 350, left: SIDE, right: SIDE, gap: 20 }, [
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
              fontFamily: type.display,
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
function listing(d: { kicker: string; when: string; events: { time: string; name: string; venue: string; genre: string }[] }, type: Typefaces): Node[] {
  return [
    wordmark(type),
    column({ position: 'absolute', top: 214, left: SIDE, right: SIDE }, [
      text(d.kicker, { fontSize: 42, color: G1, letterSpacing: track(42, 0.01), marginBottom: 16 }),
      slab(d.when, 100, -0.045, 0.94),
    ]),
    column({ position: 'absolute', top: 516, left: SIDE, right: SIDE, gap: 54 }, [
      ...d.events.slice(0, 4).map((e) =>
        column({ gap: 10 }, [
          el({ display: 'flex', flexDirection: 'row', gap: LISTING_GAP, alignItems: 'baseline' }, [
            text(e.time, { fontSize: 44, color: G2, width: LISTING_TIME_W, flexShrink: 0 }),
            text(
              e.name,
              {
                fontFamily: type.display, fontSize: 56, fontWeight: 600, letterSpacing: track(56, -0.028), lineHeight: 1.06,
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
 * A venue slide, in two compositions.
 *
 * With a photograph it is an event slide: the room full bleed, the type at the foot under the same veil. The
 * band across the bottom this used to draw was a compromise from before there was a way to add photos at
 * all, and a room is the thing being sold -- it deserves the frame rather than a third of it.
 *
 * Without a photograph the type takes the whole canvas from the top, which is also why there is no grey
 * placeholder: an empty box reads as a rendering fault on the account, and "Photo of the venue" is a note to
 * the person drafting rather than something to publish. The studio's Add photo button is where it lives.
 */
function venue(d: { index: string; name: string; hood: string; note: string; foot: string; image: unknown }, type: Typefaces): Node[] {
  // The running series index. Spread across the full width, so it needs the width: inside a plain flex box
  // it shrinks to its contents and "VENUES" and "01 / 04" end up printed against each other.
  const kicker = { fontSize: 28, letterSpacing: track(28, 0.2), color: G2 };
  const indexRow = (extra: Record<string, unknown> = {}): Node =>
    spread({ ...kicker, ...extra }, [
      text('VENUES', kicker),
      text(d.index.toUpperCase(), kicker),
    ]);

  if (d.image) {
    return [
      wordmark(type),
      indexRow({ position: 'absolute', top: 192, left: SIDE, right: SIDE }),
      // The same block an event slide sets, at the same place: the veil darkens exactly this band. The note
      // is three lines here rather than nine -- over a photograph, a paragraph stops being readable.
      column({ position: 'absolute', left: SIDE, right: SIDE, bottom: 132, gap: 12 }, [
        text(d.name, { fontSize: 78, fontWeight: 700, letterSpacing: track(78, -0.045), lineHeight: 1, width: CONTENT_W }, 2),
        ...(d.hood ? [text(d.hood, { fontSize: 40, fontWeight: 500, color: G1, letterSpacing: track(40, -0.005) })] : []),
        ...(d.note ? [text(d.note, { fontSize: 34, color: G1, lineHeight: 1.34, width: CONTENT_W }, 3)] : []),
      ]),
      ...(d.foot ? [foot(d.foot, '', 32, G2)] : []),
    ];
  }

  return [
    wordmark(type),
    column({ position: 'absolute', top: 192, left: SIDE, right: SIDE, gap: 16 }, [
      indexRow(),
      text(d.name, { fontSize: 96, fontWeight: 700, letterSpacing: track(96, -0.046), lineHeight: 0.97, width: CONTENT_W }, 2),
      ...(d.hood ? [text(d.hood, { fontSize: 44, fontWeight: 500, color: G1, letterSpacing: track(44, -0.005) })] : []),
      ...(d.note ? [text(d.note, { fontSize: 40, color: G1, lineHeight: 1.38, width: 900, marginTop: 10 }, 9)] : []),
    ]),
    ...(d.foot ? [text(d.foot, { position: 'absolute', left: SIDE, bottom: PAD, fontSize: 34, color: G2 })] : []),
  ];
}

/** The venues cover. Larger than the weekend cover because it carries no date line. */
function venueCover(d: { lede: string; sub: string; foot: string }, type: Typefaces): Node[] {
  return [
    wordmark(type),
    centred([
      slab(d.lede, 88, -0.046, 1.04),
      ...(d.sub ? [slab(d.sub, 88, -0.046, 1.04, G1, { marginTop: 14 })] : []),
    ]),
    swipeFoot(d.foot),
  ];
}

/* ── The record label ───────────────────────────────────────────────────────
 * A white circle on the black ground, read as two blocks with the centre hole between them.
 *
 * Every box below is placed against the circle's own box, and its width is checked against the chord at
 * that height rather than the label's diameter: a line set 150px down has 634px of circle across it, not
 * 820, and type sized to the diameter would run off the paper. The numbers in the comments are those
 * chords. satori has no text-on-a-path, so nothing here is set on a curve -- and nothing in the reference
 * was either.
 */
const LABEL_D = 820;
const LABEL_TOP = 300;
const LABEL_R = LABEL_D / 2;
const HOLE = 30;
/** Warm off-white: a printed label, not a UI panel. */
const LABEL = '#F1EFE9';
/** The hole is punched through to the disc, so it is the ground's own black, not a grey. */
const HOLE_INK = GROUND;
const LABEL_INK = '#121212';
const LABEL_DIM = 'rgba(18,18,18,.58)';

/** A line of label type: centred in its box, so a two-line title stacks on the circle's axis. */
const labelLines = (
  value: string, fontSize: number, em: number, color = LABEL_INK, weight = 700,
): Node[] =>
  lines(value).map((line) =>
    text(line, {
      fontSize, fontWeight: weight, letterSpacing: track(fontSize, em),
      lineHeight: 1.18, color, textAlign: 'center',
    }));

function vinyl(
  d: { title: string; sub: string; side: string; rpm: string; note: string; foot: string },
  type: Typefaces,
): Node[] {
  return [
    wordmark(type),
    // The disc the label is stuck to. A hairline, not a fill: the ground is already black.
    el({
      position: 'absolute', left: (CANVAS.w - 1012) / 2, top: LABEL_TOP - 96, width: 1012, height: 1012,
      borderRadius: 506, border: `1px solid ${G3}`, display: 'flex',
    }),
    el(
      {
        position: 'absolute', left: (CANVAS.w - LABEL_D) / 2, top: LABEL_TOP,
        width: LABEL_D, height: LABEL_D, borderRadius: LABEL_R, backgroundColor: LABEL, display: 'flex',
      },
      [
        // Title, above the hole. 620 wide against a 634 chord at y=150.
        column({ position: 'absolute', left: 100, right: 100, top: 150, alignItems: 'center' },
          labelLines(d.title, 44, -0.012)),
        // The label's waist. Mark left of the hole, speed right of it, each set 45px off its edge so the
        // two balance about the centre rather than about the label.
        el({
          position: 'absolute', left: 218, top: 390, width: 132, height: 40,
          border: `1px solid ${LABEL_DIM}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }, [text('NOCT', { fontSize: 17, fontWeight: 600, letterSpacing: track(17, 0.14), color: LABEL_DIM })]),
        el({
          position: 'absolute', left: LABEL_R - HOLE / 2, top: LABEL_R - HOLE / 2,
          width: HOLE, height: HOLE, borderRadius: HOLE / 2, backgroundColor: HOLE_INK, display: 'flex',
        }),
        column({ position: 'absolute', left: 470, top: 382, alignItems: 'flex-start' }, [
          text(d.side, { fontSize: 19, fontWeight: 600, letterSpacing: track(19, 0.1), color: LABEL_DIM }),
          text(d.rpm, { fontSize: 19, fontWeight: 600, letterSpacing: track(19, 0.1), color: LABEL_DIM, marginTop: 6 }),
        ]),
        // Sub, below the hole. The widest part of the circle, so it takes the title's measure.
        ...(d.sub
          ? [column({ position: 'absolute', left: 100, right: 100, top: 476, alignItems: 'center' },
              labelLines(d.sub, 44, -0.012))]
          : []),
        // Small print. 420 wide, against a 464 chord at y=748 where a fourth line would land.
        ...(d.note
          ? [column({ position: 'absolute', left: 200, right: 200, top: 644, alignItems: 'center' },
              labelLines(d.note, 18, 0.04, LABEL_DIM, 500))]
          : []),
      ],
    ),
    swipeFoot(d.foot),
  ];
}

/** One sentence, big. The slide that says something in NOCT's own voice rather than a promoter's. */
function note(d: { text: string; after: string; foot: string }, type: Typefaces): Node[] {
  return [
    wordmark(type),
    centred([
      slab(d.text, 86, -0.045, 1.08),
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
function cta(d: { question: string; answer: string; link: string; note: string }, type: Typefaces): Node[] {
  // Plain on purpose, after review: the body face at ordinary weights, nothing set heavy. The last slide is
  // an invitation, and it should read like one rather than like another headline.
  return [
    wordmark(type),
    centred([
      ...lines(d.question).map((line) =>
        text(line, { fontSize: 62, fontWeight: 500, letterSpacing: track(62, -0.02), lineHeight: 1.12 })),
      ...(d.answer ? [text(d.answer, { fontSize: 46, fontWeight: 400, color: G1, lineHeight: 1.2, marginTop: 24 })] : []),
    ]),
    // One line, lifted off the edge: the link and its instruction read as one thing, and the bottom 54px is
    // where Instagram's own carousel dots and a thumb both sit.
    el({ position: 'absolute', left: SIDE, right: SIDE, bottom: 150, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 14 }, [
      ...(d.link
        ? [
            { type: 'img', props: { src: LINK_ICON, width: 40, height: 40, style: { width: 40, height: 40 } } },
            text(d.link, { fontSize: 46, fontWeight: 500 }),
          ]
        : []),
      ...(d.note ? [text(d.note, { fontSize: 34, color: G2, marginLeft: 12, marginTop: 6 })] : []),
    ]),
  ];
}

/**
 * A slide as one satori tree. The root is the canvas: transparent, because everything behind the type is
 * composited by sharp.
 */
export function slideTree(slide: Slide, type: Typefaces = POST_TYPEFACES): Node {
  const children = ((): Node[] => {
    switch (slide.template) {
      case 'cover': return cover(slide.data, type);
      case 'event': return event(slide.data, type);
      case 'table': return table(slide.data, type);
      case 'listing': return listing(slide.data, type);
      case 'venue': return venue(slide.data, type);
      case 'venuecover': return venueCover(slide.data, type);
      case 'vinyl': return vinyl(slide.data, type);
      case 'note': return note(slide.data, type);
      case 'cta': return cta(slide.data, type);
    }
  })();
  return el(
    {
      width: CANVAS.w, height: CANVAS.h, display: 'flex', position: 'relative',
      fontFamily: type.body, color: WHITE,
    },
    children,
  );
}
