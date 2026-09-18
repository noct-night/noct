import { describe, expect, it } from 'vitest';
import {
  checkCaption, draftHashtags, draftWeekendCaption, hashtagsIn, HOUSE_LINES, scrubCopy, scrubLines,
  withHouseLines,
} from '../../src/post/caption.js';
import { HASHTAG_MAX } from '../../src/post/types.js';

describe('house copy rules', () => {
  it('passes a caption that follows them', () => {
    const ok = 'Where to rave and dance in New York, Sep 18 to 20.\n\n#nycnightlife #techno';
    expect(checkCaption(ok)).toEqual([]);
  });

  it('counts hashtags and complains past five', () => {
    expect(hashtagsIn('#a #b and #c')).toEqual(['#a', '#b', '#c']);
    const six = checkCaption('#a #b #c #d #e #f');
    expect(six.map((p) => p.rule)).toContain('hashtags');
    expect(six[0]).toMatchObject({ count: 6, limit: HASHTAG_MAX });
  });

  it('catches em dashes and en dashes', () => {
    expect(checkCaption('Four Tet — all night').map((p) => p.rule)).toContain('em-dash');
    expect(checkCaption('22:00 – 04:00').map((p) => p.rule)).toContain('em-dash');
  });

  it('catches the middle dot separator', () => {
    expect(checkCaption('Nowadays · Ridgewood').map((p) => p.rule)).toContain('middle-dot');
  });

  it('catches the "A, not B" construction without flagging every use of "not"', () => {
    expect(checkCaption('It is techno, not house.').map((p) => p.rule)).toContain('not-b');
    expect(checkCaption("That's a warehouse, not a club.").map((p) => p.rule)).toContain('not-b');
    // macOS substitutes a curly apostrophe as you type, so almost every real caption has this one.
    expect(checkCaption('It’s a guide, not a ranking.').map((p) => p.rule)).toContain('not-b');
    expect(checkCaption('That’s techno, not house.').map((p) => p.rule)).toContain('not-b');
    // "not" doing ordinary work in a sentence is not the construction.
    expect(checkCaption('Tickets are not on sale yet.').map((p) => p.rule)).not.toContain('not-b');
    expect(checkCaption('Do not miss this one.').map((p) => p.rule)).not.toContain('not-b');
  });

  it('flags a caption over Instagram’s limit with the overage', () => {
    const problems = checkCaption('x'.repeat(2300));
    expect(problems[0]).toMatchObject({ rule: 'length', count: 2300, limit: 2200 });
  });
});

describe('scrubCopy', () => {
  it('replaces the constructions rather than leaving them for review', () => {
    expect(scrubCopy('Four Tet — all night')).toBe('Four Tet, all night');
    expect(scrubCopy('22:00 – 04:00')).toBe('22:00 to 04:00');
    expect(scrubCopy('Nowadays · Ridgewood')).toBe('Nowadays / Ridgewood');
  });

  it('keeps the blank lines that paragraph a caption', () => {
    expect(scrubLines('one\n\ntwo')).toBe('one\n\ntwo');
    // scrubCopy alone would trim the whole string and lose the leading structure.
    expect(scrubLines('  a  b  \n\n  c  ')).toBe('a b\n\nc');
  });
});

describe('draftHashtags', () => {
  it('leads with the city tags and fills from the genres actually in the deck', () => {
    const tags = draftHashtags(['Techno', 'Techno', 'Disco']);
    expect(tags[0]).toBe('#nycnightlife');
    expect(tags).toContain('#techno');
    // Techno appears twice, so it outranks disco.
    expect(tags.indexOf('#techno')).toBeLessThan(tags.indexOf('#disco'));
  });

  it('never returns more than the house maximum', () => {
    const many = ['Techno', 'House', 'Disco', 'Ambient', 'Jungle', 'Dubstep', 'Trance', 'Garage'];
    expect(draftHashtags(many)).toHaveLength(HASHTAG_MAX);
  });

  it('drops punctuation and spaces from a genre label', () => {
    expect(draftHashtags(['Hard techno'])).toContain('#hardtechno');
    expect(draftHashtags(['Hip Hop / R&B'])).toContain('#hiphoprb');
  });

  it('skips a label that punctuation reduces to nothing worth searching', () => {
    // '&' becomes '#', and a one-letter tag would spend one of only five slots for nothing.
    expect(draftHashtags(['&', 'x'])).toEqual(['#nycnightlife', '#brooklynnightlife']);
  });
});

describe('draftWeekendCaption', () => {
  const caption = draftWeekendCaption({
    when: 'Sep 18 to 20',
    headlines: ['SACRO by MESTIZA, Brooklyn Storehouse', 'Mister Sunday, Nowadays'],
    genres: ['Techno', 'Disco'],
  });

  it('produces a caption that already passes the house rules', () => {
    expect(checkCaption(caption)).toEqual([]);
  });

  it('names the weekend and the events', () => {
    expect(caption).toContain('Sep 18 to 20');
    expect(caption).toContain('SACRO by MESTIZA');
  });
});

/**
 * The two lines every caption carries.
 *
 * Instagram will not make a URL in a caption tappable, so "link in bio" is the only call to action a caption
 * has, and asking for the follow is the only way a post earns the next one.
 */
describe('the house lines', () => {
  const body = 'Nowadays, Ridgewood, Queens.\n\nOutdoor and late.\n\n#nycnightlife #deephouse';

  it('opens with the invitation and signs off above the hashtags', () => {
    const out = withHouseLines(body);
    expect(out.split('\n')[0]).toBe(HOUSE_LINES.opening);
    expect(out.trimEnd().endsWith('#nycnightlife #deephouse')).toBe(true);
    expect(out.indexOf(HOUSE_LINES.signoff)).toBeLessThan(out.indexOf('#nycnightlife'));
    expect(out).toContain('Outdoor and late.');
  });

  it('signs off at the end when a caption has no hashtags', () => {
    expect(withHouseLines('Nowadays.').trimEnd().endsWith(HOUSE_LINES.signoff)).toBe(true);
  });

  it('takes the wording it is given, and leaves out a line that is empty', () => {
    const mine = { opening: 'follow noct', signoff: '' };
    const out = withHouseLines(body, mine);
    expect(out.split('\n')[0]).toBe('follow noct');
    expect(out).not.toContain(HOUSE_LINES.signoff);
    expect(out.trimEnd().endsWith('#nycnightlife #deephouse')).toBe(true);
  });

  it('never leaves a run of blank lines behind', () => {
    expect(withHouseLines(body)).not.toMatch(/\n{3}/);
  });

  it('still passes the caption rules', () => {
    expect(checkCaption(withHouseLines(body))).toEqual([]);
  });

  it('keeps the emoji NOCT actually uses, which the slides cannot draw but a caption can', () => {
    expect(HOUSE_LINES.opening).toContain('\u{1F989}');
    expect(HOUSE_LINES.signoff).toContain('\u{1F517}');
  });
});
