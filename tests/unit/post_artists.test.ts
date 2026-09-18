/**
 * "Coming to New York": which names lead the post, and which of them a person has to confirm first.
 *
 * The matching half matters as much as the ranking half. "Anna" is an artist on Spotify and a different one
 * in a Bushwick basement, and a post that names the wrong one is a correction in public -- so a guess is
 * stored as a guess and the slide carries a note for the reviewer.
 */
import { describe, expect, it } from 'vitest';
import { pickArtist, SHORT_NAME_MAX } from '../../src/enrich/artist_spotify.js';
import type { KnownArtist } from '../../src/enrich/artist_spotify.js';
import { artistSlide, biggestOn, draftComingToNewYork, MIN_FOLLOWERS, pickBigNames } from '../../src/post/artists.js';
import { CTA_SLIDE } from '../../src/post/draft.js';
import { slideSchema } from '../../src/post/types.js';
import type { FeedDay, FeedEvent, FeedResponse } from '../../src/feed/shape.js';

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
  { date: '2026-09-25', dow: 5, label: 'Fri', sub: 'Sep 25', hint: '' },
  { date: '2026-10-02', dow: 5, label: 'Fri', sub: 'Oct 2', hint: '' },
];

function feed(events: FeedEvent[], days = DAYS): FeedResponse {
  return {
    generated_at: '2026-09-17T12:00:00.000Z',
    range: { from: days[0]!.date, to: days[days.length - 1]!.date },
    city: { key: 'nyc', name: 'New York', tz: 'America/New_York' },
    cities: [], days, venues: {}, events, genres: [], sources: [],
  } as FeedResponse;
}

const artist = (name: string, followers: number, over: Partial<KnownArtist> = {}): KnownArtist => ({
  id: name.toLowerCase(), name, followers, popularity: 60, genres: ['techno'],
  url: `https://open.spotify.com/artist/${name.toLowerCase()}`, confident: true, ...over,
});

const known = new Map<string, KnownArtist>([
  ['four tet', artist('Four Tet', 900_000)],
  ['nick leon', artist('Nick León', 120_000)],
  ['anna', artist('ANNA', 300_000, { confident: false })],
  ['a local dj', artist('A Local DJ', 400)],
]);

describe('picking Spotify’s answer', () => {
  // Shaped like Spotify's own answer, loosely: the point of the parameter type is that missing fields are
  // allowed, which is what these tests are about.
  const body = (items: unknown[]) => ({ artists: { items } } as Parameters<typeof pickArtist>[1]);
  const item = (name: string, over: Record<string, unknown> = {}) => ({
    id: name.toLowerCase(), name, followers: { total: 1000 }, popularity: 50, genres: ['techno'],
    external_urls: { spotify: 'https://open.spotify.com/artist/x' }, ...over,
  });

  it('takes the result that spells the name the way the line-up does', () => {
    const match = pickArtist('Nick León', body([item('Nick Leon Tribute'), item('Nick León', { followers: { total: 120_000 } })]));
    expect(match).toMatchObject({ confident: true, artist: { name: 'Nick León', followers: 120_000 } });
  });

  it('folds accents and punctuation before comparing', () => {
    expect(pickArtist('nick leon', body([item('Nick León')]))?.confident).toBe(true);
    expect(pickArtist('Röyksopp', body([item('Royksopp')]))?.confident).toBe(true);
  });

  it('keeps a near match, but only as a guess for a person to confirm', () => {
    const match = pickArtist('DJ Python', body([item('Python (DJ)')]));
    expect(match).toMatchObject({ confident: false, artist: { name: 'Python (DJ)' } });
  });

  it('will not trust a short name Spotify files under nothing dance-shaped', () => {
    // "Eden", "Anna", "AP": a spelling match on a name this short is not evidence on its own.
    expect('anna'.length).toBeLessThanOrEqual(SHORT_NAME_MAX);
    expect(pickArtist('Anna', body([item('Anna', { genres: ['swedish pop'] })]))?.confident).toBe(false);
    expect(pickArtist('Anna', body([item('Anna', { genres: ['melodic techno'] })]))?.confident).toBe(true);
  });

  it('answers nothing for no results and for a name too short to search', () => {
    expect(pickArtist('Four Tet', body([]))).toBeNull();
    expect(pickArtist('X', body([item('X')]))).toBeNull();
  });

  it('reads a following of zero rather than refusing a result that has none yet', () => {
    expect(pickArtist('Four Tet', body([item('Four Tet', { followers: undefined })]))?.artist.followers).toBe(0);
  });
});

