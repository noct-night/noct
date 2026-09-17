import { describe, expect, it } from 'vitest';
import { candidatesFor, cannotChoose, chosenIds, deckSource, deckWindow } from '../../src/post/choose.js';
import { draftWeekend } from '../../src/post/draft.js';
import { slideSchema } from '../../src/post/types.js';
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

const events = [
  ev({ id: 'a', venue: 'Knockdown Center', head: 'Four Tet', interested: 900 }),
  ev({ id: 'b', d: 1, venue: 'Nowadays', head: 'Mister Sunday', interested: 800, primary: 'Deep House', genre_codes: ['house.deep'] }),
  ev({ id: 'c', d: 2, venue: 'BASEMENT', head: 'Merch pop-up', interested: 700 }),
  ...Array.from({ length: 50 }, (_, i) => ev({ id: `x${i}`, venue: `Venue ${i}`, head: `Night ${i}`, interested: 100 - i })),
];
const weekend = { kind: 'carousel', series: 'weekend', slot: '2026-09-18', edition: null, status: 'queued' } as const;

describe('which posts can have their nights chosen', () => {
  it('allows weekend decks and genre editions', () => {
    expect(cannotChoose(weekend)).toBeNull();
    expect(cannotChoose({ ...weekend, series: 'genre', edition: 'house' })).toBeNull();
  });

  it('refuses spotlights, venue posts, reels and published posts, saying why', () => {
    expect(cannotChoose({ ...weekend, series: 'single' })).toMatch(/only weekend decks/);
    expect(cannotChoose({ ...weekend, series: 'venues', slot: null })).toMatch(/only weekend decks/);
    expect(cannotChoose({ ...weekend, kind: 'reel' })).toMatch(/only weekend decks/);
    expect(cannotChoose({ ...weekend, series: 'genre', edition: 'not-a-family' })).toMatch(/genre/);
    expect(cannotChoose({ ...weekend, status: 'posted' })).toMatch(/published/);
  });
});

describe('the window and the source', () => {
  it('covers Friday to Sunday from the slot, across a month boundary too', () => {
    expect(deckWindow('2026-09-18')).toEqual({ from: '2026-09-18', to: '2026-09-20' });
    expect(deckWindow('2026-10-30')).toEqual({ from: '2026-10-30', to: '2026-11-01' });
  });

  it('gives a genre edition only its genre, with its own cover line', () => {
    const src = deckSource({ series: 'genre', edition: 'house' }, feed(events));
    expect(src.feed.events.map((e) => e.id)).toEqual(['b']);
    expect(src.opts.lede).toBe('Where to hear house\nin New York');
    expect(deckSource({ series: 'weekend', edition: null }, feed(events)).feed.events).toHaveLength(events.length);
  });
});

describe('what is offered', () => {
  const deck = draftWeekend(feed(events))!;

  it('marks the nights the deck already shows, in slide order', () => {
    expect(chosenIds(deck.slides, events)).toEqual(['a', 'b', 'x0', 'x1']);
  });

  it('still recognises the nights of a deck drafted before slides named their event', () => {
    const old = deck.slides.map((s) => (s.template === 'event' ? slideSchema.parse({ ...s, data: { ...s.data, ref: undefined } }) : s));
    expect(chosenIds(old, events)).toEqual(['a', 'b', 'x0', 'x1']);
  });

  it('offers every kind of listing, best first, and keeps chosen nights that fell below the cut', () => {
    const picked = draftWeekend(feed(events), { heroIds: ['x49'] })!;
    const { candidates, chosen } = candidatesFor(feed(events), picked.slides, 10);
    expect(chosen).toEqual(['x49']);
    expect(candidates.map((c) => c.id).slice(0, 3)).toEqual(['a', 'b', 'c']);
    expect(candidates.map((c) => c.id)).toContain('x49');
    expect(candidates[1]).toMatchObject({ name: 'Mister Sunday', venue: 'Nowadays', day: 'Sat', genre: 'Deep House' });
  });
});
