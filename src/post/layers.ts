/**
 * Everything on a slide that is not type: the placeholder tones, the veil over a photo, and the grain.
 *
 * These exist as CSS in app.css (`.x1`..`.x6`) and in the review prototype, and as SVG here, because satori
 * composes the type and sharp composites the rest -- neither draws CSS. The translation is mechanical and
 * unit-tested (tests/unit/post_layers.test.ts) rather than eyeballed, so a tone that drifts from the app is
 * a failing test and not something noticed in a published post.
 *
 * The app authors the tones at its 440px canvas; the prototype scaled every pattern dimension by 2.45 for
 * the 1080 post. The scaled numbers are what is written out below, so there is one place to read them.
 */
import { CANVAS, type Tone } from './types.js';

const { w: W, h: H } = CANVAS;

/** A gradient colour stop: offset 0..1 along the gradient line. */
interface Stop {
  at: number;
  color: string;
  opacity?: number;
}

function stopsXml(stops: Stop[]): string {
  return stops
    .map((s) => `<stop offset="${round(s.at)}" stop-color="${s.color}"${s.opacity === undefined ? '' : ` stop-opacity="${round(s.opacity)}"`}/>`)
    .join('');
}

const round = (n: number): string => String(Math.round(n * 1e4) / 1e4);
const rad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * A CSS `linear-gradient(<angle>, ...)` as an SVG gradient over the canvas.
 *
 * CSS measures the angle from "to top", clockwise, so the direction in a y-down box is (sin a, -cos a).
 * The gradient line is centred on the box and long enough to reach the corners: |w sin a| + |h cos a|.
 */
export function linearGradient(id: string, angleDeg: number, stops: Stop[], w: number = W, h: number = H): string {
  const a = rad(angleDeg);
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const len = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
  const [cx, cy] = [w / 2, h / 2];
  const [x1, y1] = [cx - (dx * len) / 2, cy - (dy * len) / 2];
  const [x2, y2] = [cx + (dx * len) / 2, cy + (dy * len) / 2];
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}">${stopsXml(stops)}</linearGradient>`;
}

/**
 * A CSS `radial-gradient(<rx> <ry> at <x> <y>, ...)`. SVG radial gradients are circular, so the ellipse is
 * a circle of radius rx scaled about its own centre -- which is what a gradientTransform is for.
 */
function radialGradient(
  id: string, rxPct: number, ryPct: number, atXPct: number, atYPct: number, stops: Stop[],
): string {
  const [cx, cy] = [(atXPct / 100) * W, (atYPct / 100) * H];
  const [rx, ry] = [(rxPct / 100) * W, (ryPct / 100) * H];
  const t = `translate(${round(cx)} ${round(cy)}) scale(1 ${round(ry / rx)}) translate(${round(-cx)} ${round(-cy)})`;
  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${round(cx)}" cy="${round(cy)}" r="${round(rx)}" gradientTransform="${t}">${stopsXml(stops)}</radialGradient>`;
}

/** One band of a repeating stripe pattern, in pattern-local pixels along the gradient direction. */
interface Band {
  from: number;
  to: number;
  color: string;
  opacity?: number;
}

/**
 * A CSS `repeating-linear-gradient(<angle>, ...)` with hard colour stops, as an SVG `<pattern>`.
 *
 * The bands run along the gradient direction, so the pattern is drawn as vertical bars and rotated until
 * its local +x points that way: a rotation by A maps (1,0) to (cos A, sin A), and the direction we want is
 * (sin angle, -cos angle), so A = angle - 90. The tile is made tall enough that a rotated tile still covers
 * the canvas corners.
 */
function stripePattern(id: string, angleDeg: number, period: number, bands: Band[]): string {
  const span = Math.ceil(Math.hypot(W, H));
  const rects = bands
    .map((b) => `<rect x="${round(b.from)}" y="${-span}" width="${round(b.to - b.from)}" height="${span * 2}" fill="${b.color}"${b.opacity === undefined ? '' : ` fill-opacity="${round(b.opacity)}"`}/>`)
    .join('');
  return `<pattern id="${id}" width="${round(period)}" height="${span * 2}" patternUnits="userSpaceOnUse" patternTransform="rotate(${round(angleDeg - 90)} ${W / 2} ${H / 2})">${rects}</pattern>`;
}

/** A tiled dot grid: CSS `radial-gradient(circle, c solid, transparent edge)` at `background-size`. */
function dotPattern(id: string, tile: number, solid: number, edge: number, color: string): string {
  const c = tile / 2;
  return (
    `<radialGradient id="${id}-d" gradientUnits="userSpaceOnUse" cx="${c}" cy="${c}" r="${edge}">` +
    `<stop offset="${round(solid / edge)}" stop-color="${color}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/>` +
    `</radialGradient>` +
    `<pattern id="${id}" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse">` +
    `<circle cx="${c}" cy="${c}" r="${edge}" fill="url(#${id}-d)"/></pattern>`
  );
}

