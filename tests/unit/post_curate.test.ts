/**
 * Which nights lead a post.
 *
 * Ranking by RA's "interested" is a popularity list, and a popularity list in New York is the same four big
 * rooms every week. These are the rules that stop that: what NOCT is for, what it posted recently, and what
 * is already in the deck.
 */
import { describe, expect, it } from 'vitest';
import { curateHeroes, interestOf, noMemory, tasteOf, venueKey, type Memory } from '../../src/post/curate.js';
import type { FeedEvent, FeedVibe } from '../../src/feed/shape.js';

const vibe = (code: string): FeedVibe => ({ code, label: code, glyph: null });

function ev(over: Partial<FeedEvent> & { id: string }): FeedEvent {
  return {
    n: 1, d: 0, head: 'A night', lineup: [], venue: 'Nowadays', room: null, door: '22:00', close: '',
    genre: ['Techno'], gsrc: '', primary: 'Techno', genre_codes: [], tags: [], genre_confidence: null,
    vibes: [], scalars: {
      energy: null, darkness: null, crowd_size: null, start_lateness: null, end_lateness: null,
      price_tier: null, underground_index: null,
    },
    sound: '', age: '', interested: 100, srcs: [], platforms: [], ra: '', dice: '', eb: '', url: '',
    tex: 'x1', full: false, soldout: false, note: '', status: 'scheduled', image: '', going_count: 0,
    needs_review: false, is_electronic: true,
    ...over,
  } as FeedEvent;
}

const memoryOf = (venues: [string, number][], events: string[] = []): Memory => ({
  venues: new Map(venues.map(([v, n]) => [venueKey(v), n])),
  events: new Set(events),
});

describe('what a night is worth', () => {
  it('reads interest on a log scale, so the biggest room is not the answer to every question', () => {
    // Ten times the tickets is worth one point; the difference between 2,000 and 2,500 is worth almost none.
    expect(interestOf(ev({ id: 'a', interested: 999 })) - interestOf(ev({ id: 'b', interested: 99 }))).toBeCloseTo(1, 1);
    expect(interestOf(ev({ id: 'a', interested: 2500 })) - interestOf(ev({ id: 'b', interested: 2000 }))).toBeLessThan(0.1);
  });

  it('adds up what NOCT is for, and subtracts what it is not', () => {
    expect(tasteOf(ev({ id: 'a', vibes: [vibe('queer_party'), vibe('local_crews')] }))).toBeGreaterThan(0.8);
    expect(tasteOf(ev({ id: 'b', vibes: [vibe('mainstream_club'), vibe('pricey')] }))).toBeLessThan(-0.6);
    expect(tasteOf(ev({ id: 'c' }))).toBe(0);
  });
});

