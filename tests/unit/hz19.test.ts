import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildHzListings, clocksOf, hzListing, hzTargets, parseHzPage, refsFromUrls } from '../../src/sources/hz19.js';

const html = readFileSync(new URL('../fixtures/19hz_bayarea.html', import.meta.url), 'utf8');

describe('19hz: regional page parsing (Bay Area page captured 2026-09-13)', () => {
  const rows = parseHzPage(html);
  it('parses every row with date, title, venue, tags and links', () => {
    expect(rows.length).toBeGreaterThan(400);
    const r = rows.find((x) => x.title.startsWith('Brew & House Coffee Party'))!;
    expect(r).toMatchObject({
      isoDate: '2026-09-13', dateText: 'Sun: Sep 13', timeText: '11am-2pm',
      ticketUrl: 'https://avenueticket.com/event/brew-house-coffee-party-palm-house-edition',
      venue: 'Palm House', venueCity: 'San Francisco',
      tags: ['house', 'tech house', 'afro house'], priceText: '$22.69+', ageText: '18+', organizers: ['Brew & House'],
    });
    expect(r.links[0]).toMatchObject({ label: 'Instagram Page' });
    const tba = rows.find((x) => x.title.startsWith('Late Night Clubbing #075'))!;
    expect(tba).toMatchObject({ venue: 'TBA', venueCity: 'San Francisco', timeText: '1am-6am', tags: ['house', 'edm'] });
    expect(rows.every((x) => x.isoDate === null || /^\d{4}-\d{2}-\d{2}$/.test(x.isoDate))).toBe(true);
  });
  it('reads clocks, including multi-day ranges and past-midnight ends', () => {
    expect(clocksOf('1am-6am')).toEqual({ start: { hour: 1, minute: 0 }, end: { hour: 6, minute: 0 }, multiDay: false });
    expect(clocksOf('11am-2pm').end).toEqual({ hour: 14, minute: 0 });
    expect(clocksOf('Fri: 3pm-Sun: 12pm')).toMatchObject({ start: { hour: 15, minute: 0 }, end: null, multiDay: true });
    expect(clocksOf('')).toEqual({ start: null, end: null, multiDay: false });
  });
  it('turns rows into listings in the city zone: a 1am start belongs to the previous night', () => {
    const tba = rows.find((x) => x.title.startsWith('Late Night Clubbing #075'))!;
    const l = hzListing(tba, 'sf', 'BayArea')!;
    expect(l.source).toBe('19hz');
    expect(l.city).toBe('sf');
    expect(l.tz).toBe('America/Los_Angeles');
    expect(l.startsAt).toBe('2026-09-13T08:00:00.000Z');   // 01:00 PDT
    expect(l.endsAt).toBe('2026-09-13T13:00:00.000Z');     // 06:00 PDT, same morning
    expect(l.night).toBe('2026-09-12');                    // Saturday night
    expect(l.venueName).toBe('TBA - San Francisco');
    expect(l.genres).toEqual(['house', 'edm']);
    expect(l.sourceUrl).toContain('posh.vip');
    const brew = hzListing(rows.find((x) => x.title.startsWith('Brew & House'))!, 'sf', 'BayArea')!;
    expect(brew).toMatchObject({ priceMin: 22.69, ageMin: 18, venueName: 'Palm House', night: '2026-09-13', promoters: ['Brew & House'] });
    expect(brew.startsAt).toBe('2026-09-13T18:00:00.000Z');
  });
  it('hard-links RA and DICE ids found in ticket / alternate links', () => {
    expect(refsFromUrls(['https://ra.co/events/2388139', 'https://dice.fm/event/eoxvey-chaos-in-the-cbd', 'https://link.dice.fm/Q03f22ae9aec', 'https://shotgun.live/en/events/x']))
      .toEqual([{ source: 'ra', id: '2388139' }, { source: 'dice', id: 'eoxvey' }, { source: 'dice_short', id: 'Q03f22ae9aec' }]);
    const chillits = hzListing(rows.find((x) => x.title.startsWith('Chillits 2026'))!, 'sf', 'BayArea')!;
    expect(chillits.externalRefs).toEqual([{ source: 'ra', id: '2388139' }]);
    expect(chillits.sourceTags.multi_day).toBe(true);
    expect(chillits.endsAt).toBeNull();
  });
  it('filters by night range and honours the limit', () => {
    const week = buildHzListings(rows, 'sf', 'BayArea', '2026-09-13', '2026-09-19');
    expect(week.listings.length).toBeGreaterThan(20);
    expect(week.listings.every((l) => l.night! >= '2026-09-13' && l.night! <= '2026-09-19')).toBe(true);
    expect(week.dropped + week.listings.length).toBe(rows.length);
    expect(buildHzListings(rows, 'sf', 'BayArea', '2026-09-13', '2026-12-31', 7).listings).toHaveLength(7);
  });
  it('targets only enabled cities with a 19hz region (never New York)', () => {
    expect(hzTargets({})).toEqual([]);
    expect(hzTargets({ NOCT_CITIES: 'nyc,la,sf,ldn' })).toEqual([{ city: 'la', region: 'LosAngeles' }, { city: 'sf', region: 'BayArea' }]);
  });
});
