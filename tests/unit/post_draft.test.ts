import { describe, expect, it } from 'vitest';
import {
  candidateNights, CTA_SLIDE, draftWeekend, HERO_MAX, headlineOf, pickHeroes, shareRows, spanLabel, supportingCast,
} from '../../src/post/draft.js';
import { daysToFriday, weekendRange } from '../../src/post/weekend.js';
import { slideSchema, CAROUSEL_MAX, TABLE_ROWS_MAX, type Slide } from '../../src/post/types.js';
import { SITE } from '../../src/post/caption.js';
import type { FeedDay, FeedEvent, FeedResponse } from '../../src/feed/shape.js';

/** Enough of a FeedEvent for the drafting code; the rest of the shape is not read here. */
function ev(over: Partial<FeedEvent> & { id: string }): FeedEvent {
  return {
    n: 1, d: 0, head: 'A night', lineup: [], venue: 'Nowadays', room: null, door: '22:00', close: '',
    genre: ['Techno'], gsrc: 'NOCT tags', primary: 'Techno', genre_codes: [], tags: [], genre_confidence: null,
    vibes: [], scalars: {
      energy: null, darkness: null, crowd_size: null, start_lateness: null, end_lateness: null,
      price_tier: null, underground_index: null,
    },
    sound: '', age: '', interested: 0, srcs: [], platforms: [], ra: '', dice: '', eb: '', url: '',
    tex: 'x1', full: false, soldout: false, note: '', status: 'scheduled', image: '', going_count: 0,
    needs_review: false, is_electronic: true,
    ...over,
  } as FeedEvent;
}

const DAYS: FeedDay[] = [
  { date: '2026-09-18', dow: 5, label: 'Fri', sub: 'Sep 18', hint: 'Friday' },
  { date: '2026-09-19', dow: 6, label: 'Sat', sub: 'Sep 19', hint: 'Saturday' },
  { date: '2026-09-20', dow: 0, label: 'Sun', sub: 'Sep 20', hint: 'Sunday' },
];

function feed(events: FeedEvent[], days = DAYS): FeedResponse {
  return {
    generated_at: '2026-09-15T12:00:00.000Z',
    range: { from: days[0]!.date, to: days[days.length - 1]!.date },
    city: { key: 'nyc', name: 'New York', tz: 'America/New_York' },
    cities: [], days, venues: {}, events, genres: [], sources: [],
  } as FeedResponse;
}

describe('headlineOf', () => {
  it('leads an RA bill with its headliner and folds the rest away', () => {
    const e = ev({
      id: '1',
      head: 'Magnetic ft Artwork, Alex McCracken, Victor Florescu, UMA DJ, Boat Neck, Lee Cash, whydan',
      lineup: ['Artwork', 'Alex McCracken', 'Victor Florescu', 'UMA DJ'],
    });
    expect(headlineOf(e)).toBe('Magnetic ft Artwork');
    expect(supportingCast(e)).toEqual(['Alex McCracken', 'Victor Florescu', 'UMA DJ']);
  });

  it('keeps the promoter’s own word when it says presents', () => {
    expect(headlineOf(ev({ id: '1', head: 'Teksupport presents Four Tet, Ben UFO', lineup: ['Four Tet', 'Ben UFO'] })))
      .toBe('Teksupport presents Four Tet');
  });

  it('leaves a title that is already just a name alone', () => {
    expect(headlineOf(ev({ id: '1', head: 'Mister Sunday', lineup: [] }))).toBe('Mister Sunday');
    expect(headlineOf(ev({ id: '1', head: 'SACRO by MESTIZA', lineup: ['MESTIZA'] }))).toBe('SACRO by MESTIZA');
  });

  it('does not re-glue a bill of one', () => {
    // No comma and no separate lineup: the title was already the whole story.
    expect(headlineOf(ev({ id: '1', head: 'Nowadays with Eris Drew', lineup: [] }))).toBe('Nowadays with Eris Drew');
  });
});