const svg = (defs: string, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${body}</svg>`;

const fill = (ref: string): string => `<rect width="${W}" height="${H}" fill="${ref}"/>`;

/**
 * The six tones, scaled 2.45x from app.css.
 *
 * CSS paints background layers with the FIRST listed on top, so each tone is written here bottom-up: base
 * colour, then the later layers, then the first. Where the top layer is opaque it hides what is under it --
 * `.x4` is like that in app.css today, and it is reproduced rather than corrected, because a post that does
 * not match the app it advertises is the worse bug.
 */
export const TONE_SVG: Record<Tone, () => string> = {
  x1: () =>
    svg(
      linearGradient('g', 180, [{ at: 0, color: '#000000' }, { at: 1, color: '#141414' }]) +
        stripePattern('p', 90, 34, [
          { from: 0, to: 12, color: '#070707' }, { from: 12, to: 22, color: '#242424' },
          { from: 22, to: 25, color: '#949494' }, { from: 25, to: 34, color: '#3B3B3B' },
        ]),
      fill('url(#g)') + fill('url(#p)'),
    ),

  x2: () => svg(dotPattern('p', 22, 2.5, 3.2, '#7E7E7E'), fill('#0E0E0E') + fill('url(#p)')),

  x3: () =>
    svg(
      stripePattern('p', 0, 15, [{ from: 0, to: 2.5, color: '#FFFFFF', opacity: 0.06 }]) +
        radialGradient('g', 115, 62, 75, 17, [
          { at: 0, color: '#FFFFFF', opacity: 0.36 }, { at: 0.58, color: '#FFFFFF', opacity: 0 },
        ]),
      fill('#0C0C0C') + fill('url(#p)') + fill('url(#g)'),
    ),

  x4: () =>
    svg(
      stripePattern('q', 108, 54, [{ from: 0, to: 27, color: '#FFFFFF', opacity: 0.075 }]) +
        stripePattern('p', 72, 54, [
          { from: 0, to: 27, color: '#0A0A0A' }, { from: 27, to: 54, color: '#1F1F1F' },
        ]),
      fill('#0B0B0B') + fill('url(#q)') + fill('url(#p)'),
    ),

  x5: () =>
    svg(
      linearGradient('g', 200, [{ at: 0, color: '#1A1A1A' }, { at: 1, color: '#050505' }]) +
        radialGradient('r', 60, 40, 31, 61, [
          { at: 0, color: '#FFFFFF', opacity: 0.44 }, { at: 0.42, color: '#FFFFFF', opacity: 0.07 },
          { at: 0.71, color: '#FFFFFF', opacity: 0 },
        ]),
      fill('url(#g)') + fill('url(#r)'),
    ),

  x6: () =>
    svg(
      linearGradient('g', 160, [{ at: 0, color: '#1D1D1D' }, { at: 1, color: '#060606' }]) +
        stripePattern('p', 90, 39, [{ from: 5, to: 7, color: '#FFFFFF', opacity: 0.17 }]),
      fill('url(#g)') + fill('url(#p)'),
    ),
};

export function toneSvg(tone: Tone): Buffer {
  return Buffer.from(TONE_SVG[tone]());
}

/**
 * The veil over a photo on an event slide. Dark at the top so the wordmark holds, almost clear through the
 * upper middle so the flyer is actually visible, then near-solid at the foot where the type sits.
 */
export function veilSvg(): Buffer {
  return Buffer.from(
    svg(
      // Strengthened after review. The old ramp only reached .94 at the very bottom, so a billing sitting at
      // 60-85% of the height lay on a barely-darkened flyer and was unreadable over its artwork. The flyer
      // now stays clear through the upper middle and the band the type occupies is near-solid.
      linearGradient('v', 180, [
        { at: 0, color: '#0B0B0B', opacity: 0.66 }, { at: 0.18, color: '#0B0B0B', opacity: 0.08 },
        { at: 0.4, color: '#0B0B0B', opacity: 0.12 }, { at: 0.58, color: '#0B0B0B', opacity: 0.66 },
        { at: 0.74, color: '#0B0B0B', opacity: 0.9 }, { at: 1, color: '#0B0B0B', opacity: 0.96 },
      ]),
      fill('url(#v)'),
    ),
  );
}

/** Film grain, composited with an overlay blend the way `mix-blend-mode: overlay` does on the page. */
export function grainSvg(): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch"/></filter>` +
      `<rect width="${W}" height="${H}" filter="url(#n)" opacity="0.5"/></svg>`,
  );
}

/** The ground, for a slide with neither photo nor tone and as the letterbox behind a contained flyer. */
export const GROUND = '#0B0B0B';
