import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/lib/log.js';
import {
  TM_MAX_ITEMS,
  TM_MAX_PAGES,
  TM_NYC_DMA_ID,
  TM_PAGE_SIZE,
  buildTmUrl,
  mapTmStatus,
  parseTmEvents,
  pickImage,
  planWindows,
  redactTmUrl,
  skipWarnings,
  splitDateRange,
  ticketmaster,
  ticketmasterEnabled,
  tmDateRange,
  tmGenres,
  toPriceTiers,
  type TmEvent,
  type TmEventsResponse,
} from '../../src/sources/ticketmaster.js';

/**
 * Hand-written to the official Discovery API v2 response schema (no TICKETMASTER_API_KEY was available to capture
 * live). Ids, URLs and artists are synthetic; venues are real NYC-DMA rooms so the state filter is exercised.
 */
const fixture = JSON.parse(readFileSync(new URL('../fixtures/ticketmaster_events_sample.json', import.meta.url), 'utf8')) as TmEventsResponse;

describe('ticketmaster: enabled()', () => {
  it('needs only the consumer key', () => {
    expect(ticketmasterEnabled({})).toEqual({ ok: false, reason: 'TICKETMASTER_API_KEY is not set' });
    expect(ticketmasterEnabled({ TICKETMASTER_API_KEY: '' })).toEqual({ ok: false, reason: 'TICKETMASTER_API_KEY is not set' });
    expect(ticketmasterEnabled({ TICKETMASTER_API_KEY: 'k' })).toEqual({ ok: true });
    expect(ticketmaster.enabled).toBe(ticketmasterEnabled);
  });
});

describe('ticketmaster: request URL', () => {
  it('carries the documented parameters and encodes the classification slash', () => {
    const raw = buildTmUrl({ key: 'consumer-key', startDateTime: '2026-09-13T10:00:00Z', endDateTime: '2026-10-14T09:59:59Z', page: 2 });
    expect(raw).toContain('classificationName=Dance%2FElectronic');
    const url = new URL(raw);
    expect(url.origin + url.pathname).toBe('https://app.ticketmaster.com/discovery/v2/events.json');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      apikey: 'consumer-key',
      dmaId: String(TM_NYC_DMA_ID),
      classificationName: 'Dance/Electronic',
      startDateTime: '2026-09-13T10:00:00Z',
      endDateTime: '2026-10-14T09:59:59Z',
      size: String(TM_PAGE_SIZE),
      page: '2',
      sort: 'date,asc',
    });
  });
  it('redacts the key for logs', () => {
    const red = redactTmUrl(buildTmUrl({ key: 'consumer-key', startDateTime: 'a', endDateTime: 'b', page: 0 }));
    expect(red).not.toContain('consumer-key');
    expect(red).toContain('apikey=***&dmaId=');
  });
});

describe('ticketmaster: date range (New York nights -> UTC instants without millis)', () => {
  it('EDT: 06:00 local on fromDate to 05:59:59 local the morning after toDate', () => {
    expect(tmDateRange('2026-09-13', '2026-10-13')).toEqual({ startDateTime: '2026-09-13T10:00:00Z', endDateTime: '2026-10-14T09:59:59Z' });
  });
  it('EST', () => {
    expect(tmDateRange('2026-12-01', '2026-12-07')).toEqual({ startDateTime: '2026-12-01T11:00:00Z', endDateTime: '2026-12-08T10:59:59Z' });
  });
  it('spanning the November fall-back keeps each bound in its own offset', () => {
    expect(tmDateRange('2026-10-30', '2026-11-02')).toEqual({ startDateTime: '2026-10-30T10:00:00Z', endDateTime: '2026-11-03T10:59:59Z' });
  });
  it('a single night', () => {
    expect(tmDateRange('2026-09-13', '2026-09-13')).toEqual({ startDateTime: '2026-09-13T10:00:00Z', endDateTime: '2026-09-14T09:59:59Z' });
  });
});

