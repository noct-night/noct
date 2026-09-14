import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/lib/env.js';
import type { Logger } from '../../src/lib/log.js';
import {
  DICE_EVENTS_URL,
  KEY_MISSING,
  PAGE_SIZE,
  buildEventsUrl,
  dice,
  diceGenres,
  diceLineup,
  dicePrices,
  genreFromTag,
  isClubEvent,
  isInNewYork,
  nightWindow,
  normalizeEvent,
  overlapsWindow,
  parseEventsPayload,
  parseStatus,
  selectEvents,
  type DiceEvent,
} from '../../src/sources/dice.js';
import type { FetchContext } from '../../src/sources/types.js';

// Real slice of GET /api/v2/events?filter[cities][]=New York&filter[cities][]=Brooklyn&filter[flags][]=going_ahead (2026-09-13).
const fixture: unknown = JSON.parse(readFileSync(new URL('../fixtures/dice_events_v2.json', import.meta.url), 'utf8'));
const events = parseEventsPayload(fixture);

const byHash = (hash: string): DiceEvent => {
  const e = events.find((x) => x.hash === hash);
  if (!e) throw new Error(`fixture has no event ${hash}`);
  return e;
};
const clone = (e: DiceEvent, patch: Partial<DiceEvent>): DiceEvent => ({ ...structuredClone(e), ...patch });
const hashes = (xs: DiceEvent[]) => xs.map((e) => e.hash).sort();

const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet };
const ctx = (e: Env, over: Partial<FetchContext> = {}): FetchContext => ({ env: e, log: quiet, fromDate: '2026-09-13', toDate: '2026-10-13', ...over });

describe('dice: request shape', () => {
  it('buildEventsUrl targets the partner host with the widget query, brackets URL-encoded', () => {
    const url = buildEventsUrl(2);
    expect(url.startsWith(`${DICE_EVENTS_URL}?`)).toBe(true);
    const u = new URL(url);
    expect(u.host).toBe('partners-endpoint.dice.fm');
    expect(u.searchParams.get('page[size]')).toBe(String(PAGE_SIZE));
    expect(u.searchParams.get('page[number]')).toBe('2');
    expect(u.searchParams.getAll('filter[cities][]')).toEqual(['New York', 'Brooklyn']);
    expect(u.searchParams.getAll('filter[flags][]')).toEqual(['going_ahead']);
    expect(url).toContain('page%5Bsize%5D=100');
    expect(url).toContain('filter%5Bcities%5D%5B%5D=New+York');
  });

  it('parseEventsPayload reads the data[] envelope and rejects anything else', () => {
    expect(events).toHaveLength(10);
    expect(() => parseEventsPayload({ error: 'unauthorized' })).toThrow(/data\[\]/);
    expect(() => parseEventsPayload(null)).toThrow(/data\[\]/);
    expect(parseEventsPayload({ data: [{ id: 'a' }, { nope: 1 }, null] })).toHaveLength(1);
  });
});

