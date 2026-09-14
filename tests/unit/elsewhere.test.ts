import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../../src/lib/log.js';
import {
  collectElsewhere,
  elsewhereVenueName,
  extractNextData,
  normalizeElsewhereEvent,
  parseElsewherePage,
  readEventsPage,
  type ElsewhereEvent,
} from '../../src/sources/elsewhere.js';
import type { FetchContext } from '../../src/sources/types.js';

// real /_next/data/<buildId>/events.json?page=1 response captured 2026-09-13 (36 events, 2026-09-13 .. 2026-09-29)
const page1 = JSON.parse(readFileSync(new URL('../fixtures/elsewhere_events_page1.json', import.meta.url), 'utf8')) as {
  pageProps: { initialEventData: { events: ElsewhereEvent[]; pageNumber: number; hasNextPage: boolean } };
};

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, child: () => silent };
const ctx = (over: Partial<FetchContext> = {}): FetchContext => ({ env: {}, log: silent, fromDate: '2026-09-13', toDate: '2026-10-31', ...over });

/** A fake later page: every event pushed `days` forward. */
function shifted(days: number, hasNextPage: boolean) {
  const move = (s: string | null | undefined) => (s ? new Date(new Date(s).getTime() + days * 86_400_000).toISOString() : s);
  const events = page1.pageProps.initialEventData.events.map((e) => ({
    ...e,
    id: `${e.id}-${days}`,
    start_date: move(e.start_date)!,
    end_date: move(e.end_date),
    curfew_time: move(e.curfew_time),
  }));
  return { pageProps: { initialEventData: { events, pageNumber: 2, hasNextPage } } };
}

describe('elsewhere: __NEXT_DATA__ / page shape', () => {
  it('reads buildId and the embedded page props from the /events HTML', () => {
    const html = `<html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: page1, page: '/events', query: {}, buildId: '8vUK3iEjaiIKNi7np0483',
    })}</script></body></html>`;
    const { buildId, props } = extractNextData(html);
    expect(buildId).toBe('8vUK3iEjaiIKNi7np0483');
    expect(readEventsPage(props)).toMatchObject({ pageNumber: 1, hasNextPage: true });
    expect(readEventsPage(props)?.events).toHaveLength(36);
  });
  it('fails loudly when the markup or shape changes', () => {
    expect(() => extractNextData('<html><body>no next data</body></html>')).toThrow(/__NEXT_DATA__/);
    expect(readEventsPage({ pageProps: {} })).toBeNull();
    expect(() => parseElsewherePage({ pageProps: { somethingElse: 1 } })).toThrow(/initialEventData/);
  });
});