describe('ticketmaster: window splitting (size * page < 1000)', () => {
  it('splits 30 nights into contiguous 7-night windows with a short tail', () => {
    expect(splitDateRange('2026-09-13', '2026-10-12', 7)).toEqual([
      { fromDate: '2026-09-13', toDate: '2026-09-19' },
      { fromDate: '2026-09-20', toDate: '2026-09-26' },
      { fromDate: '2026-09-27', toDate: '2026-10-03' },
      { fromDate: '2026-10-04', toDate: '2026-10-10' },
      { fromDate: '2026-10-11', toDate: '2026-10-12' },
    ]);
  });
  it('a range shorter than the step is one window; a single night is one window', () => {
    expect(splitDateRange('2026-09-13', '2026-09-15', 7)).toEqual([{ fromDate: '2026-09-13', toDate: '2026-09-15' }]);
    expect(splitDateRange('2026-09-13', '2026-09-13', 7)).toEqual([{ fromDate: '2026-09-13', toDate: '2026-09-13' }]);
  });
  it('crosses month and DST boundaries by calendar day', () => {
    const w = splitDateRange('2026-10-28', '2026-11-12', 7);
    expect(w).toEqual([
      { fromDate: '2026-10-28', toDate: '2026-11-03' },
      { fromDate: '2026-11-04', toDate: '2026-11-10' },
      { fromDate: '2026-11-11', toDate: '2026-11-12' },
    ]);
  });
  it('planWindows keeps one window up to the ceiling and splits above it', () => {
    expect(TM_MAX_ITEMS).toBe(1000);
    expect(planWindows('2026-09-13', '2026-10-12', 1000)).toEqual([{ fromDate: '2026-09-13', toDate: '2026-10-12' }]);
    expect(planWindows('2026-09-13', '2026-10-12', 0)).toHaveLength(1);
    expect(planWindows('2026-09-13', '2026-10-12', 1001)).toHaveLength(5);
  });
});

describe('ticketmaster: small mappers', () => {
  it('mapTmStatus accepts the docs spelling "canceled" and the British one', () => {
    expect(mapTmStatus('canceled')).toBe('cancelled');
    expect(mapTmStatus('cancelled')).toBe('cancelled');
    expect(mapTmStatus('postponed')).toBe('postponed');
    expect(mapTmStatus('rescheduled')).toBe('rescheduled');
    expect(mapTmStatus('onsale')).toBe('scheduled');
    expect(mapTmStatus('offsale')).toBe('scheduled');
    expect(mapTmStatus(undefined)).toBe('scheduled');
  });
  it('tmGenres dedupes genre/sub-genre and drops "Undefined"', () => {
    expect(tmGenres({ genre: { name: 'Dance/Electronic' }, subGenre: { name: 'House' } })).toEqual(['Dance/Electronic', 'House']);
    expect(tmGenres({ genre: { name: 'Dance/Electronic' }, subGenre: { name: 'Dance/Electronic' } })).toEqual(['Dance/Electronic']);
    expect(tmGenres({ genre: { name: 'Dance/Electronic' }, subGenre: { name: 'Undefined' } })).toEqual(['Dance/Electronic']);
    expect(tmGenres(undefined)).toEqual([]);
  });
  it('pickImage prefers the largest genuine 16:9, then any ratio, then fallback art', () => {
    expect(pickImage([
      { ratio: '3_2', url: 'wide-3-2', width: 2048 },
      { ratio: '16_9', url: 'small', width: 640 },
      { ratio: '16_9', url: 'big', width: 1136 },
    ])).toBe('big');
    expect(pickImage([{ ratio: '3_2', url: 'only', width: 1024 }])).toBe('only');
    expect(pickImage([{ ratio: '16_9', url: 'generic', width: 2048, fallback: true }, { ratio: '16_9', url: 'own', width: 640 }])).toBe('own');
    expect(pickImage([{ ratio: '16_9', url: 'generic', width: 2048, fallback: true }])).toBe('generic');
    expect(pickImage([])).toBeNull();
    expect(pickImage(undefined)).toBeNull();
  });
  it('toPriceTiers keeps tier names unique and reads fees from the type', () => {
    const tiers = toPriceTiers([
      { type: 'standard', currency: 'USD', min: 20, max: 40 },
      { type: 'standard', currency: 'USD', min: 25, max: 25 },
      { type: 'standard including fees', currency: 'USD', min: 26.5, max: 48.2 },
      { currency: 'USD', min: 10 },
    ], 'onsale');
    expect(tiers.map((t) => t.tier)).toEqual(['standard', 'standard 2', 'standard including fees', 'standard 3']);
    expect(tiers[0]).toEqual({ tier: 'standard', price: 20, feesIncluded: false, available: true, note: 'up to $40' });
    expect(tiers[1]?.note).toBeNull();
    expect(tiers[2]?.feesIncluded).toBe(true);
    expect(tiers[3]).toMatchObject({ price: 10, note: null });
    expect(toPriceTiers([{ type: 'standard', min: 5, max: 9 }], 'offsale')[0]?.available).toBe(false);
    expect(toPriceTiers(undefined, 'onsale')).toEqual([]);
  });
});

