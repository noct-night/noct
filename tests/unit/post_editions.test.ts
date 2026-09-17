import { describe, expect, it } from 'vitest';
import type { FeedDay, FeedEvent, FeedResponse } from '../../src/feed/shape.js';
import { scrubCopy } from '../../src/post/caption.js';
import { CTA_SLIDE, isNightOut, namesNotIn, pickHeroes } from '../../src/post/draft.js';
import {
  draftGenreEditions, draftSpotlights, draftVenuePosts, EDITION_MIN_EVENTS, familyOf, FAMILY_PHRASE, venueVibe,
} from '../../src/post/editions.js';
import { CAROUSEL_MAX, slideSchema } from '../../src/post/types.js';

function ev(over: Partial<FeedEvent> & { id: string }): FeedEvent {
  return {
    n: 1, d: 0, head: 'A night', lineup: [], venue: 'Nowadays', room: null, door: '22:00', close: '',
    genre: ['Techno'], gsrc: 'NOCT tags', primary: 'Peak-Time Techno', genre_codes: ['techno.peak'], tags: [],
    genre_confidence: null, vibes: [], scalars: {
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

const feed = (events: FeedEvent[]): FeedResponse => ({
  generated_at: '2026-09-15T12:00:00.000Z', range: { from: '2026-09-18', to: '2026-09-20' },
  city: { key: 'nyc', name: 'New York', tz: 'America/New_York' }, cities: [], days: DAYS, venues: {}, events,
  genres: [], sources: [],
} as FeedResponse);

/** n events of one sub-genre, each at its own venue so hero picking has room. */
const many = (n: number, primary: string, code: string, prefix: string): FeedEvent[] =>
  Array.from({ length: n }, (_, i) => ev({
    id: `${prefix}${i}`, d: i % 3, head: `${prefix} night ${i}`, venue: `${prefix} venue ${i}`,
    primary, genre_codes: [code], interested: 100 - i,
  }));

describe('familyOf', () => {
  it('groups sub-genres into their family, so house is one edition and not four thin ones', () => {
    expect(familyOf({ primary: 'Deep House', genre_codes: [] })).toBe('house');
    expect(familyOf({ primary: 'Afro House', genre_codes: [] })).toBe('house');
    expect(familyOf({ primary: 'Peak-Time Techno', genre_codes: [] })).toBe('techno');
  });

  it('falls back to the first genre code when the event has not been enriched', () => {
    expect(familyOf({ primary: null, genre_codes: ['disco.disco'] })).toBe('disco');
    expect(familyOf({ primary: null, genre_codes: [] })).toBeNull();
  });
});

describe('draftGenreEditions', () => {
  const events = [
    ...many(12, 'Deep House', 'house.deep', 'h'),
    ...many(8, 'Peak-Time Techno', 'techno.peak', 't'),
    ...many(7, 'Disco / Funk / Boogie', 'disco.disco', 'd'),
    ...many(6, 'Reggaeton', 'latin.reggaeton', 'l'),
    ...many(EDITION_MIN_EVENTS - 1, 'Hardcore', 'hard.hardcore', 'x'),
    ...many(20, 'Open Format / Eclectic', 'open.eclectic', 'o'),
  ];
  const editions = draftGenreEditions(feed(events));

  it('picks the three families with the most nights', () => {
    expect(editions.map((e) => e.edition)).toEqual(['house', 'techno', 'disco']);
  });

  it('skips families too thin for an edition, and open format, which is not a genre', () => {
    const all = draftGenreEditions(feed(events), 10).map((e) => e.edition);
    expect(all).toContain('latin');
    expect(all).not.toContain('hard');
    expect(all).not.toContain('open');
    expect(FAMILY_PHRASE.open).toBeUndefined();
  });

  it('keeps each edition to its own genre', () => {
    const house = editions[0]!;
    const named = JSON.stringify(house.slides);
    expect(named).toContain('h night');
    expect(named).not.toContain('t night');
  });

  it('says what the edition is on the cover and in the caption', () => {
    expect(editions[0]!.slides[0]).toMatchObject({ template: 'cover', data: { lede: 'Where to hear house\nin New York' } });
    expect(editions[1]!.caption.startsWith('Where to hear techno in New York, Sep 18 to 20.')).toBe(true);
  });

  it('files each edition under its own genre, so they cannot overwrite each other', () => {
    for (const e of editions) {
      expect(e.series).toBe('genre');
      expect(e.slot).toBe('2026-09-18');
    }
    expect(new Set(editions.map((e) => e.edition)).size).toBe(editions.length);
  });

  it('builds valid carousels that close with the CTA', () => {
    for (const e of editions) {
      expect(e.slides.length).toBeLessThanOrEqual(CAROUSEL_MAX);
      expect(e.slides[e.slides.length - 1]).toEqual(CTA_SLIDE);
      for (const s of e.slides) expect(() => slideSchema.parse(s)).not.toThrow();
    }
  });
});

describe('draftSpotlights', () => {
  const events = [
    ev({ id: 'big', d: 1, head: 'MERGE 5 Year Anniversary', venue: 'Brooklyn Storehouse', interested: 900, lineup: ['Kangding Ray', 'Juana'] }),
    ev({ id: 'merch', d: 0, head: 'Experts Only Merch Pop Up', venue: 'Bogart House', interested: 5000 }),
    ev({ id: 'two', d: 0, head: 'DAY+NIGHT', venue: 'BASEMENT', interested: 800 }),
    ev({ id: 'same-room', d: 2, head: 'Another Storehouse night', venue: 'Brooklyn Storehouse', interested: 700 }),
    ev({ id: 'three', d: 2, head: 'Mister Sunday', venue: 'Nowadays', interested: 400 }),
  ];
  const spots = draftSpotlights(feed(events));

  it('spotlights the most anticipated nights, one per venue', () => {
    expect(spots.map((s) => s.edition)).toEqual(['big', 'two', 'three']);
  });

  it('never spotlights something that is not a night out, however popular', () => {
    expect(spots.map((s) => s.edition)).not.toContain('merch');
  });

  it('is two slides, the night and the CTA, which is the smallest carousel Instagram accepts', () => {
    for (const s of spots) {
      expect(s.slides.map((x) => x.template)).toEqual(['event', 'cta']);
      expect(s.series).toBe('single');
    }
  });

  it('dates the slide, because a spotlight can be for a night weeks away', () => {
    expect(spots[0]!.slides[0]).toMatchObject({ data: { position: 'Saturday, Sep 19' } });
    expect(spots[0]!.slot).toBe('2026-09-19');
  });

  it('names the rest of the bill in the caption', () => {
    expect(spots[0]!.caption).toContain('With Juana.');
  });
});

describe('the fixes these posts surfaced', () => {
  it('keeps "to" for ranges and uses a separator everywhere else', () => {
    expect(scrubCopy('22:00 – 04:00')).toBe('22:00 to 04:00');
    expect(scrubCopy('Location TBA – New York')).toBe('Location TBA / New York');
  });

  it('knows a party from a pop-up, a talk or a play', () => {
    expect(isNightOut({ head: 'Experts Only Merch Pop Up' })).toBe(false);
    expect(isNightOut({ head: 'The Perverse - a play by Borna Barzin' })).toBe(false);
    expect(isNightOut({ head: 'Nonstop: Batu, DJ Masda' })).toBe(true);
    // "Popular" and "classic" must not trip the word match.
    expect(isNightOut({ head: 'Classic House Popular Night' })).toBe(true);
  });

  it('leaves heroes to nights out even when the pop-up is the most popular listing', () => {
    const picked = pickHeroes([
      ev({ id: 'merch', head: 'Merch Pop Up', venue: 'A', interested: 9999 }),
      ev({ id: 'night', head: 'A proper night', venue: 'B', interested: 10 }),
    ], 2);
    expect(picked.map((e) => e.id)).toEqual(['night']);
  });

  it('does not repeat names the headline already carries', () => {
    expect(namesNotIn('DAY+NIGHT: D.Dan/ Mos/ Elle Dee', ['Mos (NYC)', 'Elle Dee', 'Heidi Lawden'])).toEqual(['Heidi Lawden']);
    expect(namesNotIn('Magnetic ft Artwork', ['Alex McCracken'])).toEqual(['Alex McCracken']);
  });
});


describe('draftVenuePosts', () => {
  const vibes = (...labels: [string, string][]) => labels.map(([label, kind]) => ({ code: label, label, kind, glyph: null }));
  const nights = (venueName: string, n: number, extra: Partial<FeedEvent> = {}): FeedEvent[] =>
    Array.from({ length: n }, (_, i) => ev({
      id: `${venueName}${i}`, d: i % 3, head: `${venueName} night ${i}`, venue: venueName, door: `2${i}:00`,
      primary: 'Deep House', vibes: vibes(['Underground', 'crowd'], ['Warehouse', 'space'], ['Ends early', 'time']),
      ...extra,
    }));
  const withVenues = (events: FeedEvent[]): FeedResponse => ({
    ...feed(events),
    venues: {
      Nowadays: { addr: '56-06 Cooper Ave', hood: 'Ridgewood', boro: 'Queens', verified: true },
      'Public Records': { addr: '233 Butler St', hood: 'Gowanus', boro: 'Brooklyn', verified: false },
      'No Address Club': { addr: null, hood: '', boro: 'Brooklyn', verified: false },
      'Location TBA – New York': { addr: null, hood: '', boro: '', verified: false },
    },
  } as unknown as FeedResponse);

  const events = [
    ...nights('Public Records', 5), ...nights('Nowadays', 4), ...nights('No Address Club', 6),
    ...nights('Location TBA – New York', 9), ...nights('Tiny Bar', 1),
  ];
  const posts = draftVenuePosts(withVenues(events));

  it('picks busy venues that have an address, and never "Location TBA"', () => {
    expect(posts.map((p) => p.edition)).toEqual(['Public Records', 'Nowadays']);
  });

  it('is the venue, its coming nights, then the CTA, filed under the venue name with no date', () => {
    const p = posts[1]!;
    expect(p.slides.map((x) => x.template)).toEqual(['venue', 'table', 'cta']);
    expect(p).toMatchObject({ series: 'venues', slot: null, edition: 'Nowadays' });
    expect(p.slides[0]).toMatchObject({
      template: 'venue',
      data: { name: 'Nowadays', hood: 'Ridgewood, Queens', foot: '56-06 Cooper Ave', image: null, verified: true },
    });
  });

  it('marks venues nobody has verified, so the studio can warn before the address goes out', () => {
    expect(posts[0]!.slides[0]).toMatchObject({ data: { verified: false } });
  });

  it('describes the room from its own listings, leaving out tags about the time of night', () => {
    expect(venueVibe(nights('Nowadays', 3))).toBe('Underground, warehouse. Mostly deep house.');
  });

  it('keeps acronyms in capitals when a label goes into a sentence', () => {
    const e = nights('Public Records', 3, { primary: 'Experimental / IDM', vibes: vibes(['Sound system', 'space']) });
    expect(venueVibe(e)).toBe('Sound system. Mostly experimental / IDM.');
  });

  it('writes a caption that follows the house rules', () => {
    const cap = posts[0]!.caption;
    expect(cap.startsWith('Public Records, Gowanus, Brooklyn.')).toBe(true);
    expect(cap).toContain('Coming up:');
    expect(cap).not.toMatch(/[—·]/);
    for (const x of posts[0]!.slides) expect(() => slideSchema.parse(x)).not.toThrow();
  });
});