describe('pickHeroes', () => {
  it('ranks by interested, descending', () => {
    const picked = pickHeroes([
      ev({ id: 'a', venue: 'A', interested: 10 }),
      ev({ id: 'b', venue: 'B', interested: 400 }),
      ev({ id: 'c', venue: 'C', interested: 90 }),
    ], 2);
    expect(picked.map((p) => p.id)).toEqual(['b', 'c']);
  });

  it('takes at most one event per venue so one big room cannot own the deck', () => {
    const picked = pickHeroes([
      ev({ id: 'a', venue: 'Avant Gardner', interested: 500 }),
      ev({ id: 'b', venue: 'Avant Gardner', interested: 400 }),
      ev({ id: 'c', venue: 'Nowadays', interested: 300 }),
      ev({ id: 'd', venue: 'BASEMENT', interested: 200 }),
    ], 3);
    expect(picked.map((p) => p.venue)).toEqual(['Avant Gardner', 'Nowadays', 'BASEMENT']);
  });

  it('fills the deck rather than shipping short when every event shares a venue', () => {
    const picked = pickHeroes([
      ev({ id: 'a', venue: 'Nowadays', interested: 3 }),
      ev({ id: 'b', venue: 'Nowadays', interested: 2 }),
    ], 4);
    expect(picked).toHaveLength(2);
    expect(new Set(picked.map((p) => p.id)).size).toBe(2);
  });
});

describe('spanLabel', () => {
  it('shortens a span inside one month', () => {
    expect(spanLabel(DAYS)).toBe('Sep 18 to 20');
  });

  it('keeps both months when the weekend straddles one', () => {
    expect(spanLabel([
      { date: '2026-09-30', dow: 3, label: 'Wed', sub: 'Sep 30', hint: '' },
      { date: '2026-10-02', dow: 5, label: 'Fri', sub: 'Oct 2', hint: '' },
    ])).toBe('Sep 30 to Oct 2');
  });
});

