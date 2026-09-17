/**
 * Caption drafting, and the house rules a caption has to survive.
 *
 * The rules are not stylistic preferences to be weighed; they are corrections already given, and the point
 * of encoding them is that they stop being given again:
 *
 *   - At most five hashtags, the ones closest to the specific event. A wall of tags is someone else's feed.
 *   - No em dashes, anywhere.
 *   - No middle dot as a separator. Slashes or hyphens.
 *   - No "it's A, not B" construction.
 *   - Volatile numbers stay off the post face. Interested counts and ticket prices go stale between
 *     drafting and posting, so they belong in the caption if anywhere -- it is reviewed and edited in the
 *     minute before publishing, and a slide is baked into a JPEG hours earlier.
 *
 * checkCaption() reports rather than rewrites. The studio shows what it says next to the field and lets her
 * decide: silently editing her words would be the worse behaviour, and she is the one who signs the post.
 */
import { CAPTION_MAX, HASHTAG_MAX } from './types.js';

/**
 * Where a post sends people. One constant, because it printed on every cover and in every caption, and it
 * used to be a literal in each: `noct.nyc`, a domain that does not resolve. Scattered, nobody checked it; the
 * live site is noct.pro. If the domain changes, this is the only line to edit, and post_draft.test.ts fails
 * if a slide or caption stops using it.
 */
export const SITE = 'noct.pro';

const HASHTAG = /#[^\s#]+/g;

export function hashtagsIn(caption: string): string[] {
  return caption.match(HASHTAG) ?? [];
}

export type CaptionProblem =
  | { rule: 'length'; message: string; count: number; limit: number }
  | { rule: 'hashtags'; message: string; count: number; limit: number }
  | { rule: 'em-dash'; message: string; at: number }
  | { rule: 'middle-dot'; message: string; at: number }
  | { rule: 'not-b'; message: string; at: number };

/**
 * Everything wrong with a caption, in the order it appears. An empty array means it is ready to post as
 * far as the house rules are concerned.
 */
export function checkCaption(caption: string): CaptionProblem[] {
  const out: CaptionProblem[] = [];

  if (caption.length > CAPTION_MAX) {
    out.push({
      rule: 'length', count: caption.length, limit: CAPTION_MAX,
      message: `Caption is ${caption.length} characters, ${caption.length - CAPTION_MAX} over Instagram's limit.`,
    });
  }

  const tags = hashtagsIn(caption);
  if (tags.length > HASHTAG_MAX) {
    out.push({
      rule: 'hashtags', count: tags.length, limit: HASHTAG_MAX,
      message: `${tags.length} hashtags. Keep the ${HASHTAG_MAX} closest to the event and drop the rest.`,
    });
  }

  const dash = caption.search(/[—–]/);
  if (dash >= 0) out.push({ rule: 'em-dash', at: dash, message: 'Em dash. Use a comma, a full stop or a slash.' });

  const dot = caption.indexOf('·');
  if (dot >= 0) out.push({ rule: 'middle-dot', at: dot, message: 'Middle dot separator. Use a slash or a hyphen.' });

  // "it's techno, not house", contracted or not. Both apostrophes: macOS substitutes a curly one as you
  // type, so a rule that only knows the straight ' misses almost every caption written on a Mac.
  // Deliberately narrow otherwise: it matches the construction that was flagged, not every use of "not".
  const notB = /\b(?:it['’]?s|it is|this is|these are|that['’]?s|that is)\b[^.!?\n]{1,80}?,\s*not\b/i.exec(caption);
  if (notB) out.push({ rule: 'not-b', at: notB.index, message: '"A, not B" construction. Say what it is and stop.' });

  return out;
}

/** Strip the constructions that are never wanted. Used on text NOCT generates, never on text she typed. */
export function scrubCopy(value: string): string {
  return value
    .replace(/\s*—\s*/g, ', ')
    // An en dash is "to" only between numbers (22:00 – 04:00). Elsewhere it is a separator, and turning
    // "Location TBA – New York" into "Location TBA to New York" says something the listing never did.
    .replace(/(\d)\s*–\s*(\d)/g, '$1 to $2')
    .replace(/\s*–\s*/g, ' / ')
    .replace(/\s*·\s*/g, ' / ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Hashtags for a weekend deck.
 *
 * Genre tags come from the events actually in the deck, so a weekend of hard techno and a weekend of disco
 * do not get the same five. The two fixed tags carry the city; the rest of the budget goes to whatever the
 * nights were, most common first.
 */
export function draftHashtags(genres: string[], limit = HASHTAG_MAX): string[] {
  const fixed = ['#nycnightlife', '#brooklynnightlife'];
  const counts = new Map<string, number>();
  for (const g of genres) {
    const tag = `#${g.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
    // Two characters or more after the hash. A label that punctuation reduced to nothing, or to one
    // letter, makes a hashtag nobody searches for and spends one of only five slots.
    if (tag.length > 2) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag)
    .filter((t) => !fixed.includes(t));
  return [...fixed, ...ranked].slice(0, limit);
}

export interface CaptionSeed {
  /** "Sep 18 to 20", already formatted by the caller that knows the dates. */
  when: string;
  /** Headliner-first names, in deck order. */
  headlines: string[];
  genres: string[];
  /** What the post is, before the dates. Defaults to the weekend deck's own line. */
  lead?: string;
}

/**
 * The first draft of a weekend caption. It is a starting point to edit, not a finished caption: the studio
 * opens it in an editable field for exactly that reason.
 */
export function draftWeekendCaption(seed: CaptionSeed): string {
  const list = seed.headlines.slice(0, 6).map((h) => `- ${scrubCopy(h)}`).join('\n');
  const tags = draftHashtags(seed.genres).join(' ');
  return scrubLines(
    [
      `${seed.lead ?? 'Where to rave and dance in New York'}, ${seed.when}.`,
      '',
      list,
      '',
      `Full listings and tickets at ${SITE}`,
      '',
      tags,
    ].join('\n'),
  );
}

/** scrubCopy trims, which would eat the blank lines a caption uses for paragraphing. Scrub line by line. */
export function scrubLines(value: string): string {
  return value.split('\n').map(scrubCopy).join('\n');
}