describe('ticketmaster: parse (fixture)', () => {
  const { listings, skipped, page } = parseTmEvents(fixture);
  const by = (id: string) => listings.find((l) => l.sourceId === id)!;

  it('keeps the five NY/NJ music events and counts the rest', () => {
    expect(page).toEqual({ size: 200, totalElements: 7, totalPages: 1, number: 0 });
    expect(listings.map((l) => l.sourceId)).toEqual(['vvG1HZb8Lk0Qxa', 'Z7r9jZ1A7eKfR', 'vvG1HZb9pQ3Wtb', 'Z7r9jZ1AdF9kK', 'vvG1HZb2mN8Rcc']);
    expect(skipped).toEqual({ 'venue in CT (outside NY/NJ)': 1, 'primary segment "Arts & Theatre" is not Music': 1 });
    expect(skipWarnings(skipped)).toEqual(['skipped 1 event(s): venue in CT (outside NY/NJ)', 'skipped 1 event(s): primary segment "Arts & Theatre" is not Music']);
  });

  it('maps a fully populated on-sale event', () => {
    const l = by('vvG1HZb8Lk0Qxa');
    expect(l).toMatchObject({
      source: 'ticketmaster',
      sourceUrl: 'https://www.ticketmaster.com/vela-ortiz-night-signal-tour-brooklyn-new-york-10-02-2026/event/3B006315A7A21C4B',
      title: 'Vela Ortiz: Night Signal Tour',
      startsAt: '2026-10-03T02:00:00.000Z',
      endsAt: null,
      hasTime: true,
      night: '2026-10-02',
      venueName: 'Brooklyn Steel',
      venueAddress: '319 Frost Street, Brooklyn, NY 11222',
      venueSourceId: 'KovZpZAJledA',
      venueLat: 40.71773,
      venueLng: -73.93634,
      lineup: ['Vela Ortiz', 'Dusk Protocol'],
      priceMin: 39.5,
      priceMax: 71.85,
      currency: 'USD',
      feesIncluded: null,
      soldOut: null,
      status: 'scheduled',
      ageMin: 21,
      genres: ['Dance/Electronic', 'House'],
      promoters: ['LIVE NATION MUSIC'],
      externalRefs: [],
      imageUrl: 'https://s1.ticketm.net/dam/a/1f3/0d2e3a1b-1f3a-4c8e-9b1e-6a3f2c8e0001_RETINA_LANDSCAPE_16_9.jpg',
      description: 'Doors 10PM. 21+ with valid photo ID.\n\nAll sales final. No re-entry.',
    });
    expect(l.raw).toBe(fixture._embedded!.events![0]);
    expect(l.prices).toEqual([
      { tier: 'standard including fees', price: 47.35, feesIncluded: true, available: true, note: 'up to $71.85' },
      { tier: 'standard', price: 39.5, feesIncluded: false, available: true, note: 'up to $59.5' },
    ]);
    expect(l.sourceTags).toEqual({
      tm_segment: 'Music',
      tm_genre: 'Dance/Electronic',
      tm_subgenre: 'House',
      tm_status: 'onsale',
      tm_attraction_ids: ['K8vZ917GkX7', 'K8vZ917bQe0'],
      tm_local_date: '2026-10-02',
      tm_local_time: '22:00:00',
      tm_timezone: 'America/New_York',
    });
  });

  it('a canceled event maps to "cancelled" and skips fallback artwork', () => {
    const l = by('Z7r9jZ1A7eKfR');
    expect(l.status).toBe('cancelled');
    expect(l.night).toBe('2026-10-03');
    expect(l.imageUrl).toBe('https://s1.ticketm.net/dam/a/2c9/9d1b1a6e-2c9f-4a5e-8f3b-2e0d3c7a02c9_RETINA_PORTRAIT_16_9.jpg');
    expect(l.prices).toEqual([{ tier: 'standard', price: 45, feesIncluded: false, available: true, note: null }]);
    expect(l.priceMin).toBe(45);
    expect(l.priceMax).toBe(45);
    expect(l.feesIncluded).toBe(false);
    expect(l.genres).toEqual(['Dance/Electronic']);
    expect(l.lineup).toEqual(['Marrow & Lune']);
    expect(l.ageMin).toBeNull();
  });

  it('timeTBA: no instant, night from localDate, nothing invented', () => {
    const l = by('vvG1HZb9pQ3Wtb');
    expect(l.startsAt).toBeNull();
    expect(l.hasTime).toBe(false);
    expect(l.night).toBe('2026-10-10');
    expect(l.prices).toEqual([]);
    expect(l.priceMin).toBeNull();
    expect(l.feesIncluded).toBeNull();
    expect(l.lineup).toEqual([]);
    expect(l.promoters).toEqual([]);
    expect(l.genres).toEqual(['Dance/Electronic']);
    expect(l.ageMin).toBeNull();
    expect(l.description).toBeNull();
  });

  it('offsale keeps the event scheduled but marks tiers unavailable; a written age rule wins', () => {
    const l = by('Z7r9jZ1AdF9kK');
    expect(l.status).toBe('scheduled');
    expect(l.sourceTags.tm_status).toBe('offsale');
    expect(l.prices[0]?.available).toBe(false);
    expect(l.ageMin).toBe(18);
    expect(l.genres).toEqual(['Dance/Electronic', 'Techno']);
    expect(l.night).toBe('2026-10-10');
  });

  it('keeps New Jersey rooms and maps postponed 1:1', () => {
    const l = by('vvG1HZb2mN8Rcc');
    expect(l.status).toBe('postponed');
    expect(l.venueAddress).toBe('570 Jernee Mill Road, Sayreville, NJ 08872');
    expect(l.night).toBe('2026-10-11');
    // no 16:9 artwork: largest of any ratio
    expect(l.imageUrl).toMatch(/_3_2\.jpg$/);
  });
});

