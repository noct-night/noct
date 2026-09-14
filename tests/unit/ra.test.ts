import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/lib/log.js';
import {
  buildVariables,
  collectListings,
  normalizeCoords,
  normalizeEvent,
  parseListingsPage,
  summarizePrices,
  ra,
  type RaEvent,
  type RaListingsBody,
} from '../../src/sources/ra.js';
import type { FetchContext } from '../../src/sources/types.js';

const load = (name: string): RaListingsBody => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const page = load('ra_listings_page.json');
const minimal = load('ra_listings_minimal.json');

const events = parseListingsPage(page).events;
const byId = new Map(events.map((e) => [e.id, e]));
const event = (id: string): RaEvent => {
  const e = byId.get(id);
  if (!e) throw new Error(`fixture has no event ${id}`);
  return structuredClone(e);
};

const silent = { ...createLogger('test'), info: () => undefined, warn: () => undefined };
const ctx = (over: Partial<FetchContext> = {}): FetchContext => ({
  env: {},
  log: silent,
  fromDate: '2026-09-13',
  toDate: '2026-09-20',
  ...over,
});

describe('ra: parseListingsPage', () => {
  it('unwraps the captured page', () => {
    const parsed = parseListingsPage(page);
    expect(parsed.events).toHaveLength(20);
    expect(parsed.totalResults).toBe(233);
    expect(parsed.warnings).toEqual([]);
  });
  it('parses the degenerate minimal shape', () => {
    const parsed = parseListingsPage(minimal);
    expect(parsed.events).toHaveLength(20);
    expect(parsed.totalResults).toBe(233);
  });
  it('treats a 200 body with errors and no data as a failure', () => {
    expect(() => parseListingsPage({ errors: [{ message: 'Limit must not be greater than 100' }] })).toThrow(/Limit must not be greater than 100/);
    expect(() => parseListingsPage({})).toThrow(/no eventListings/);
  });
  it('keeps data from a partially failed page and surfaces the error as a warning', () => {
    const body: RaListingsBody = { data: { eventListings: { data: [{ event: event('2370377') }], totalResults: 1 } }, errors: [{ message: 'tickets timed out' }] };
    const parsed = parseListingsPage(body);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.warnings).toEqual(['RA GraphQL partial error: tickets timed out']);
  });
});

describe('ra: buildVariables', () => {
  it('mirrors the web app request', () => {
    expect(buildVariables({ areaId: 8, fromDate: '2026-09-13', toDate: '2026-09-20', page: 2, pageSize: 100 })).toEqual({
      filters: { areas: { eq: 8 }, listingDate: { gte: '2026-09-13T00:00:00.000Z', lte: '2026-09-20T23:59:59.999Z' } },
      filterOptions: { genre: true, eventType: true },
      pageSize: 100,
      page: 2,
      sort: { listingDate: { order: 'ASCENDING' }, score: { order: 'DESCENDING' }, titleKeyword: { order: 'ASCENDING' } },
    });
  });
});

