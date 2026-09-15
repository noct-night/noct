import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFeed, FeedParamError, resolveParams } from '../../src/feed/query.js';
import {
  ageLabel, buildDays, feedCacheHeaders, genreDisplay, genreFilterList, moodVibes, shapeEvent, shapeSource,
  sortOffers, texOf,
  type FeedRow, type OfferRow,
} from '../../src/feed/shape.js';
import type pg from 'pg';
import { listingParams, UPSERT_SQL } from '../../src/ingest/persist.js';
import { closePool, getPool, query } from '../../src/lib/db.js';
import { baseListing, type NormalizedListing } from '../../src/sources/types.js';

// Two nights far in the future so nothing collides with real listings. 03:00Z = 23:00 New York (EDT).
const FRI = '2031-04-04';
const SAT = '2031-04-05';
/** Same key as tests/unit/seed_venues.test.ts: upsert_listing() learns venue aliases, which that file counts. */
const VENUE_TABLES_LOCK = 720611;
const UUID = '0f9b4a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

function cannedRow(over: Partial<FeedRow> = {}): FeedRow {
  return {
    event_id: UUID,
    title: 'Dust Till Dawn',
    night: FRI,
    starts_at: '2031-04-05T03:00:00.000Z',
    ends_at: '2031-04-05T10:00:00.000Z',
    has_time: true,
    status: 'scheduled',
    venue_id: 'room-id',
    venue_name: 'Ruins at Knockdown Center',
    venue_kind: 'outdoor',
    family_id: 'complex-id',
    family_name: 'Knockdown Center',
    borough: 'Queens',
    neighborhood: 'Maspeth',
    lat: null,
    lng: null,
    age_min: 21,
    lineup: ['Chaos In The CBD', 'Joe Claussell'],
    description: 'Starts in The Ruins.',
    image_url: 'https://images.ra.co/x.png',
    interested_count: 793,
    genres: ['Deep House', 'House'],
    genre_source: 'ra',
    primary_genre: 'house.deep',
    primary_genre_label: 'Deep House',
    genre_codes: ['house.deep', 'house.disco'],
    genre_labels: ['Deep House', 'Disco / Nu-Disco'],
    genre_tags: [{ code: 'house.deep', label: 'Deep House' }, { code: 'house.disco', label: 'Disco / Nu-Disco' }],
    genre_confidence: '0.80',
    vibe_codes: ['outdoor_yard', 'day_into_night'],
    vibes: [{ code: 'outdoor_yard', label: 'Outdoors', glyph: '🌳', kind: 'space' }, { code: 'day_into_night', label: 'Day into night', glyph: '🌇', kind: 'time' }],
    energy: 4, darkness: 2, crowd_size: 4, start_lateness: 2, end_lateness: 4, price_tier: 2, underground_index: 3,
    sound_summary: 'Deep, dubby house into disco as the sun goes down.',
    is_electronic: true,
    needs_review: false,
    listing_count: 2,
    platforms: ['Resident Advisor', 'DICE'],
    cheapest_price: '38.17',
    sold_out: false,
    sources: [
      { source: 'ra', name: 'Resident Advisor', url: 'https://ra.co/events/2473602' },
      { source: 'dice', name: 'DICE', url: 'https://dice.fm/event/eoxvey' },
    ],
    going_count: 3,
    offers: [
      { platform: 'ra', platform_name: 'Resident Advisor', platform_priority: 90, source_url: 'https://ra.co/events/2473602', tier: 'Early bird', price: '30.00', fees_included: true, available: false, note: null, sold_out: false },
      { platform: 'ra', platform_name: 'Resident Advisor', platform_priority: 90, source_url: 'https://ra.co/events/2473602', tier: 'GA', price: '45.00', fees_included: true, available: true, note: null, sold_out: false },
      { platform: 'dice', platform_name: 'DICE', platform_priority: 80, source_url: 'https://dice.fm/event/eoxvey', tier: 'GA', price: 38.17, fees_included: true, available: true, note: 'Entry before midnight', sold_out: false },
    ],
    ...over,
  };
}