describe('ticketmaster: parse edge cases', () => {
  const base = fixture._embedded!.events![0]!;
  it('tolerates an empty page', () => {
    expect(parseTmEvents({ page: { size: 200, totalElements: 0, totalPages: 0, number: 0 } })).toEqual({ listings: [], skipped: {}, page: { size: 200, totalElements: 0, totalPages: 0, number: 0 } });
    expect(parseTmEvents({})).toEqual({ listings: [], skipped: {}, page: null });
  });
  it('skips test events, nameless events and events with no usable date', () => {
    const { listings, skipped } = parseTmEvents({
      _embedded: {
        events: [
          { ...base, id: 't1', test: true },
          { ...base, id: 't2', name: '  ' },
          { ...base, id: 't3', dates: { start: { dateTBD: true }, status: { code: 'onsale' } } },
          { ...base, id: 't4', dates: { start: { localDate: '2026-10-20', timeTBA: true, dateTime: '2026-10-20T04:00:00Z' } } },
        ],
      },
    });
    expect(listings.map((l) => l.sourceId)).toEqual(['t4']);
    // timeTBA with a placeholder dateTime: the date is trusted, the time is not
    expect(listings[0]).toMatchObject({ hasTime: false, startsAt: null, night: '2026-10-20' });
    expect(skipped).toEqual({ 'test event': 1, 'missing id or name': 1, 'no usable start date (dateTBD/dateTBA)': 1 });
  });
  it('keeps an event whose venue has no state code (DMA already scopes it)', () => {
    const { listings } = parseTmEvents({ _embedded: { events: [{ ...base, id: 'v1', _embedded: { venues: [{ id: 'x', name: 'Somewhere' }] } }] } });
    expect(listings[0]).toMatchObject({ venueName: 'Somewhere', venueAddress: null, venueLat: null, venueLng: null });
  });
  it('legalAgeEnforced alone means 21+', () => {
    const { listings } = parseTmEvents({ _embedded: { events: [{ ...base, id: 'a1', ageRestrictions: { legalAgeEnforced: true } }, { ...base, id: 'a2', ageRestrictions: { legalAgeEnforced: false } }, { ...base, id: 'a3', ageRestrictions: undefined }] } });
    expect(listings.map((l) => l.ageMin)).toEqual([21, null, null]);
  });
  it('falls back to the first classification when none is flagged primary', () => {
    const { listings } = parseTmEvents({ _embedded: { events: [{ ...base, id: 'c1', classifications: [{ segment: { name: 'Music' }, genre: { name: 'Dance/Electronic' }, subGenre: { name: 'Trance' } }] }] } });
    expect(listings[0]?.genres).toEqual(['Dance/Electronic', 'Trance']);
  });
});