describe('draftWeekend', () => {
  const events = [
    ev({ id: 'a', d: 0, venue: 'Brooklyn Storehouse', head: 'SACRO by MESTIZA', interested: 900, image: 'https://images.ra.co/x.png' }),
    ev({ id: 'b', d: 0, venue: 'Knockdown Center', head: 'Teksupport presents Four Tet', lineup: ['Four Tet'], interested: 800 }),
    ev({ id: 'c', d: 1, venue: 'BASEMENT', head: 'DAY+NIGHT', interested: 700 }),
    ev({ id: 'd', d: 2, venue: 'Nowadays', head: 'Mister Sunday', interested: 600 }),
    ...Array.from({ length: 12 }, (_, i) =>
      ev({ id: `x${i}`, d: i % 3, venue: `Venue ${i}`, head: `Night ${i}`, interested: 10 - i })),
  ];
  const deck = draftWeekend(feed(events))!;

  it('builds a cover, event slides and table slides, in that order', () => {
    expect(deck).not.toBeNull();
    expect(deck.slides[0]!.template).toBe('cover');
    const kinds = deck.slides.map((s) => s.template);
    expect(kinds.filter((k) => k === 'event')).toHaveLength(4);
    expect(kinds.lastIndexOf('event')).toBeLessThan(kinds.indexOf('table'));
  });

  it('never exceeds a carousel', () => {
    expect(deck.slides.length).toBeLessThanOrEqual(CAROUSEL_MAX);
  });

  it('keeps every table slide within the legible row count', () => {
    for (const slide of deck.slides) {
      if (slide.template === 'table') expect(slide.data.rows.length).toBeLessThanOrEqual(TABLE_ROWS_MAX);
    }
  });

  it('does not repeat a hero event in the tables', () => {
    const heroes = deck.slides.flatMap((s) => (s.template === 'event' ? [s.data.name] : []));
    const rows = deck.slides.flatMap((s) => (s.template === 'table' ? s.data.rows.map((r) => r.event) : []));
    for (const hero of heroes) expect(rows).not.toContain(hero);
  });

  it('carries the flyer through when the event has one, and the tone when it does not', () => {
    const withFlyer = deck.slides.find((s) => s.template === 'event' && s.data.name === 'SACRO by MESTIZA');
    expect(withFlyer).toMatchObject({ data: { image: { src: 'https://images.ra.co/x.png', fit: 'cover' } } });
    const without = deck.slides.find((s) => s.template === 'event' && s.data.name.startsWith('Teksupport'));
    expect(without).toMatchObject({ data: { image: null } });
  });

  it('keeps volatile numbers off the post face', () => {
    // Interested counts rank the deck but must never be printed: they go stale between drafting and posting.
    const text = JSON.stringify(deck.slides);
    expect(text).not.toContain('900');
    expect(text).not.toContain('interested');
  });

  it('produces slides that validate against the render schema', () => {
    for (const slide of deck.slides) expect(() => slideSchema.parse(slide)).not.toThrow();
  });

  it('slots the post on the Friday', () => {
    expect(deck.slot).toBe('2026-09-18');
  });

  it('sends people to the live site, from one constant, on the cover and in the caption', () => {
    // This used to be a literal 'noct.nyc' in two files -- a domain that does not resolve. Every post would
    // have pointed followers at nothing, or at whoever registers it later.
    const cover = deck.slides[0]!;
    expect(cover).toMatchObject({ template: 'cover', data: { foot: SITE } });
    expect(deck.caption).toContain(SITE);
    expect(JSON.stringify(deck)).not.toContain('noct.nyc');
  });

  it('breaks the cover lede so "in New York" stays on one line', () => {
    // Left to the wrapper it read "...dance in / New York".
    expect(deck.slides[0]).toMatchObject({ template: 'cover', data: { lede: 'Where to rave and dance\nin New York' } });
  });

  it('always closes with the call to action, pointing at the live site', () => {
    const last = deck.slides[deck.slides.length - 1]!;
    expect(last).toEqual(CTA_SLIDE);
    expect(last).toMatchObject({
      template: 'cta',
      data: { question: 'sick of checking 10 places for one night out?', answer: 'NYC nightlife, all in one place', link: SITE, note: 'link in bio' },
    });
    // Exactly once, and never trimmed off by a long weekend: it is added after the carousel cap is applied.
    expect(deck.slides.filter((s) => s.template === 'cta')).toHaveLength(1);
  });

  it('returns null rather than an empty deck when the feed has nothing', () => {
    expect(draftWeekend(feed([]))).toBeNull();
  });

  it('names the feed event behind each event slide', () => {
    const refs = deck.slides.flatMap((sl) => (sl.template === 'event' ? [sl.data.ref] : []));
    expect(refs).toEqual(['a', 'b', 'c', 'd']);
  });

  describe('with nights chosen in the studio', () => {
    const chosen = draftWeekend(feed(events), { heroIds: ['x5', 'c', 'gone'] })!;
    const heroRefs = chosen.slides.flatMap((sl) => (sl.template === 'event' ? [sl.data.ref] : []));

    it('uses those nights, in the order chosen, skipping any the feed no longer has', () => {
      expect(heroRefs).toEqual(['x5', 'c']);
    });

    it('lists the nights that were not chosen in the tables, including the top-ranked ones', () => {
      const rows = chosen.slides.flatMap((sl) => (sl.template === 'table' ? sl.data.rows.map((r) => r.event) : []));
      expect(rows).toContain('SACRO by MESTIZA');
      expect(rows).not.toContain('Night 5');
    });

    it('never picks more than a deck has room for', () => {
      const many = draftWeekend(feed(events), { heroIds: events.map((e) => e.id) })!;
      expect(many.slides.filter((sl) => sl.template === 'event')).toHaveLength(HERO_MAX);
      expect(many.slides.length).toBeLessThanOrEqual(CAROUSEL_MAX);
      expect(many.slides[many.slides.length - 1]).toEqual(CTA_SLIDE);
    });
  });

  it('closes with the words the studio has, when it is given them', () => {
    const mine = slideSchema.parse({ template: 'cta', data: { question: 'tired of ten tabs?', answer: 'one place', link: SITE, note: 'link in bio' } }) as Slide;
    const deck = draftWeekend(feed(events), { cta: mine })!;
    expect(deck.slides[deck.slides.length - 1]).toEqual(mine);
    expect(deck.slides.filter((sl) => sl.template === 'cta')).toHaveLength(1);
  });

  describe('the tables', () => {
    // New York's Friday alone lists a hundred events, so the weekend the drafter sees is lopsided.
    const lopsided = [
      ...Array.from({ length: 40 }, (_, i) => ev({ id: `f${i}`, d: 0, venue: `Friday venue ${i}`, head: `Friday night ${i}`, interested: 500 - i })),
      ...Array.from({ length: 9 }, (_, i) => ev({ id: `s${i}`, d: 1, venue: `Saturday venue ${i}`, head: `Saturday night ${i}`, interested: 400 - i })),
      ...Array.from({ length: 3 }, (_, i) => ev({ id: `u${i}`, d: 2, venue: `Sunday venue ${i}`, head: `Sunday night ${i}`, interested: 300 - i })),
    ];
    const rowsOf = (deck: ReturnType<typeof draftWeekend>) =>
      deck!.slides.flatMap((sl) => (sl.template === 'table' ? sl.data.rows : []));

    it('gives every night of the weekend a share, rather than filling up on Friday', () => {
      const rows = rowsOf(draftWeekend(feed(lopsided)));
      const nights = new Set(rows.map((r) => r.day));
      expect(nights).toEqual(new Set(['Fri', 'Sat', 'Sun']));
      expect(rows).toHaveLength(14);
    });

    it('hands a quiet night’s unused rows back to the busy ones, so the tables are never short', () => {
      // Sunday has three listings; the fourteen rows are still filled.
      const rows = rowsOf(draftWeekend(feed(lopsided)));
      expect(rows.filter((r) => r.day === 'Sun')).toHaveLength(3);
      expect(rows.filter((r) => r.day === 'Fri').length).toBeGreaterThan(3);
    });

    it('still reads as a diary: each night’s rows together, in night order', () => {
      const days = rowsOf(draftWeekend(feed(lopsided))).map((r) => r.day);
      expect(days).toEqual([...days].sort((a, b) => ['Fri', 'Sat', 'Sun'].indexOf(a) - ['Fri', 'Sat', 'Sun'].indexOf(b)));
    });

    it('shares the rows out a row at a time, and never more than a night has', () => {
      expect(shareRows([40, 9, 3], 14)).toEqual([6, 5, 3]);
      expect(shareRows([100, 100, 100], 14)).toEqual([5, 5, 4]);
      expect(shareRows([2, 1, 0], 14)).toEqual([2, 1, 0]);
      expect(shareRows([], 14)).toEqual([]);
    });

    it('lists exactly the nights the studio chose, when it chooses', () => {
      const deck = draftWeekend(feed(lopsided), { heroIds: ['f0'], rowIds: ['u1', 's2', 'f9'] })!;
      const rows = deck.slides.flatMap((sl) => (sl.template === 'table' ? sl.data.rows : []));
      expect(rows.map((r) => r.event)).toEqual(['Friday night 9', 'Saturday night 2', 'Sunday night 1']);
    });

    it('never lists a night that already has its own slide', () => {
      const deck = draftWeekend(feed(lopsided), { heroIds: ['f0'], rowIds: ['f0', 'f1'] })!;
      const rows = deck.slides.flatMap((sl) => (sl.template === 'table' ? sl.data.rows : []));
      expect(rows.map((r) => r.event)).toEqual(['Friday night 1']);
    });
  });

  it('offers every night as a candidate, best first', () => {
    const offered = candidateNights(events, 5).map((e) => e.id);
    expect(offered).toEqual(['a', 'b', 'c', 'd', 'x0']);
  });
});

describe('weekendRange', () => {
  it('counts forward to Friday from Monday through Thursday', () => {
    expect(daysToFriday(1)).toBe(4);
    expect(daysToFriday(4)).toBe(1);
  });

  it('means the weekend already happening on a Friday or Saturday', () => {
    expect(daysToFriday(5)).toBe(0);
    expect(daysToFriday(6)).toBe(-1);
  });

  it('looks to the next weekend on a Sunday, because this one is ending', () => {
    expect(daysToFriday(0)).toBe(5);
  });

  it('returns a Friday-to-Sunday window', () => {
    // A Tuesday in New York.
    const { from, to } = weekendRange(new Date('2026-09-15T16:00:00Z'));
    expect(from).toBe('2026-09-18');
    expect(to).toBe('2026-09-20');
  });
});