describe('curating a weekend', () => {
  it('leads with a queer party over a bigger commercial room, but not over a far bigger night', () => {
    const party = ev({ id: 'party', venue: 'Bossa Nova', interested: 300, vibes: [vibe('queer_party'), vibe('local_crews')] });
    const big = ev({ id: 'big', venue: 'Brooklyn Mirage', interested: 900, vibes: [vibe('mainstream_club')] });
    expect(curateHeroes([party, big], { limit: 1 }).map((e) => e.id)).toEqual(['party']);

    const huge = ev({ id: 'huge', venue: 'Brooklyn Mirage', interested: 30_000, vibes: [vibe('mainstream_club')] });
    expect(curateHeroes([party, huge], { limit: 1 }).map((e) => e.id)).toEqual(['huge']);
  });

  it('gives every night of the window a slide before any night gets a second', () => {
    const nights = [
      ev({ id: 'fri1', d: 0, venue: 'A', interested: 900 }),
      ev({ id: 'fri2', d: 0, venue: 'B', interested: 800 }),
      ev({ id: 'fri3', d: 0, venue: 'C', interested: 700 }),
      ev({ id: 'sat', d: 1, venue: 'D', interested: 120 }),
      ev({ id: 'sun', d: 2, venue: 'E', interested: 90 }),
    ];
    const picked = curateHeroes(nights, { limit: 3, nights: 3 });
    expect(new Set(picked.map((e) => e.d))).toEqual(new Set([0, 1, 2]));
  });

  it('turns away a venue the account led with recently, and turns away a repeat harder', () => {
    const tired = ev({ id: 'tired', venue: 'Nowadays', interested: 600 });
    const fresh = ev({ id: 'fresh', venue: 'Public Records', interested: 300 });
    expect(curateHeroes([tired, fresh], { limit: 1 }).map((e) => e.id)).toEqual(['tired']);
    expect(curateHeroes([tired, fresh], { limit: 1, memory: memoryOf([['Nowadays', 2]]) }).map((e) => e.id))
      .toEqual(['fresh']);
  });

  it('does not lead twice with the same night it already gave a slide to', () => {
    const again = ev({ id: 'again', venue: 'Elsewhere', interested: 900 });
    const other = ev({ id: 'other', venue: 'Jupiter Disco', interested: 300 });
    expect(curateHeroes([again, other], { limit: 1, memory: memoryOf([], ['again']) }).map((e) => e.id))
      .toEqual(['other']);
  });

  it('spreads the genres, so four techno nights are not a weekend guide', () => {
    const events = [
      ev({ id: 't1', venue: 'A', primary: 'Techno', interested: 900 }),
      ev({ id: 't2', venue: 'B', primary: 'Techno', interested: 800 }),
      ev({ id: 't3', venue: 'C', primary: 'Techno', interested: 700 }),
      ev({ id: 'house', venue: 'D', primary: 'Deep House', interested: 200 }),
      ev({ id: 'ukg', venue: 'E', primary: 'UK Garage', interested: 150 }),
    ];
    const genres = curateHeroes(events, { limit: 3 }).map((e) => e.primary);
    expect(new Set(genres).size).toBeGreaterThan(1);
  });

  it('takes one night per venue, and fills the deck anyway when that leaves it short', () => {
    const same = [
      ev({ id: 'a', venue: 'Nowadays', interested: 900 }),
      ev({ id: 'b', venue: 'Nowadays / The Backyard', interested: 800 }),
    ];
    expect(curateHeroes(same, { limit: 1 })).toHaveLength(1);
    expect(curateHeroes(same, { limit: 2 })).toHaveLength(2);
  });

  it('gives the same deck for the same feed, so a redraft is a redraft', () => {
    const events = [1, 2, 3, 4, 5, 6].map((n) => ev({ id: `e${n}`, venue: `V${n}`, interested: 500 }));
    const once = curateHeroes(events, { limit: 4, memory: noMemory() }).map((e) => e.id);
    const twice = curateHeroes([...events].reverse(), { limit: 4, memory: noMemory() }).map((e) => e.id);
    expect(twice).toEqual(once);
  });

  it('reads as a diary: the deck comes out in night order', () => {
    const events = [
      ev({ id: 'sun', d: 2, venue: 'A', interested: 900 }),
      ev({ id: 'fri', d: 0, venue: 'B', interested: 300 }),
      ev({ id: 'sat', d: 1, venue: 'C', interested: 600 }),
    ];
    expect(curateHeroes(events, { limit: 3, nights: 3 }).map((e) => e.id)).toEqual(['fri', 'sat', 'sun']);
  });

  it('leaves out what is not a night out, however wanted', () => {
    const picked = curateHeroes([
      ev({ id: 'merch', head: 'Four Tet Merch Pop Up', venue: 'A', interested: 9999 }),
      ev({ id: 'night', head: 'A proper night', venue: 'B', interested: 10 }),
    ], { limit: 2 });
    expect(picked.map((e) => e.id)).toEqual(['night']);
  });
});

describe('a month of weekends', () => {
  it('does not lead with the same room week after week', () => {
    // The same feed every week, which is the worst case: without memory the deck is identical each time.
    const week = () => [
      ev({ id: 'mirage', venue: 'Brooklyn Mirage', interested: 2000 }),
      ev({ id: 'knock', venue: 'Knockdown Center', interested: 1500 }),
      ev({ id: 'elsewhere', venue: 'Elsewhere', interested: 1200 }),
      ev({ id: 'base', venue: 'BASEMENT', interested: 900 }),
      ev({ id: 'nowadays', venue: 'Nowadays', interested: 700 }),
      ev({ id: 'public', venue: 'Public Records', interested: 500 }),
      ev({ id: 'bossa', venue: 'Bossa Nova Civic Club', interested: 300, vibes: [vibe('queer_party')] }),
      ev({ id: 'jupiter', venue: 'Jupiter Disco', interested: 200, vibes: [vibe('local_crews')] }),
    ];
    const memory = noMemory();
    const weeks: string[][] = [];
    for (let i = 0; i < 3; i += 1) {
      const deck = curateHeroes(week(), { limit: 4, memory });
      weeks.push(deck.map((e) => venueKey(e.venue)));
      for (const e of deck) memory.venues.set(venueKey(e.venue), (memory.venues.get(venueKey(e.venue)) ?? 0) + 1);
    }
    expect(weeks[1]).not.toEqual(weeks[0]);
    expect(weeks[2]).not.toEqual(weeks[1]);
    // Over three weeks the account has been to more than six different rooms, not the same four.
    expect(new Set(weeks.flat()).size).toBeGreaterThanOrEqual(6);
  });
});
