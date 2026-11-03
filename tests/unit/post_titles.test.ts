/**
 * One title scale across every slide that leads with a sentence.
 *
 * The cover set its title at 60, the venues cover at 88 and the note at 86, and each set the line under the
 * title at the title's own size -- five title slides, five designs, and a date that read as loudly as what
 * the post was about. These are the rules that keep that from drifting again.
 */
import { describe, expect, it } from 'vitest';
import { slideTree, titleSize } from '../../src/post/templates.js';
import { slideSchema, treatmentSchema, type Slide } from '../../src/post/types.js';

const s = (o: unknown): Slide => slideSchema.parse(o);

/** The NO/CT lock-up, which is on every slide and is not type anybody sets. */
const WORDMARK = 96;

/** Every font size in a rendered tree except the wordmark's, in document order. */
function sizes(slide: Slide): number[] {
  const out: number[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { props?: { style?: { fontSize?: number }; children?: unknown } };
    const size = n.props?.style?.fontSize;
    if (typeof size === 'number') out.push(size);
    const kids = n.props?.children;
    if (Array.isArray(kids)) kids.forEach(walk);
    else if (kids) walk(kids);
  };
  walk(slideTree(slide));
  return out.filter((n) => n !== WORDMARK);
}

describe('the title scale', () => {
  it('steps down by the longest line, so a long lede cannot run into the foot', () => {
    expect(titleSize('Where to rave')).toBe(86);
    expect(titleSize('Where to rave and dance\nin New York')).toBe(86);
    expect(titleSize('Where to hear ambient')).toBe(86);
    expect(titleSize('Where to hear ambient and drone')).toBe(74);
    expect(titleSize('Where to hear ambient and experimental')).toBe(64);
    expect(titleSize('A weekend is a shortlist, not a listings page.')).toBe(54);
    expect(titleSize('x'.repeat(200))).toBe(46);
  });

  it('sets the same sentence at the same size, whatever slide it leads', () => {
    const line = 'Where to rave and dance\nin New York';
    const cover = sizes(s({ template: 'cover', data: { lede: line, date: 'Nov 6 to 8', foot: 'noct.pro' } }));
    const venues = sizes(s({ template: 'venuecover', data: { lede: line, sub: 'Four rooms', foot: 'noct.pro' } }));
    const note = sizes(s({ template: 'note', data: { text: line, after: 'Four nights.', foot: 'noct.pro' } }));
    const title = titleSize(line);
    for (const set of [cover, venues, note]) expect(set).toContain(title);
  });

  it('keeps the line under a title subordinate to it, on every one of them', () => {
    const line = 'Where to rave';
    const under = 42;
    for (const slide of [
      s({ template: 'cover', data: { lede: line, date: 'Nov 6 to 8', foot: '' } }),
      s({ template: 'venuecover', data: { lede: line, sub: 'Four rooms', foot: '' } }),
      s({ template: 'note', data: { text: line, after: 'Four nights.', foot: '' } }),
    ]) {
      const set = sizes(slide);
      expect(set).toContain(under);
      expect(Math.max(...set.filter((n) => n <= titleSize(line)))).toBe(titleSize(line));
    }
  });

  it('keeps the closing slide lighter than a title, which is the one deliberate exception', () => {
    const cta = sizes(s({ template: 'cta', data: { question: 'sick of checking 10 places?', answer: 'one place' } }));
    expect(Math.max(...cta)).toBeLessThanOrEqual(64);
  });
});

describe('the default look', () => {
  it('is raw: the colour is what the night looked like', () => {
    expect(treatmentSchema.parse(undefined)).toBe('none');
  });
});
