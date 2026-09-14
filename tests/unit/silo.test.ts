import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSiloListings, parseSiloPage, siloListing } from '../../src/sources/silo.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/silo_next_data.json', import.meta.url), 'utf8'));
const html = `<html><head></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(fixture)}</script></body></html>`;

describe('silo: venue page parsing (real page data captured 2026-09-14)', () => {
  it('extracts the SSR DICE event list and buildId', () => {
    const { events, buildId } = parseSiloPage(html);
    expect(events.length).toBe(34);
    expect(buildId).toBe('g2MpZjZPEYkxxpffj8Cik');
  });
  it('fails loudly when the page shape changes', () => {
    expect(() => parseSiloPage('<html>no data</html>')).toThrow(/__NEXT_DATA__/);
    expect(() => parseSiloPage('<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>')).toThrow(/events\.data/);
  });
  it('maps a row through the DICE normaliser, pins the venue and hard-links the DICE id', () => {
    const { events } = parseSiloPage(html);
    const l = siloListing(events[0]!);
    expect(l.source).toBe('silo');
    expect(l.sourceId).toBe('g5bdm5');
    expect(l.sourceUrl).toBe('https://dice.fm/event/g5bdm5-open-decks-w-steen-and-silkyblack-14th-sep-silo-brooklyn-brooklyn-tickets');
    expect(l.venueName).toBe('SILO Brooklyn');
    expect(l.venueSourceId).toBe('8169');
    expect(l.venueLat).toBeCloseTo(40.7105, 3);
    expect(l.externalRefs).toEqual([{ source: 'dice', id: 'g5bdm5' }]);
    expect(l.startsAt).toBe('2026-09-14T23:00:00.000Z'); // 19:00 EDT Monday
    expect(l.night).toBe('2026-09-14');
    expect(l.prices.map((p) => [p.tier, p.price])).toEqual([['Free RSVP', 0], ['At the Door', 5.67]]);
    expect(l.genres).toEqual(expect.arrayContaining(['progressive house', 'house', 'techno', 'tech house']));
    expect(l.ageMin).toBe(21);
    expect(l.status).toBe('rescheduled'); // DICE flag on this row
    expect(l.sourceTags.via).toBe('silobrooklyn.com');
  });
  it('keeps only nights in range, honours limit, and reports a full window otherwise', () => {
    const { events } = parseSiloPage(html);
    const all = buildSiloListings(events, '2026-09-14', '2027-02-28');
    expect(all.listings.length).toBe(34);
    expect(all.dropped).toBe(0);
    const week = buildSiloListings(events, '2026-09-14', '2026-09-20');
    expect(week.listings.length).toBeGreaterThan(3);
    expect(week.listings.every((l) => l.night! >= '2026-09-14' && l.night! <= '2026-09-20')).toBe(true);
    expect(week.dropped).toBe(34 - week.listings.length);
    const capped = buildSiloListings(events, '2026-09-14', '2027-02-28', 5);
    expect(capped.listings.length).toBe(5);
  });
});