describe('dice: selection rules', () => {
  it('nightWindow spans New York midnights in UTC, across the DST change', () => {
    const edt = nightWindow('2026-09-13', '2026-09-13');
    expect(edt.startUtc.toISOString()).toBe('2026-09-13T04:00:00.000Z');
    expect(edt.endUtc.toISOString()).toBe('2026-09-14T04:00:00.000Z');
    // clocks fall back on 2026-11-01: the day is 25 hours long
    const fallBack = nightWindow('2026-11-01', '2026-11-01');
    expect(fallBack.startUtc.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(fallBack.endUtc.toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });

  it('keeps events that overlap the window, including a season pass that started months ago', () => {
    const all = selectEvents(events, nightWindow('2026-09-13', '2026-10-13'));
    expect(all.kept).toHaveLength(10);
    expect(all.dropped).toEqual({ outsideNy: 0, undated: 0, outsideWindow: 0, nonClub: 0 });

    // From Monday 09-14 (00:00 NY = 04:00Z): only nights still running after that instant survive
    const fromMonday = selectEvents(events, nightWindow('2026-09-14', '2026-10-13'));
    expect(hashes(fromMonday.kept)).toEqual(['bb8g7x', 'mx792r', 'xeg5qm']);
    expect(fromMonday.dropped.outsideWindow).toBe(7);

    // Window entirely before the slice: only the multi-day pass (May 2 -> Oct 12) overlaps
    const before = selectEvents(events, nightWindow('2026-09-01', '2026-09-12'));
    expect(hashes(before.kept)).toEqual(['mx792r']);
    expect(normalizeEvent(byHash('mx792r')).sourceTags.is_multi_days_event).toBe(true);

    const w = nightWindow('2026-09-13', '2026-10-13');
    expect(overlapsWindow(clone(byHash('dkm38e'), { date: 'garbage' }), w)).toBeNull();
    expect(selectEvents([clone(byHash('dkm38e'), { date: null })], w).dropped.undated).toBe(1);
  });

  it('drops gigs and culture, keeps dj/party by type tag or by genre-tag prefix', () => {
    const base = byHash('dkm38e');
    const gig = clone(base, { type_tags: ['music:gig'], genre_tags: ['gig:indie'] });
    const comedy = clone(base, { type_tags: ['culture:comedy'], genre_tags: [] });
    const untypedParty = clone(base, { type_tags: [], genre_tags: ['party:techno'] });
    const party = byHash('xe3yx3');
    expect(isClubEvent(gig)).toBe(false);
    expect(isClubEvent(comedy)).toBe(false);
    expect(isClubEvent(untypedParty)).toBe(true);
    expect(isClubEvent(party)).toBe(true);
    const sel = selectEvents([gig, comedy, untypedParty, party], nightWindow('2026-09-13', '2026-10-13'));
    expect(sel.kept).toHaveLength(2);
    expect(sel.dropped.nonClub).toBe(2);
  });

  it('keeps New York state or metro-bbox coordinates and drops the Giza leak', () => {
    const base = byHash('dkm38e');
    const giza = clone(base, { location: { state: 'Giza', lat: 29.9773, lng: 31.1325 } });
    const jerseyCity = clone(base, { location: { state: 'New Jersey', lat: 40.7178, lng: -74.0431 } });
    const albany = clone(base, { location: { state: 'New York', lat: 42.6526, lng: -73.7562 } });
    const noLocation = clone(base, { location: null });
    expect(isInNewYork(base)).toBe(true);
    expect(isInNewYork(giza)).toBe(false);
    expect(isInNewYork(jerseyCity)).toBe(true);
    expect(isInNewYork(albany)).toBe(true);
    expect(isInNewYork(noLocation)).toBe(false);
    const sel = selectEvents([giza, jerseyCity, noLocation], nightWindow('2026-09-13', '2026-10-13'));
    expect(sel.kept).toHaveLength(1);
    expect(sel.dropped.outsideNy).toBe(2);
  });
});

describe('dice: normalisation', () => {
  it('maps a full club night (The Nursery @ Public Records)', () => {
    const e = byHash('dkm38e');
    const l = normalizeEvent(e);
    expect(l.source).toBe('dice');
    expect(l.sourceId).toBe('dkm38e');
    expect(l.sourceUrl).toBe(`https://dice.fm/event/dkm38e-${e.perm_name}`);
    expect(l.title).toBe('The Nursery: Benji B, Nabihah Iqbal [DJ]');
    expect(l.startsAt).toBe('2026-09-13T19:00:00.000Z');
    expect(l.endsAt).toBe('2026-09-14T01:00:00.000Z');
    expect(l.hasTime).toBe(true);
    expect(l.night).toBe('2026-09-13');
    expect(l.venueName).toBe('Public Records');
    expect(l.venueSourceId).toBe('2435');
    expect(l.venueAddress).toBe('233 Butler St, Brooklyn, NY 11217, USA');
    expect(l.venueLat).toBeCloseTo(40.68226, 4);
    expect(l.venueLng).toBeCloseTo(-73.98638, 4);
    expect(l.lineup).toEqual(['Benji B', 'Nabihah Iqbal (DJ Set)']);
    expect(l.prices).toEqual([
      { tier: 'General Admission', price: 42.23, feesIncluded: true, available: true, note: 'face $35 + $7.23 fees' },
      { tier: 'Entry Before 4 PM', price: 23.69, feesIncluded: true, available: false, note: 'face $15 + $8.69 fees' },
    ]);
    // the cheaper tier is sold out, so min/max come from what is still on sale
    expect(l.priceMin).toBe(42.23);
    expect(l.priceMax).toBe(42.23);
    expect(l.currency).toBe('USD');
    expect(l.feesIncluded).toBe(true);
    expect(l.soldOut).toBe(false);
    expect(l.status).toBe('scheduled');
    expect(l.ageMin).toBe(21);
    expect(l.genres).toEqual(['deep house', 'electronic', 'house', 'dance', 'hip hop']);
    expect(l.promoters).toEqual(['Speakmans Gowanus LLC dba Public Records']);
    expect(l.externalRefs).toEqual([]);
    expect(l.description?.startsWith('Public Records aims to provide a safer space.')).toBe(true);
    expect(l.description).not.toContain('\n');
    expect(l.imageUrl).toContain('72fe5a39-4090-457a-924e-c88fa286c169.jpg?rect=0%2C216');
    expect(l.interestedCount).toBeNull();

    const raw = l.raw as Record<string, unknown>;
    expect(raw.id).toBe(e.id);
    expect(raw).not.toHaveProperty('spotify_tracks');
    expect(raw).not.toHaveProperty('apple_music_tracks');
    expect(raw).not.toHaveProperty('images');
    expect(raw).toHaveProperty('event_images');

    expect(l.sourceTags).toMatchObject({
      dice_id: e.id,
      int_id: 575744,
      status: 'on-sale',
      checksum: '3B659E22BBDF4980DB9AF64396DC7E46',
      dice_type_tags: ['music:dj'],
      dice_genre_tags: ['dj:deephouse', 'dj:electronic', 'dj:house'],
      dice_tags: ['genre:electronic', 'genre:dance', 'genre:house', 'genre:hiphop'],
      dice_flags: ['qr-code', 'cooling-off-period', 'going_ahead'],
      presented_by: 'Presented by Public Records.',
      lineup_times: [{ details: 'Doors open', time: '3:00 PM' }],
      is_multi_days_event: false,
    });
    expect(l.sourceTags.bundles).toEqual(expect.arrayContaining(['CLUB at PR', 'Home by midnight']));
    expect(typeof l.sourceTags.raw_description).toBe('string');
  });

  it('prices: integer cents become dollars, sold-out tiers stay listed, free RSVP is $0', () => {
    const soldOutFree = normalizeEvent(byHash('bbgkdg'));
    expect(soldOutFree.prices).toEqual([{ tier: 'Free w/ RSVP', price: 0, feesIncluded: true, available: false, note: 'face $0' }]);
    expect(soldOutFree.priceMin).toBe(0);
    expect(soldOutFree.priceMax).toBe(0);
    expect(soldOutFree.soldOut).toBe(true);

    const tables = dicePrices(byHash('avxev2'));
    expect(tables.prices).toHaveLength(6);
    expect(tables.priceMin).toBe(36.28);
    expect(tables.priceMax).toBe(316.41);

    const rsvp = normalizeEvent(byHash('xeg5qm'));
    expect(rsvp.prices[0]).toMatchObject({ tier: 'Free RSVP', price: 0, available: true });
    expect(rsvp.priceMin).toBe(0);

    const odd = dicePrices(clone(byHash('dkm38e'), { ticket_types: [{ name: '  ', price: null, sold_out: false }] }));
    expect(odd.prices).toEqual([{ tier: 'Ticket', price: null, feesIncluded: true, available: true, note: null }]);
    expect(odd.priceMin).toBeNull();
    const none = normalizeEvent(clone(byHash('dkm38e'), { ticket_types: [] }));
    expect(none.prices).toEqual([]);
    expect(none.feesIncluded).toBeNull();
  });

  it('genres: genre_tags suffixes are lower-cased, de-hyphenated and compound slugs split', () => {
    expect(genreFromTag('dj:tech-house')).toBe('tech house');
    expect(genreFromTag('party:afro_house')).toBe('afro house');
    expect(genreFromTag('dj:afrohouse')).toBe('afro house');
    expect(genreFromTag('dj:melodictechno')).toBe('melodic techno');
    expect(genreFromTag('dj:hard_techno')).toBe('hard techno');
    expect(genreFromTag('dj:deephouse')).toBe('deep house');
    expect(genreFromTag('genre:hiphop')).toBe('hip hop');
    expect(genreFromTag('dj:lgbtq+')).toBe('lgbtq+');
    expect(genreFromTag('DJ:Techno')).toBe('techno');
    expect(genreFromTag('techno')).toBe('techno');
    // 'dj:dj' is DICE's "it's a DJ set" placeholder, not a genre
    expect(genreFromTag('dj:dj')).toBeNull();
    expect(genreFromTag('dj:')).toBeNull();

    expect(diceGenres(byHash('bb8g7x'))).toEqual([
      'electronic', 'afro house', 'deep house', 'minimal', 'disco', 'indie', 'tech house', 'melodic techno', 'dance',
    ]);
    const dupes = clone(byHash('dkm38e'), { genre_tags: ['dj:afrohouse', 'party:afro_house'], tags: ['genre:afro-house', 'type:dj', 'notion:selection'] });
    expect(diceGenres(dupes)).toEqual(['afro house']);
    expect(diceGenres(clone(byHash('dkm38e'), { genre_tags: null, tags: null }))).toEqual([]);
  });

  it('status comes from flags; on-sale/off-sale stays in sourceTags', () => {
    expect(parseStatus(['qr-code', 'going_ahead'])).toBe('scheduled');
    expect(parseStatus(['cancelled'])).toBe('cancelled');
    expect(parseStatus(['postponed', 'going_ahead'])).toBe('postponed');
    expect(parseStatus(['rescheduled'])).toBe('rescheduled');
    expect(parseStatus(undefined)).toBe('scheduled');
    const cancelled = normalizeEvent(clone(byHash('ryoa2q'), { flags: ['cancelled', 'qr-code'] }));
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.sourceTags.status).toBe('off-sale');
  });

  it('lineup: headliners first, plain artists as fallback, deduped', () => {
    expect(diceLineup(byHash('v3xrql'))).toEqual(['NU2U Radio', 'Arty Furtado', 'Lei', 'Dada Cozmic', 'DJ AYANE']);
    const reordered = clone(byHash('dkm38e'), {
      detailed_artists: [{ name: 'Support', headliner: false }, { name: 'Head', headliner: true }, { name: 'Other', headliner: false }],
    });
    expect(diceLineup(reordered)).toEqual(['Head', 'Support', 'Other']);
    expect(diceLineup(clone(byHash('dkm38e'), { detailed_artists: [], artists: ['A', 'B', 'A'] }))).toEqual(['A', 'B']);
    expect(diceLineup(byHash('mx792r'))).toEqual([]);
  });

  it('venue, title and id fallbacks', () => {
    const arlo = normalizeEvent(byHash('xe3yx3'));
    expect(arlo.venueName).toBe('Rooftop at Arlo Williamsburg');
    expect(arlo.title).toBe('Azure Day Party September 13th');
    const twoRooms = normalizeEvent(byHash('bb8g7x'));
    expect(twoRooms.venueName).toBe('1 Hotel Brooklyn Bridge');
    expect(twoRooms.venueSourceId).toBe('12409');

    const base = byHash('dkm38e');
    const noVenues = normalizeEvent(clone(base, { venues: [], venue: 'Somewhere ' }));
    expect(noVenues.venueName).toBe('Somewhere');
    expect(noVenues.venueSourceId).toBeNull();
    const noHash = normalizeEvent(clone(base, { hash: null, perm_name: null }));
    expect(noHash.sourceId).toBe(base.id);
    expect(noHash.sourceUrl).toBe(`https://dice.fm/event/${base.id}`);
    expect(normalizeEvent(clone(base, { hash: 'abc123', perm_name: null })).sourceUrl).toBe('https://dice.fm/event/abc123');
    expect(normalizeEvent(clone(base, { event_images: { landscape: null, square: 'sq.jpg' } })).imageUrl).toBe('sq.jpg');
    expect(normalizeEvent(clone(base, { event_images: null })).imageUrl).toBeNull();
    expect(normalizeEvent(clone(base, { age_limit: 'All Ages' })).ageMin).toBe(0);
    expect(normalizeEvent(clone(base, { age_limit: null })).ageMin).toBeNull();
  });
});

describe('dice: adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Stub global fetch with a page[number] -> body map; returns the recorded calls. */
  function mockDice(pages: Record<number, unknown>, status = 200) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
        const page = Number(new URL(url).searchParams.get('page[number]'));
        const body = pages[page] ?? { data: [], links: { self: url, next: null } };
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      }),
    );
    return calls;
  }

  /** n synthetic club events with unique ids/hashes and caller-chosen start times. */
  function fakeEvents(n: number, date: (i: number) => string, from = 0, patch: Partial<DiceEvent> = {}): DiceEvent[] {
    return Array.from({ length: n }, (_, i) => {
      const k = from + i;
      const start = date(i);
      const end = new Date(new Date(start).getTime() + 6 * 3_600_000).toISOString();
      return clone(byHash('dkm38e'), { id: `id${k}`, hash: `h${k.toString(36).padStart(5, '0')}`, date: start, date_end: end, ...patch });
    });
  }
  const sameNight = (i: number) => new Date(Date.UTC(2026, 8, 13, 16, i)).toISOString();
  const pageOf = (url: string) => Number(new URL(url).searchParams.get('page[number]'));

  it('enabled() requires one of the two keys and points at the docs', () => {
    expect(dice.enabled({})).toEqual({ ok: false, reason: KEY_MISSING });
    expect(dice.enabled({ DICE_API_KEY: '', DICE_FRONTEND_KEY: '' })).toEqual({ ok: false, reason: KEY_MISSING });
    expect(KEY_MISSING).toContain('docs/sources/dice.md');
    expect(dice.enabled({ DICE_API_KEY: 'issued-by-dice' })).toEqual({ ok: true });
    expect(dice.enabled({ DICE_FRONTEND_KEY: 'public-page-key' })).toEqual({ ok: true });
    // the note must state both paths and keep the DICE-issued key as the clean one
    expect(dice.tosNote).toMatch(/DICE_FRONTEND_KEY/);
    expect(dice.tosNote).toMatch(/§8\.4/);
  });

  it('fetch() refuses to run without a key and never touches the network', async () => {
    const calls = mockDice({});
    await expect(dice.fetch(ctx({}))).rejects.toThrow(KEY_MISSING);
    expect(calls).toHaveLength(0);
  });

  it('fetch() walks page[number] on the partner host with x-api-key, ignores links.next, dedupes, warns on non-club drops', async () => {
    const page1 = [
      ...fakeEvents(98, sameNight),
      ...fakeEvents(2, sameNight, 98, { type_tags: ['music:gig'], genre_tags: ['gig:indie'] }),
    ];
    // a new event landing mid-walk pushes page 1's last club event onto page 2 — it must count once
    const page2 = [clone(page1[97]!, {}), ...fakeEvents(2, sameNight, 100)];
    const next = 'https://events-api.dice.fm/api/v2/events?page[number]=2&page[size]=100';
    const calls = mockDice({ 1: { data: page1, links: { self: 'x', next } }, 2: { data: page2, links: { self: 'y', next: null } } });

    const res = await dice.fetch(ctx({ DICE_API_KEY: 'test-key' }));
    expect(calls.map((c) => pageOf(c.url))).toEqual([1, 2]);
    for (const c of calls) {
      expect(c.url.startsWith(`${DICE_EVENTS_URL}?`)).toBe(true);
      expect(new URL(c.url).host).toBe('partners-endpoint.dice.fm');
      expect(c.headers['x-api-key']).toBe('test-key');
    }
    expect(res.listings).toHaveLength(100); // 98 + 2 new on page 2; the duplicate hash counted once
    expect(new Set(res.listings.map((l) => l.sourceId)).size).toBe(100);
    expect(res.window).toEqual({ start: '2026-09-13', end: '2026-10-13' });
    expect(res.warnings).toEqual(['dropped 2 non-club events (gigs, culture)']);
  });

  it('fetch() keeps paging on a full page even when one entry is malformed', async () => {
    // the wire count (data.length === 100) decides whether another page exists, not the count after parsing
    const page1 = [...fakeEvents(99, sameNight), { hash: 'no-id-at-all' } as unknown as DiceEvent];
    const calls = mockDice({ 1: { data: page1, links: {} }, 2: { data: fakeEvents(3, sameNight, 100), links: {} } });
    const res = await dice.fetch(ctx({ DICE_API_KEY: 'test-key' }));
    expect(calls.map((c) => pageOf(c.url))).toEqual([1, 2]);
    expect(res.listings).toHaveLength(102);
    expect(res.window).toEqual({ start: '2026-09-13', end: '2026-10-13' });
  });

  it('fetch() honours limit and then promises no window', async () => {
    const calls = mockDice({ 1: { data: fakeEvents(100, sameNight), links: {} }, 2: { data: fakeEvents(10, sameNight, 100), links: {} } });
    const res = await dice.fetch(ctx({ DICE_API_KEY: 'test-key' }, { limit: 5 }));
    expect(calls).toHaveLength(1);
    expect(res.listings).toHaveLength(5);
    expect(res.window).toBeNull();
  });

  it('fetch() stops paging once a date-ascending page has run past the window, keeping the full window', async () => {
    // DICE has no date filter: results are date-ascending, so a page whose last event starts after toDate ends the walk.
    const afterWindow = (i: number) => (i === 0 ? '2026-09-13T20:00:00.000Z' : new Date(Date.UTC(2026, 10, 1, 20, i)).toISOString());
    const calls = mockDice({ 1: { data: fakeEvents(100, afterWindow), links: {} }, 2: { data: fakeEvents(100, afterWindow, 100), links: {} } });
    const res = await dice.fetch(ctx({ DICE_API_KEY: 'test-key' }));
    expect(calls).toHaveLength(1);
    expect(res.listings.map((l) => l.sourceId)).toEqual(['h00000']);
    expect(res.window).toEqual({ start: '2026-09-13', end: '2026-10-13' });
  });

  it('fetch() stops when page[number] is ignored and the same page comes back', async () => {
    const same = fakeEvents(100, sameNight);
    const calls = mockDice({ 1: { data: same, links: {} }, 2: { data: same, links: {} }, 3: { data: same, links: {} } });
    const res = await dice.fetch(ctx({ DICE_API_KEY: 'test-key' }));
    expect(calls).toHaveLength(2);
    expect(res.listings).toHaveLength(100);
    expect(res.window).toBeNull();
    expect(res.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/pagination stalled at page 2/)]));
  });

  it('fetch() reports a rejected key as a configuration error', async () => {
    const calls = mockDice({ 1: { error: 'unauthorized', description: 'unauthorized', key: 'error_unauthorized' } }, 401);
    // the frontend key rotates with dice.fm deploys, so the message tells the operator to refresh either one
    await expect(dice.fetch(ctx({ DICE_API_KEY: 'stale' }))).rejects.toThrow(/DICE rejected the key \(HTTP 401\).*refresh/);
    expect(calls).toHaveLength(1);
  });
});