describe('shapeEvent (offline)', () => {
  it('turns an enriched event_feed row into the prototype shape', () => {
    const e = shapeEvent(cannedRow(), { n: 7, d: 1 });
    expect(e).toMatchObject({
      id: UUID, n: 7, d: 1, head: 'Dust Till Dawn',
      venue: 'Knockdown Center', room: 'Ruins at Knockdown Center',
      door: '23:00', close: '06:00',
      genre: ['Deep House', 'Disco / Nu-Disco'], gsrc: 'NOCT tags', primary: 'Deep House',
      genre_codes: ['house.deep', 'house.disco'],
      tags: [{ code: 'house.deep', label: 'Deep House' }, { code: 'house.disco', label: 'Disco / Nu-Disco' }],
      genre_confidence: 0.8,
      sound: 'Deep, dubby house into disco as the sun goes down.',
      age: '21+', interested: 793, full: true, soldout: false, status: 'scheduled',
      ra: 'https://ra.co/events/2473602', dice: 'https://dice.fm/event/eoxvey', eb: '',
      image: 'https://images.ra.co/x.png', going_count: 3,
    });
    expect(e.vibes.map((v) => v.code)).toEqual(['outdoor_yard', 'day_into_night']);
    expect(e.scalars).toEqual({ energy: 4, darkness: 2, crowd_size: 4, start_lateness: 2, end_lateness: 4, price_tier: 2, underground_index: 3 });
    // available first, cheapest first; the sold-out early bird sinks to the bottom with its note
    expect(e.srcs.map((s) => [s[0], s[1]])).toEqual([['DICE', 38.17], ['Resident Advisor', 45], ['Resident Advisor', 30]]);
    expect(e.srcs[0]![2]).toBe('Entry before midnight · On sale');
    expect(e.srcs[2]![2]).toBe('Early bird · Sold out');
    expect(e.srcs[0]![3]).toBe('https://dice.fm/event/eoxvey');
    expect(e.tex).toMatch(/^x[1-6]$/);
    expect(texOf(UUID)).toBe(e.tex);
  });
  it('is null-safe before enrichment: raw source genres, no chips, empty scalars', () => {
    const e = shapeEvent(cannedRow({
      primary_genre: null, primary_genre_label: null, genre_codes: [], genre_labels: null, genre_tags: null, genre_confidence: null,
      vibe_codes: [], vibes: null, energy: null, darkness: null, crowd_size: null, start_lateness: null, end_lateness: null,
      price_tier: null, underground_index: null, sound_summary: null, is_electronic: null,
      genres: ['tech-house', 'Techno'], genre_source: 'dice,ra', offers: null, has_time: false, starts_at: null, lineup: null,
      family_id: 'v', venue_id: 'v', venue_name: 'Nowadays', family_name: 'Nowadays', age_min: null, sold_out: null, going_count: null,
    }));
    expect(e).toMatchObject({ genre: ['Tech house', 'Techno'], gsrc: 'DICE + RA tags', primary: null, genre_codes: [], tags: [], vibes: [], sound: '', age: '', door: '', close: '', full: false, room: null, going_count: 0, is_electronic: null });
    expect(Object.values(e.scalars).every((v) => v === null)).toBe(true);
    // no ticketing offers: one "way in" per source link instead
    expect(e.srcs).toEqual([['Resident Advisor', null, 'See listing', 'https://ra.co/events/2473602'], ['DICE', null, 'See listing', 'https://dice.fm/event/eoxvey']]);
  });
  it('counts a Public Records link.dice.fm short link as a DICE way in', () => {
    const e = shapeEvent(cannedRow({ sources: [{ source: 'publicrecords', name: 'Public Records', url: 'https://link.dice.fm/abc' }], offers: [] }));
    expect(e.dice).toBe('https://link.dice.fm/abc');
    expect(e.ra).toBe('');
    expect(e.url).toBe('https://link.dice.fm/abc');
  });
  it('helpers: ages, genre provenance, filter list, offer ordering', () => {
    expect(ageLabel(21)).toBe('21+');
    expect(ageLabel(0)).toBe('All ages');
    expect(ageLabel(null)).toBe('');
    expect(genreDisplay({ genre_labels: null, primary_genre_label: null, genres: [], genre_source: null })).toEqual({ genre: [], gsrc: '' });
    expect(genreDisplay({ genre_labels: ['Techno'], primary_genre_label: 'Techno', genres: ['x'], genre_source: 'ra' })).toEqual({ genre: ['Techno'], gsrc: 'NOCT tags' });
    const a = shapeEvent(cannedRow(), { n: 1 });
    const b = shapeEvent(cannedRow({ primary_genre_label: 'Techno', genre_labels: ['Techno', 'Deep House'] }), { n: 2 });
    expect(genreFilterList([a, b])).toEqual(['Deep House', 'Disco / Nu-Disco', 'Techno']);
    const offers: OfferRow[] = [
      { platform: 'ra', platform_name: 'RA', platform_priority: 90, source_url: null, tier: 'GA', price: null, fees_included: null, available: null, note: null, sold_out: null },
      { platform: 'dice', platform_name: 'DICE', platform_priority: 80, source_url: null, tier: 'GA', price: 20, fees_included: null, available: false, note: null, sold_out: true },
      { platform: 'tm', platform_name: 'TM', platform_priority: 50, source_url: null, tier: 'GA', price: 25, fees_included: null, available: true, note: null, sold_out: false },
    ];
    expect(sortOffers(offers).map((o) => o.platform)).toEqual(['tm', 'ra', 'dice']);
  });
  it('humanises RA validType tokens in offer notes and keeps other notes verbatim', () => {
    const offer = (over: Partial<OfferRow>): OfferRow => ({ platform: 'ra', platform_name: 'Resident Advisor', platform_priority: 90, source_url: 'https://ra.co/events/1', tier: 'GA', price: 20, fees_included: true, available: true, note: null, sold_out: false, ...over });
    const notes = shapeEvent(cannedRow({ offers: [
      offer({ tier: 'Early bird', available: false, note: 'NOLONGERONSALE', price: 10 }),
      offer({ tier: '2nd release', available: false, note: 'SOLDOUT', price: 15 }),
      offer({ tier: 'Final release', available: true, note: 'VALID', price: 20 }),
      offer({ tier: 'Door', available: false, note: 'NOTYETONSALE', price: 25 }),
      offer({ platform: 'dice', platform_name: 'DICE', platform_priority: 80, available: false, note: 'Entry before midnight', price: 18 }),
    ] })).srcs.map((s) => s[2]);
    // available first, then cheapest first; an expired tier is "no longer on sale", not "sold out"
    expect(notes).toEqual(['Final release · On sale', 'Early bird · No longer on sale', '2nd release · Sold out', 'Entry before midnight · Sold out', 'Door · Not yet on sale']);
  });
  it('buildDays labels the strip relative to New York now', () => {
    const now = new Date('2031-04-04T20:00:00Z'); // Friday 16:00 New York
    const days = buildDays(FRI, '2031-04-06', now);
    expect(days.map((d) => [d.date, d.label, d.sub, d.hint])).toEqual([
      [FRI, 'Fri', 'Apr 4', 'Tonight'],
      [SAT, 'Sat', 'Apr 5', 'Tomorrow'],
      ['2031-04-06', 'Sun', 'Apr 6', 'Sunday'],
    ]);
    expect(days[0]!.dow).toBe(5);
    expect(buildDays('nope', FRI)).toEqual([]);
  });
  it('shapeSource reports the last run or null', () => {
    expect(shapeSource({ source_key: 'ra', display_name: 'Resident Advisor', enabled: true, status: 'ok', finished_at: '2026-09-13T10:00:00Z', listings_seen: 12, error: null }))
      .toEqual({ key: 'ra', name: 'Resident Advisor', last_run: { status: 'ok', finished_at: '2026-09-13T10:00:00.000Z', seen: 12, error: null } });
    expect(shapeSource({ source_key: 'dice', display_name: 'DICE', enabled: true, status: null, finished_at: null, listings_seen: null, error: null }).last_run).toBeNull();
  });
  it('feedCacheHeaders match the edge policy', () => {
    expect(feedCacheHeaders()).toEqual({
      'cache-control': 'public, s-maxage=300, stale-while-revalidate=900',
      'vercel-cdn-cache-control': 's-maxage=300',
    });
  });
});