describe('elsewhere: normalisation', () => {
  const parsed = parseElsewherePage(page1);
  const byId = (id: string) => parsed.listings.find((l) => l.sourceId === id)!;

  it('maps every fixture event without warnings', () => {
    expect(parsed.listings).toHaveLength(36);
    expect(parsed.hasNextPage).toBe(true);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.listings.every((l) => l.source === 'elsewhere' && l.hasTime && l.startsAt && l.night)).toBe(true);
  });

  it('keeps Eventbrite ids, totals-with-fees pricing, age and lower-cased genres', () => {
    expect(byId('1986350074544')).toMatchObject({
      title: 'Everyday People NYC @ Elsewhere',
      sourceUrl: 'https://www.eventbrite.com/e/everyday-people-nyc-elsewhere-tickets-1986350074544',
      startsAt: '2026-09-13T20:00:00.000Z',
      endsAt: '2026-09-14T04:00:00.000Z',
      night: '2026-09-13',
      venueName: 'Elsewhere',
      venueAddress: '599 Johnson Avenue, Brooklyn, NY 11237',
      priceMin: 39.94,
      priceMax: 39.94,
      feesIncluded: true,
      prices: [{ tier: 'General Admission', price: 39.94, feesIncluded: true, available: true, note: 'face value $30.00 + $9.94 fees' }],
      soldOut: false,
      ageMin: 21,
      genres: ['electronic'],
      promoters: [],
      externalRefs: [{ source: 'eventbrite', id: '1986350074544' }],
      imageUrl: expect.stringContaining('img.evbuc.com'),
      sourceTags: { elsewhere_type: 'club', rooms: ['Full Venue'], elsewhere_presents: false, provider: 'eventbrite' },
    });
    expect(byId('1986350074544').raw).toBe(page1.pageProps.initialEventData.events[0]);
  });

  it('maps rooms to the Elsewhere venue family and keeps foreign venues verbatim', () => {
    expect(byId('1991922010354')).toMatchObject({ venueName: 'Elsewhere Rooftop', ageMin: 16, genres: ['rock'], lineup: ['Locust', 'queenie'] });
    expect(byId('1985137094488')).toMatchObject({
      venueName: 'Good Room',
      venueAddress: '98 Meserole Avenue, Brooklyn, NY 11222',
      soldOut: true,
      sourceTags: { rooms: ['Good Room'], elsewhere_presents: true },
    });
    expect(byId('1985137094488').prices[0]?.available).toBe(false);
    expect(byId('2000440278724')).toMatchObject({ venueName: 'SILO', startsAt: '2026-09-17T02:30:00.000Z', night: '2026-09-16' });
  });

  it('falls back to the representative face value when no ticket tiers are listed', () => {
    expect(byId('1998249671559')).toMatchObject({ prices: [], priceMin: 20.87, priceMax: 20.87, feesIncluded: false, priceNote: expect.stringContaining('fees not included') });
    expect(byId('1986252765490')).toMatchObject({ prices: [], priceMin: null, priceMax: null, feesIncluded: null });
  });

  it('rejects events it cannot place in time or identify, without aborting the page', () => {
    const first = page1.pageProps.initialEventData.events[0]!;
    expect(normalizeElsewhereEvent({ ...first, id: 1, start_date: 'soon' })).toEqual({ error: expect.stringContaining('unparsable start_date') });
    expect(normalizeElsewhereEvent({ ...first, name: '  ' })).toEqual({ error: expect.stringContaining('no name') });
    expect(normalizeElsewhereEvent({ ...first, id: undefined as unknown as number })).toEqual({ error: expect.stringContaining('without id') });
    const mixed = parseElsewherePage({ pageProps: { initialEventData: { events: [first, { ...first, id: 2, name: '' }], pageNumber: 1, hasNextPage: false } } });
    expect(mixed.listings).toHaveLength(1);
    expect(mixed.warnings).toHaveLength(1);
  });

  it('elsewhereVenueName', () => {
    expect(elsewhereVenueName(['The Hall'], null)).toBe('Elsewhere Hall');
    expect(elsewhereVenueName(['Zone One'], null)).toBe('Elsewhere Zone One');
    expect(elsewhereVenueName(['The Loft'], null)).toBe('Elsewhere Loft');
    expect(elsewhereVenueName(['The Hall', 'Zone One'], null)).toBe('Elsewhere');
    expect(elsewhereVenueName(['Market Hotel'], '1140 Myrtle Avenue')).toBe('Market Hotel');
    expect(elsewhereVenueName([], '599 Johnson Avenue, Brooklyn, NY 11237')).toBe('Elsewhere');
    expect(elsewhereVenueName([], null)).toBeNull();
  });
});

describe('elsewhere: pagination walk', () => {
  it('stops at the first page that runs past toDate and promises the full window', async () => {
    const pages: number[] = [];
    const res = await collectElsewhere(ctx({ toDate: '2026-09-30' }), async (n) => {
      pages.push(n);
      return n === 1 ? page1 : shifted(30, true);
    });
    expect(pages).toEqual([1, 2]);
    expect(res.listings).toHaveLength(36);
    expect(res.window).toEqual({ start: '2026-09-13', end: '2026-09-30' });
  });

  it('ends the window at the last night seen when the site runs out of pages first', async () => {
    const res = await collectElsewhere(ctx({ toDate: '2026-10-31' }), async () => ({
      pageProps: { initialEventData: { ...page1.pageProps.initialEventData, hasNextPage: false } },
    }));
    expect(res.listings).toHaveLength(36);
    expect(res.window).toEqual({ start: '2026-09-13', end: '2026-09-29' });
  });

  it('filters by night on both ends', async () => {
    const res = await collectElsewhere(ctx({ fromDate: '2026-09-20', toDate: '2026-09-26' }), async () => ({
      pageProps: { initialEventData: { ...page1.pageProps.initialEventData, hasNextPage: false } },
    }));
    expect(res.listings.map((l) => l.night).every((n) => n! >= '2026-09-20' && n! <= '2026-09-26')).toBe(true);
    expect(res.listings).toHaveLength(17); // 09-20 ×1, 09-21 ×1, 09-22 ×1, 09-23 ×2, 09-24 ×3, 09-25 ×3, 09-26 ×6
  });

  it('a range entirely before the calendar is still a complete (empty) enumeration', async () => {
    const res = await collectElsewhere(ctx({ fromDate: '2026-09-01', toDate: '2026-09-05' }), async () => page1);
    expect(res.listings).toEqual([]);
    expect(res.window).toEqual({ start: '2026-09-01', end: '2026-09-05' });
  });

  it('a limit caps listings and withdraws the window promise', async () => {
    const res = await collectElsewhere(ctx({ limit: 5 }), async () => page1);
    expect(res.listings).toHaveLength(5);
    expect(res.window).toBeNull();
  });
});