describe('who the post is about', () => {
  const events = [
    ev({ id: 'a', d: 0, lineup: ['A Local DJ', 'Four Tet'], venue: 'Knockdown Center', interested: 10 }),
    ev({ id: 'b', d: 1, lineup: ['Nick León'], venue: 'Nowadays', interested: 900 }),
    ev({ id: 'c', d: 2, lineup: ['ANNA'], venue: 'BASEMENT' }),
    ev({ id: 'd', d: 0, lineup: ['A Local DJ'], venue: 'Somewhere' }),
    ev({ id: 'e', d: 2, lineup: ['Four Tet'], venue: 'Brooklyn Mirage' }),
    ev({ id: 'f', d: 1, lineup: ['Four Tet'], head: 'Four Tet merch pop-up', venue: 'A Shop' }),
  ];

  it('finds the biggest name on a bill, not the first', () => {
    expect(biggestOn(events[0]!, known)?.name).toBe('Four Tet');
    expect(biggestOn(ev({ id: 'x', lineup: ['Nobody'] }), known)).toBeNull();
  });

  it('leaves out names nobody follows, and anything that is not a night out', () => {
    const picked = pickBigNames(feed(events), known);
    expect(picked.map((p) => p.ev.id)).not.toContain('d');
    // A merch pop-up with a famous name on it out-ranks a lot of parties and is still not a gig.
    expect(picked.map((p) => p.ev.id)).not.toContain('f');
  });

  it('gives an artist one slide however many nights they play, keeping the biggest following first', () => {
    const picked = pickBigNames(feed(events), known);
    const names = picked.map((p) => p.artist.name);
    expect(names.filter((n) => n === 'Four Tet')).toHaveLength(1);
    expect(new Set(names)).toEqual(new Set(['Four Tet', 'Nick León', 'ANNA']));
  });

  it('reads as a diary: soonest night first, whatever the following', () => {
    expect(pickBigNames(feed(events), known).map((p) => p.ev.d)).toEqual([0, 1, 2]);
  });

  it('respects the following a name needs to lead a post', () => {
    expect(MIN_FOLLOWERS).toBeGreaterThan(1000);
    expect(pickBigNames(feed(events), known, 5, 500_000).map((p) => p.artist.name)).toEqual(['Four Tet']);
  });
});

describe('the post', () => {
  const events = [
    ev({ id: 'a', d: 0, lineup: ['Four Tet'], venue: 'Knockdown Center', image: 'https://images.ra.co/x.png' }),
    ev({ id: 'b', d: 1, lineup: ['Nick León'], venue: 'Nowadays', room: 'The Backyard' }),
    ev({ id: 'c', d: 2, lineup: ['ANNA'], venue: 'BASEMENT' }),
  ];
  const draft = draftComingToNewYork(feed(events), known)!;

  it('opens with a cover, gives each name a slide and closes with the call to action', () => {
    expect(draft.slides.map((s) => s.template)).toEqual(['cover', 'event', 'event', 'event', 'cta']);
    expect(draft.slides[draft.slides.length - 1]).toEqual(CTA_SLIDE);
    expect(draft.series).toBe('artists');
  });

  it('slides name the artist, the room and the day, and nothing else', () => {
    expect(draft.slides[2]).toMatchObject({
      template: 'event',
      data: { name: 'Nick León', venue: 'Nowadays / The Backyard', position: 'Friday, Sep 25', time: '', genre: '' },
    });
  });

  it('carries the flyer when the night has one', () => {
    expect(draft.slides[1]).toMatchObject({ data: { image: { src: 'https://images.ra.co/x.png' } } });
  });

  it('asks a person to confirm a name that was matched on a guess, and only that one', () => {
    const checks = draft.slides.flatMap((s) => (s.template === 'event' && s.data.check ? [s.data.check] : []));
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatch(/ANNA/);
    expect(checks[0]).toMatch(/Confirm/);
  });

  it('keeps the follower counts off the post entirely', () => {
    // They rank the post; printing them would be printing a number that is stale by the weekend.
    expect(JSON.stringify(draft.slides)).not.toContain('900000');
    expect(draft.caption).not.toContain('followers');
  });

  it('names every artist, their room and their night in the caption', () => {
    expect(draft.caption).toContain('Four Tet, Knockdown Center, Friday, Sep 18');
    expect(draft.caption).toContain('noct.pro');
  });

  it('produces slides the renderer accepts', () => {
    for (const slide of draft.slides) expect(() => slideSchema.parse(slide)).not.toThrow();
  });

  it('is one post per window, so drafting again next month does not overwrite this one', () => {
    expect(draft.edition).toBe('2026-09-18');
    expect(draft.slot).toBeNull();
  });

  it('answers with nothing rather than a thin post when the month is quiet', () => {
    expect(draftComingToNewYork(feed([events[0]!]), known)).toBeNull();
    expect(draftComingToNewYork(feed(events), new Map())).toBeNull();
  });

  it('closes with the studio’s own words when it has them', () => {
    const mine = slideSchema.parse({ template: 'cta', data: { question: 'tired of ten tabs?' } });
    const withMine = draftComingToNewYork(feed(events), known, { cta: mine })!;
    expect(withMine.slides[withMine.slides.length - 1]).toEqual(mine);
  });

  it('builds a slide for one pick on its own, for the studio to redraw', () => {
    const slide = artistSlide(DAYS, { artist: artist('Four Tet', 900_000), ev: events[0]! });
    expect(slide).toMatchObject({ template: 'event', data: { name: 'Four Tet', ref: 'a' } });
  });
});