describe('ticketmaster: adapter metadata', () => {
  it('matches the source table row', () => {
    expect(ticketmaster).toMatchObject({ key: 'ticketmaster', kind: 'api', priority: 50, feesIncludedDefault: false });
    expect(ticketmaster.tosNote).toMatch(/5000 calls\/day/);
  });
});

describe('ticketmaster: fetch orchestration (stubbed network)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const silent: Logger = { info() {}, warn() {}, error() {}, child: () => silent };
  const ctx = (over: { limit?: number; fromDate?: string; toDate?: string } = {}) => ({
    env: { TICKETMASTER_API_KEY: 'consumer-key' },
    log: silent,
    fromDate: over.fromDate ?? '2026-09-13',
    toDate: over.toDate ?? '2026-09-26',
    limit: over.limit,
  });
  const base = fixture._embedded!.events![0]!;
  /** n on-sale Brooklyn Steel events with distinct ids and start instants. */
  const events = (n: number, tag: string): TmEvent[] =>
    Array.from({ length: n }, (_, i) => ({
      ...base,
      id: `${tag}-${i}`,
      dates: { ...base.dates, start: { ...base.dates!.start, dateTime: new Date(Date.UTC(2026, 8, 14, 1, i % 60)).toISOString() } },
    }));
  const page = (evs: TmEvent[], totalElements: number, number: number): TmEventsResponse => ({
    _embedded: { events: evs },
    page: { size: TM_PAGE_SIZE, totalElements, totalPages: Math.ceil(totalElements / TM_PAGE_SIZE), number },
  });
  /** "start/end" key of a query range, so a week that shares its start (or end) with the full range is told apart. */
  const rangeKey = (fromDate: string, toDate: string): string => {
    const r = tmDateRange(fromDate, toDate);
    return `${r.startDateTime}/${r.endDateTime}`;
  };

  /** Stub global fetch; `answer` maps (rangeKey, page) to a body or an HTTP status. Returns recorded calls. */
  function mockTm(answer: (range: string, pageNo: number) => TmEventsResponse | number) {
    const calls: URLSearchParams[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const q = new URL(String(input)).searchParams;
        calls.push(q);
        const a = answer(`${q.get('startDateTime')}/${q.get('endDateTime')}`, Number(q.get('page')));
        if (typeof a === 'number') return new Response(JSON.stringify({ fault: { faultstring: 'nope' } }), { status: a });
        return new Response(JSON.stringify(a), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    return calls;
  }

  it('walks every page of a range that fits under the ceiling and promises the whole window', async () => {
    const evs = events(300, 'a');
    const calls = mockTm((_s, p) => page(evs.slice(p * TM_PAGE_SIZE, (p + 1) * TM_PAGE_SIZE), 300, p));
    const res = await ticketmaster.fetch(ctx());
    expect(calls.map((q) => q.get('page'))).toEqual(['0', '1']);
    expect(calls[0]!.get('apikey')).toBe('consumer-key');
    expect(calls[0]!.get('startDateTime')).toBe('2026-09-13T10:00:00Z');
    expect(calls[0]!.get('endDateTime')).toBe('2026-09-27T09:59:59Z');
    expect(res.listings).toHaveLength(300);
    expect(new Set(res.listings.map((l) => l.sourceId)).size).toBe(300);
    expect(res.window).toEqual({ start: '2026-09-13', end: '2026-09-26' });
    expect(res.warnings).toEqual([]);
  });

  it('re-queries in 7-night windows when the probe reports more than 1000 events', async () => {
    // week A shares its startDateTime with the full-range probe, so the mock must key on the whole range
    const weekA = rangeKey('2026-09-13', '2026-09-19');
    const weekB = rangeKey('2026-09-20', '2026-09-26');
    const calls = mockTm((r, p) => {
      if (r === weekA) return page(events(3, 'wa'), 3, p);
      if (r === weekB) return page(events(2, 'wb'), 2, p);
      return page(events(200, 'probe'), 1200, p); // the full-range probe
    });
    const res = await ticketmaster.fetch(ctx());
    expect(calls.map((q) => [q.get('startDateTime'), q.get('endDateTime'), q.get('page')])).toEqual([
      ['2026-09-13T10:00:00Z', '2026-09-27T09:59:59Z', '0'],
      ['2026-09-13T10:00:00Z', '2026-09-20T09:59:59Z', '0'],
      ['2026-09-20T10:00:00Z', '2026-09-27T09:59:59Z', '0'],
    ]);
    // probe rows are kept (they are real events) and the week rows are added on top, deduped by id
    expect(res.listings).toHaveLength(205);
    expect(res.window).toEqual({ start: '2026-09-13', end: '2026-09-26' });
    expect(res.warnings[0]).toMatch(/1200 events .* exceed .* re-querying in 7-night windows/);
  });

  it('an overflowing week withholds the window but the later weeks are still fetched', async () => {
    const weekA = rangeKey('2026-09-13', '2026-09-19');
    const weekB = rangeKey('2026-09-20', '2026-09-26');
    const calls = mockTm((r, p) => {
      if (r === weekA) return page(events(200, `wa${p}`), 1100, p); // 6 pages: overflow
      if (r === weekB) return page(events(4, 'wb'), 4, p);
      return page(events(200, 'probe'), 1104, p);
    });
    const res = await ticketmaster.fetch(ctx());
    const key = (q: URLSearchParams) => `${q.get('startDateTime')}/${q.get('endDateTime')}`;
    const weekAPages = calls.filter((q) => key(q) === weekA).map((q) => q.get('page'));
    expect(weekAPages).toEqual(['0', '1', '2', '3', '4']); // size * page < 1000
    expect(calls.filter((q) => key(q) === weekB)).toHaveLength(1);
    expect(res.listings.filter((l) => l.sourceId.startsWith('wb-'))).toHaveLength(4);
    expect(res.window).toBeNull();
    expect(res.warnings.some((w) => /2026-09-13\.\.2026-09-19 exceeds 1000 events/.test(w))).toBe(true);
    expect(TM_MAX_PAGES).toBe(5);
  });

  it('--limit stops paging, truncates and withholds the window', async () => {
    const evs = events(400, 'l');
    const calls = mockTm((_s, p) => page(evs.slice(p * TM_PAGE_SIZE, (p + 1) * TM_PAGE_SIZE), 400, p));
    const res = await ticketmaster.fetch(ctx({ limit: 5 }));
    expect(calls).toHaveLength(1);
    expect(res.listings).toHaveLength(5);
    expect(res.window).toBeNull();
  });

  it('surfaces a 401 (bad key) as HttpError without retrying, and never calls out without a key', async () => {
    const calls = mockTm(() => 401);
    await expect(ticketmaster.fetch(ctx())).rejects.toThrow(/HTTP 401/);
    expect(calls).toHaveLength(1);
    await expect(ticketmaster.fetch({ ...ctx(), env: {} })).rejects.toThrow('Missing required env var TICKETMASTER_API_KEY');
    expect(calls).toHaveLength(1);
  });
});