describe('resolveParams (offline)', () => {
  const now = new Date('2026-09-13T20:00:00Z'); // Sunday 16:00 New York
  it('defaults to today..today+2 in New York', () => {
    expect(resolveParams({}, now)).toMatchObject({ from: '2026-09-13', to: '2026-09-15', area: null, includeAll: false, city: { key: 'nyc' } });
    expect(resolveParams({ from: '2026-12-30' }, now).to).toBe('2027-01-01');
    // 01:00Z Monday is still Sunday evening in New York
    expect(resolveParams({}, new Date('2026-09-14T01:00:00Z')).from).toBe('2026-09-13');
  });
  it('normalises area and city, rejects nonsense', () => {
    expect(resolveParams({ area: 'brooklyn', city: 'NYC' }, now).area).toBe('Brooklyn');
    expect(resolveParams({ area: 'All' }, now).area).toBeNull();
    expect(() => resolveParams({ area: 'Hoboken' }, now)).toThrow(FeedParamError);
    expect(resolveParams({ city: 'la' }, now).city.key).toBe('la');          // served since 0011
    expect(() => resolveParams({ city: 'atlantis' }, now)).toThrow(FeedParamError);
    expect(() => resolveParams({ from: '2026-02-30' }, now)).toThrow(FeedParamError);
    expect(() => resolveParams({ from: '2026-09-15', to: '2026-09-14' }, now)).toThrow(/before/);
    expect(() => resolveParams({ from: '2026-09-01', to: '2026-10-15' }, now)).toThrow(/at most/);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('buildFeed against Postgres', () => {
  const TAG = 'feedtest-';
  let runId = 0;

  function listings(): NormalizedListing[] {
    const fri = { hasTime: true, night: FRI, startsAt: '2031-04-05T03:00:00.000Z', endsAt: '2031-04-05T10:00:00.000Z', venueName: 'Nowadays' };
    return [
      baseListing({
        ...fri, source: 'ra', sourceId: `${TAG}ra-1`, sourceUrl: 'https://ra.co/events/feedtest1', raw: { id: 'ra1' },
        title: 'Feed Test: Nowadays All Night', venueSourceId: '105873', lineup: ['Feed Tester', 'DJ Alpha b2b DJ Beta'],
        priceMin: 15, priceMax: 25, feesIncluded: true, soldOut: false, ageMin: 21, genres: ['Techno', 'Electro'], interestedCount: 321,
        description: 'A test night.', imageUrl: 'https://images.example/feed.png',
        prices: [
          { tier: 'Early bird', price: 15, feesIncluded: true, available: false, note: null },
          { tier: 'GA', price: 25, feesIncluded: true, available: true, note: null },
        ],
      }),
      // same night, same room, hard-linked to the RA id -> must land on the same event
      baseListing({
        ...fri, source: 'dice', sourceId: `${TAG}dice-1`, sourceUrl: 'https://dice.fm/event/feedtest1', raw: { id: 'd1' },
        title: 'Feed Test: Nowadays All Night', lineup: ['Feed Tester'], priceMin: 22.66, priceMax: 22.66, feesIncluded: true,
        genres: ['techno', 'dub'], externalRefs: [{ source: 'ra', id: `${TAG}ra-1` }],
        prices: [{ tier: 'GA', price: 22.66, feesIncluded: true, available: true, note: null }],
      }),
      // venue calendar, date only, not a ticketer -> second night, no offers
      baseListing({
        source: 'goodroom', sourceId: `${TAG}gr-1`, sourceUrl: 'http://www.goodroombk.com/events/feedtest', raw: { id: 'g1' },
        title: 'Feed Test: Good Room Saturday', hasTime: false, night: SAT, venueName: 'Good Room',
      }),
      // RA says NOT sold out (soldOut=false) although its only tier expired (NOLONGERONSALE, available=false):
      // the ticketer's verdict wins over "every offer unavailable"
      baseListing({
        source: 'ra', sourceId: `${TAG}ra-2`, sourceUrl: 'https://ra.co/events/feedtest2', raw: { id: 'ra2' },
        title: 'Feed Test: Basement Late Shift', hasTime: true, night: SAT, startsAt: '2031-04-06T03:00:00.000Z', endsAt: '2031-04-06T10:00:00.000Z',
        venueName: 'BASEMENT', venueSourceId: '165976', lineup: ['Feed Tester'], priceMin: 20, priceMax: 20, feesIncluded: true, soldOut: false,
        prices: [{ tier: 'Early bird', price: 20, feesIncluded: true, available: false, note: 'NOLONGERONSALE' }],
      }),
      // no verdict from the source (soldOut=null) and every offer unavailable -> the fallback calls it sold out
      baseListing({
        source: 'dice', sourceId: `${TAG}dice-2`, sourceUrl: 'https://dice.fm/event/feedtest2', raw: { id: 'd2' },
        title: 'Feed Test: Signal Closing Party', hasTime: true, night: SAT, startsAt: '2031-04-06T02:00:00.000Z', endsAt: '2031-04-06T09:00:00.000Z',
        venueName: 'Signal', lineup: ['Feed Tester'], priceMin: 30, priceMax: 30, feesIncluded: true,
        prices: [{ tier: 'GA', price: 30, feesIncluded: true, available: false, note: null }],
      }),
    ];
  }

  async function cleanup(): Promise<void> {
    const ev = await query<{ event_id: string }>('select distinct event_id from listing where source_id like $1 and event_id is not null', [`${TAG}%`]);
    await query('delete from listing where source_id like $1', [`${TAG}%`]);
    if (ev.rows.length) await query('delete from event where event_id = any($1::uuid[])', [ev.rows.map((r) => r.event_id)]);
    await query(`delete from ingest_run where trigger = 'feedtest'`);
  }

  let lock: pg.PoolClient | undefined;

  beforeAll(async () => {
    lock = await getPool().connect();
    await lock.query('select pg_advisory_lock($1)', [VENUE_TABLES_LOCK]);
    await cleanup();
    const run = await query<{ run_id: string }>(
      `insert into ingest_run (source_key, status, finished_at, listings_seen, window_start, window_end, trigger)
       values ('ra', 'ok', now(), 5, $1, $2, 'feedtest') returning run_id`, [FRI, SAT]);
    runId = Number(run.rows[0]!.run_id);
    for (const l of listings()) await query(UPSERT_SQL, listingParams(l, runId));
    await query('select resolve_pending()');
  });
  afterAll(async () => {
    await cleanup();
    await lock?.query('select pg_advisory_unlock($1)', [VENUE_TABLES_LOCK]);
    lock?.release();
    await closePool();
  });

  it('returns days, venues and numbered events for the two nights', async () => {
    const now = new Date('2031-04-04T20:00:00Z');
    const feed = await buildFeed({ from: FRI, to: SAT, now });
    expect(feed.range).toEqual({ from: FRI, to: SAT });
    expect(feed.days.map((d) => [d.date, d.label, d.hint])).toEqual([[FRI, 'Fri', 'Tonight'], [SAT, 'Sat', 'Tomorrow']]);
    const ours = feed.events.filter((e) => e.head.startsWith('Feed Test'));
    // RA + DICE merged into one event; nights in order, timed events first within a night, then by start time
    expect(ours.map((e) => e.head)).toEqual(['Feed Test: Nowadays All Night', 'Feed Test: Signal Closing Party', 'Feed Test: Basement Late Shift', 'Feed Test: Good Room Saturday']);
    // numeric n is the 1-based position in the whole response
    expect(feed.events.map((e) => e.n)).toEqual(feed.events.map((_, i) => i + 1));
    const [a, sig, bsmt, b] = ours as [typeof ours[0], typeof ours[0], typeof ours[0], typeof ours[0]];
    // sold_out: the ticketer's own verdict beats "every offer unavailable"; the fallback applies only without a verdict
    expect(bsmt).toMatchObject({ d: 1, venue: 'BASEMENT', door: '23:00', soldout: false });
    expect(bsmt.srcs).toEqual([['Resident Advisor', 20, 'Early bird · No longer on sale', 'https://ra.co/events/feedtest2']]);
    expect(sig).toMatchObject({ d: 1, venue: 'Signal', door: '22:00', soldout: true });
    expect(sig.srcs).toEqual([['DICE', 30, 'Sold out', 'https://dice.fm/event/feedtest2']]);
    expect(a).toMatchObject({ d: 0, venue: 'Nowadays', room: null, door: '23:00', close: '06:00', age: '21+', interested: 321, full: true, soldout: false, status: 'scheduled', note: 'A test night.', image: 'https://images.example/feed.png' });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.lineup).toEqual(['Feed Tester', 'DJ Alpha b2b DJ Beta']);
    expect(a.genre).toEqual(expect.arrayContaining(['Techno', 'Electro', 'Dub']));
    expect(a.gsrc).toBe('DICE + RA tags');
    expect(a.ra).toBe('https://ra.co/events/feedtest1');
    expect(a.dice).toBe('https://dice.fm/event/feedtest1');
    expect(a.platforms).toEqual(['Resident Advisor', 'DICE']);
    // offers: available first, cheapest first; the sold-out early bird last
    expect(a.srcs.map((s) => [s[0], s[1]])).toEqual([['DICE', 22.66], ['Resident Advisor', 25], ['Resident Advisor', 15]]);
    expect(a.srcs[2]![2]).toMatch(/Sold out/);
    // chip fields exist and are empty until enrichment runs
    expect(a.primary).toBeNull();
    expect(a.genre_codes).toEqual([]);
    expect(a.tags).toEqual([]);
    expect(a.vibes).toEqual([]);
    expect(a.sound).toBe('');
    expect(Object.keys(a.scalars).sort()).toEqual(['crowd_size', 'darkness', 'end_lateness', 'energy', 'price_tier', 'start_lateness', 'underground_index']);
    expect(a.tex).toMatch(/^x[1-6]$/);
    expect(a.going_count).toBe(0);
    // the date-only venue-calendar listing: second night, no time, one "way in" that is not an offer
    expect(b).toMatchObject({ d: 1, venue: 'Good Room', door: '', close: '', full: false, age: '' });
    expect(b.srcs).toEqual([['Good Room', null, 'See listing', 'http://www.goodroombk.com/events/feedtest']]);
    expect(b.ra).toBe('');
    // venues keyed by the event's venue label, with the seeded record
    expect(feed.venues['Nowadays']).toMatchObject({ addr: '56-06 Cooper Ave, Ridgewood, NY 11385', hood: 'Ridgewood', boro: 'Queens', ig: 'nowadaysnyc', ra: 'https://ra.co/clubs/105873', verified: true });
    expect(feed.venues['Good Room']).toMatchObject({ boro: 'Brooklyn', hood: 'Greenpoint' });
    expect(feed.venues['BASEMENT']).toMatchObject({ boro: 'Queens', hood: 'Maspeth', verified: true });
    expect(feed.genres).toEqual(expect.arrayContaining(['Techno', 'Electro']));
    expect(new Set(feed.genres).size).toBe(feed.genres.length);
    // every configured source is listed; our run row is the newest for RA
    expect(feed.sources.map((s) => s.key)).toEqual(expect.arrayContaining(['ra', 'dice', 'elsewhere', 'goodroom', 'publicrecords', 'ticketmaster', 'edmtrain']));
    expect(feed.sources.find((s) => s.key === 'ra')?.last_run).toMatchObject({ status: 'ok', seen: 5, error: null });
    expect(Date.parse(feed.generated_at)).not.toBeNaN();
  });

  it('filters by area and keeps n contiguous', async () => {
    const queens = await buildFeed({ from: FRI, to: SAT, area: 'queens' });
    expect(queens.events.filter((e) => e.head.startsWith('Feed Test')).map((e) => e.venue)).toEqual(['Nowadays', 'BASEMENT']);
    expect(queens.events.map((e) => e.n)).toEqual(queens.events.map((_, i) => i + 1));
    const bk = await buildFeed({ from: FRI, to: SAT, area: 'Brooklyn' });
    expect(bk.events.filter((e) => e.head.startsWith('Feed Test')).map((e) => e.venue)).toEqual(['Signal', 'Good Room']);
    const mh = await buildFeed({ from: FRI, to: SAT, area: 'Manhattan' });
    expect(mh.events.filter((e) => e.head.startsWith('Feed Test'))).toEqual([]);
  });

  it('excludes nights outside the range', async () => {
    const only = await buildFeed({ from: SAT, to: SAT });
    expect(only.days).toHaveLength(1);
    expect(only.events.filter((e) => e.head.startsWith('Feed Test')).map((e) => e.venue)).toEqual(['Signal', 'BASEMENT', 'Good Room']);
    await expect(buildFeed({ from: SAT, to: FRI })).rejects.toBeInstanceOf(FeedParamError);
  });
});

describe('vibes are moods, not door policy', () => {
  const v = (code: string, kind: string, label: string) => ({ code, kind, label, glyph: '' }) as never;

  it('drops the paperwork and keeps the room', () => {
    // 21+ was the most-assigned vibe in the city (1,098 events) and is already its own row in the sheet
    const out = moodVibes([
      v('21_plus', 'policy', '21+'),
      v('free_rsvp', 'policy', 'Free / RSVP'),
      v('underground', 'crowd', 'Underground'),
      v('dark_warehouse', 'space', 'Warehouse'),
    ]);
    expect(out.map((x) => x.label)).toEqual(['Underground', 'Warehouse']);
  });

  it('keeps the two policies that describe the room rather than the door', () => {
    const out = moodVibes([v('phone_free', 'policy', 'Phone-free'), v('dress_code', 'policy', 'Dress code')]);
    expect(out.map((x) => x.label)).toEqual(['Phone-free']);
  });

  it('orders crowd, then space, then format, then time', () => {
    const out = moodVibes([
      v('all_nighter', 'time', 'All night'),
      v('live_act', 'format', 'Live'),
      v('rooftop', 'space', 'Rooftop'),
      v('queer_party', 'crowd', 'Queer'),
    ]);
    expect(out.map((x) => x.label)).toEqual(['Queer', 'Rooftop', 'Live', 'All night']);
  });

  it('survives an empty or missing list', () => {
    expect(moodVibes(null)).toEqual([]);
    expect(moodVibes([])).toEqual([]);
  });
});