describe('ra: normalizeEvent on the captured page', () => {
  const listings = events.map((ev) => normalizeEvent(ev));

  it('produces well-formed listings for every event', () => {
    expect(listings).toHaveLength(20);
    for (const l of listings) {
      expect(l.source).toBe('ra');
      expect(l.sourceId).toMatch(/^\d+$/);
      expect(l.sourceUrl).toBe(`https://ra.co/events/${l.sourceId}`);
      expect(l.title.length).toBeGreaterThan(0);
      expect(l.hasTime).toBe(true);
      expect(l.night).toBe('2026-09-13');
      expect(l.status).toBe('scheduled');
      expect(l.currency).toBe('USD');
      expect(l.raw).toBe(byId.get(l.sourceId));
    }
  });

  it('converts RA local times (EDT) to UTC instants', () => {
    const ms = normalizeEvent(event('2503060')); // Mister Sunday 15:00-21:00 New York
    expect(ms.startsAt).toBe('2026-09-13T19:00:00.000Z');
    expect(ms.endsAt).toBe('2026-09-14T01:00:00.000Z');
    const lfs = normalizeEvent(event('2525336')); // ends 02:00 next morning
    expect(lfs.endsAt).toBe('2026-09-14T06:00:00.000Z');
    expect(lfs.night).toBe('2026-09-13');
  });

  it('assigns a pre-06:00 start to the previous night', () => {
    const ev = event('2526917');
    ev.startTime = '2026-09-14T01:00:00.000';
    ev.endTime = '2026-09-14T06:00:00.000';
    const l = normalizeEvent(ev);
    expect(l.startsAt).toBe('2026-09-14T05:00:00.000Z');
    expect(l.night).toBe('2026-09-13');
  });

  it('keeps real coordinates and drops RA placeholders', () => {
    const nowadays = normalizeEvent(event('2503060'));
    expect(nowadays.venueLat).toBeCloseTo(40.692462, 6);
    expect(nowadays.venueLng).toBeCloseTo(-73.901536, 6);
    const bat = normalizeEvent(event('2370377')); // Brooklyn Army Terminal: (41,-74)
    expect(bat.venueLat).toBeNull();
    expect(bat.venueLng).toBeNull();
    expect(bat.venueName).toBe('Brooklyn Army Terminal');
    expect(bat.venueAddress).toBe('58th St, Brooklyn, NY 11220');
    const greenRoom = normalizeEvent(event('2525336')); // (0,0)
    expect(greenRoom.venueLat).toBeNull();
    expect(normalizeCoords(null)).toBeNull();
    expect(normalizeCoords({ latitude: 40.7, longitude: null })).toBeNull();
  });

  it('carries venue ids, lineup order, genres, promoters, age and interest', () => {
    const l = normalizeEvent(event('2370377'));
    expect(l.venueSourceId).toBe('236259');
    expect(l.lineup).toEqual(['Mau P', 'Joseph Capriati', 'DJ Gigola']);
    expect(l.genres).toEqual(['Techno', 'House']);
    expect(l.promoters).toEqual(['Teksupport']);
    expect(l.ageMin).toBe(21);
    expect(l.interestedCount).toBe(277);
    expect(l.sourceTags).toMatchObject({
      ra_genre_slugs: ['techno', 'house'],
      is_festival: false,
      is_pick: true,
      set_times_status: 'NONE',
      ticketing: true,
      date_updated: '2026-09-10T18:36:22.533Z',
    });
    expect(l.sourceTags).not.toHaveProperty('set_times_lineup');
    expect(l.sourceTags).not.toHaveProperty('secret_venue');
    expect(l.externalRefs).toEqual([]);
  });

  it('uses the RA Pick blurb as description, cleaned to plain text', () => {
    expect(normalizeEvent(event('2370377')).description).toMatch(/^Baddest Behaviour returns for round two/);
    expect(normalizeEvent(event('2370377')).description).not.toMatch(/<|&amp;/);
    expect(normalizeEvent(event('2503060')).description).toBeNull();
  });

  it('prefers the FLYERFRONT image', () => {
    const ev = event('2503060');
    const front = ev.images!.find((i) => i.type === 'FLYERFRONT')!.filename;
    expect(normalizeEvent(ev).imageUrl).toBe(front);
    expect(front).toMatch(/^https:\/\/images\.ra\.co\//);
    ev.images = [{ filename: 'https://images.ra.co/back.jpg', type: 'FLYERBACK' }];
    expect(normalizeEvent(ev).imageUrl).toBe('https://images.ra.co/back.jpg');
    ev.images = [];
    expect(normalizeEvent(ev).imageUrl).toBeNull();
  });

  it('leaves minimumAge null when RA has none', () => {
    expect(normalizeEvent(event('2503060')).ageMin).toBeNull();
  });

  it('does not derive status from title flags (SQL owns that)', () => {
    const l = normalizeEvent(event('2502170'));
    expect(l.title).toBe('CANCELLED - BEYOND THE STARDUST');
    expect(l.status).toBe('scheduled');
  });
});

describe('ra: prices and sold-out', () => {
  it('takes the headline price from VALID tiers only when some are on sale', () => {
    const l = normalizeEvent(event('2520074')); // Early bird 17.25 SOLDOUT, 1st 23 SOLDOUT, 2nd 28.75 VALID
    expect(l.prices).toEqual([
      { tier: 'Early bird', price: 17.25, feesIncluded: true, available: false, note: 'SOLDOUT' },
      { tier: '1st release', price: 23, feesIncluded: true, available: false, note: 'SOLDOUT' },
      { tier: '2nd release', price: 28.75, feesIncluded: true, available: true, note: 'VALID' },
    ]);
    expect(l.priceMin).toBe(28.75);
    expect(l.priceMax).toBe(28.75);
    expect(l.feesIncluded).toBe(true);
    expect(l.soldOut).toBe(false);
    expect(l.priceNote).toBe('$5-$30');
  });

  it('falls back to every tier when none is VALID, without calling it sold out', () => {
    const l = normalizeEvent(event('2503060')); // six NOLONGERONSALE tiers
    expect(l.prices.every((p) => p.available === false)).toBe(true);
    expect(l.priceMin).toBe(26.9);
    expect(l.priceMax).toBe(53.8);
    expect(l.soldOut).toBe(false);
    expect(l.priceNote).toBeNull();
  });

  it('falls back to the cost text when there are no tiers', () => {
    const l = normalizeEvent(event('2526917')); // tickets [], cost "10.00"
    expect(l.prices).toEqual([]);
    expect(l.priceMin).toBe(10);
    expect(l.priceMax).toBe(10);
    expect(l.feesIncluded).toBeNull();
    expect(l.soldOut).toBeNull();
    expect(l.priceNote).toBe('10.00');
    expect(normalizeEvent(event('2534829')).priceMin).toBeNull(); // no tiers, cost ""
  });

  it('prefers tiers over the cost text and keeps RSVP tiers at $0', () => {
    expect(normalizeEvent(event('2510513')).priceMin).toBe(114.95); // cost "80-100" but VALID tiers start at 114.95
    expect(normalizeEvent(event('2527829')).priceMin).toBe(0); // RSVP 0 VALID
    expect(normalizeEvent(event('2527829')).feesIncluded).toBe(true);
  });

  it('marks sold out only when every tier is SOLDOUT', () => {
    const ev = event('2520074');
    for (const t of ev.tickets!) t.validType = 'SOLDOUT';
    const l = normalizeEvent(ev);
    expect(l.soldOut).toBe(true);
    expect(l.priceMin).toBe(17.25);
    expect(l.priceMax).toBe(28.75);
    expect(summarizePrices([{ title: 'GA', priceRetail: 20, validType: 'SOLDOUT' }, { title: 'VIP', priceRetail: 50, validType: 'NOTYETONSALE' }], '$20').soldOut).toBe(false);
    expect(summarizePrices([], '$20')).toMatchObject({ soldOut: null, priceMin: 20, priceMax: 20, feesIncluded: null });
  });

  it('reads the currency from the tiers', () => {
    expect(summarizePrices([{ title: 'GA', priceRetail: 20, validType: 'VALID', currency: { code: 'GBP' } }], null).currency).toBe('GBP');
    expect(summarizePrices([], null).currency).toBe('USD');
  });
});

describe('ra: secret venues and set times', () => {
  it('keeps the venue name but flags a secret venue', () => {
    const ev = event('2370377');
    ev.hasSecretVenue = true;
    const l = normalizeEvent(ev);
    expect(l.venueName).toBe('Brooklyn Army Terminal');
    expect(l.sourceTags.secret_venue).toBe(true);
  });
  it('exposes set times only once PUBLIC', () => {
    const ev = event('2370377');
    ev.setTimes = { status: 'SET', lineup: '15:00 DJ Gigola' };
    expect(normalizeEvent(ev).sourceTags).toMatchObject({ set_times_status: 'SET' });
    expect(normalizeEvent(ev).sourceTags).not.toHaveProperty('set_times_lineup');
    ev.setTimes = { status: 'PUBLIC', lineup: '15:00 DJ Gigola' };
    expect(normalizeEvent(ev).sourceTags).toMatchObject({ set_times_status: 'PUBLIC', set_times_lineup: '15:00 DJ Gigola' });
  });
});

describe('ra: minimal fixture (date only, no venue id, no tickets)', () => {
  const listings = parseListingsPage(minimal).events.map((ev) => normalizeEvent(ev));
  it('falls back to the RA date as the night', () => {
    const l = listings[0]!;
    expect(l.sourceId).toBe('2503060');
    expect(l.sourceUrl).toBe('https://ra.co/events/2503060');
    expect(l.hasTime).toBe(false);
    expect(l.startsAt).toBeNull();
    expect(l.night).toBe('2026-09-13');
    expect(l.venueName).toBe('Nowadays');
    expect(l.venueSourceId).toBeNull();
    expect(l.lineup).toEqual(['Theo Parrish']);
    expect(l.prices).toEqual([]);
    expect(l.priceMin).toBeNull();
    expect(l.soldOut).toBeNull();
    expect(l.imageUrl).toBeNull();
    expect(l.ageMin).toBeNull();
  });
  it('still reads genres and lineups', () => {
    expect(listings[1]).toMatchObject({ genres: ['Techno', 'House'], lineup: ['Mau P', 'Joseph Capriati', 'DJ Gigola'] });
  });
});

describe('ra: collectListings pager (offline)', () => {
  /** Serves the fixture in slices of the requested pageSize, recording every call. */
  const fakeServer = (source: RaEvent[] = events, total = source.length) => {
    const calls: Array<{ page: number; pageSize: number; areaId: number }> = [];
    const fetchPage = async (v: ReturnType<typeof buildVariables>): Promise<RaListingsBody> => {
      calls.push({ page: v.page, pageSize: v.pageSize, areaId: v.filters.areas.eq });
      const start = (v.page - 1) * v.pageSize;
      return { data: { eventListings: { data: source.slice(start, start + v.pageSize).map((event) => ({ event })), totalResults: total } } };
    };
    return { calls, fetchPage };
  };

  it('walks every page and reports the full window', async () => {
    const srv = fakeServer();
    const res = await collectListings(ctx(), { fetchPage: srv.fetchPage, pageSize: 8 });
    expect(srv.calls.map((c) => c.page)).toEqual([1, 2, 3]);
    expect(res.listings).toHaveLength(20);
    expect(res.window).toEqual({ start: '2026-09-13', end: '2026-09-20' });
    expect(res.warnings).toEqual([]);
  });

  it('stops at ctx.limit, requests only that many rows, and reports no window', async () => {
    const srv = fakeServer();
    const res = await collectListings(ctx({ limit: 5 }), { fetchPage: srv.fetchPage });
    expect(srv.calls).toEqual([{ page: 1, pageSize: 5, areaId: 8 }]);
    expect(res.listings).toHaveLength(5);
    expect(res.window).toBeNull();
  });

  it('keeps the window when the limit is not reached', async () => {
    const srv = fakeServer();
    const res = await collectListings(ctx({ limit: 50 }), { fetchPage: srv.fetchPage });
    expect(srv.calls).toEqual([{ page: 1, pageSize: 50, areaId: 8 }]);
    expect(res.listings).toHaveLength(20);
    expect(res.window).toEqual({ start: '2026-09-13', end: '2026-09-20' });
  });

  it('keeps paging past a full page that contains a row without an event', async () => {
    const calls: number[] = [];
    // 20 rows, the 8th of which has no event, served in pages of 8: page 1 is full but yields only 7 events
    const rows: Array<{ event: RaEvent | null }> = [
      ...events.slice(0, 7).map((event) => ({ event })),
      { event: null },
      ...events.slice(7, 19).map((event) => ({ event })),
    ];
    const fetchPage = async (v: ReturnType<typeof buildVariables>): Promise<RaListingsBody> => {
      calls.push(v.page);
      const start = (v.page - 1) * v.pageSize;
      return { data: { eventListings: { data: rows.slice(start, start + v.pageSize), totalResults: rows.length } } };
    };
    const res = await collectListings(ctx(), { fetchPage, pageSize: 8 });
    expect(calls).toEqual([1, 2, 3]);
    expect(res.listings).toHaveLength(19);
    expect(res.window).toEqual({ start: '2026-09-13', end: '2026-09-20' });
  });

  it('de-duplicates an event that appears on two pages', async () => {
    const dup = [...events, events[0]!];
    const srv = fakeServer(dup);
    const res = await collectListings(ctx(), { fetchPage: srv.fetchPage, pageSize: 10 });
    expect(srv.calls.map((c) => c.page)).toEqual([1, 2, 3]);
    expect(res.listings).toHaveLength(20);
    expect(res.window).not.toBeNull();
  });

  it('honours NOCT_RA_AREA_ID and rejects garbage', async () => {
    const srv = fakeServer();
    await collectListings(ctx({ env: { NOCT_RA_AREA_ID: '13' }, limit: 1 }), { fetchPage: srv.fetchPage });
    expect(srv.calls[0]?.areaId).toBe(13);
    await expect(collectListings(ctx({ env: { NOCT_RA_AREA_ID: 'nyc' } }), { fetchPage: srv.fetchPage })).rejects.toThrow(/NOCT_RA_AREA_ID/);
  });

  it('propagates a failed page', async () => {
    const fetchPage = async (): Promise<RaListingsBody> => ({ errors: [{ message: 'boom' }] });
    await expect(collectListings(ctx(), { fetchPage })).rejects.toThrow(/boom/);
  });
});

describe('ra: adapter metadata', () => {
  it('is always enabled and describes its terms', () => {
    expect(ra.key).toBe('ra');
    expect(ra.enabled({})).toEqual({ ok: true });
    expect(ra.feesIncludedDefault).toBe(true);
    expect(ra.tosNote).toMatch(/4\.4\(a\)/);
    expect(ra.tosNote).toMatch(/4\.4\(f\)/);
    expect(ra.tosNote).toMatch(/robots\.txt/);
  });
});
