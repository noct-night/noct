import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EDMTRAIN_NYC_LOCATION_ID,
  buildEdmtrainUrl,
  edmtrain,
  edmtrainEnabled,
  groupLineup,
  parseEdmtrainEvents,
  redactEdmtrainUrl,
  type EdmtrainArtist,
  type EdmtrainEvent,
  type EdmtrainResponse,
} from '../../src/sources/edmtrain.js';

// Official docs sample (Event Search API response example), captured 2026-09-13.
const fixture = JSON.parse(readFileSync(new URL('../fixtures/edmtrain_docs_sample.json', import.meta.url), 'utf8')) as EdmtrainResponse;

const artist = (id: number, name: string, b2bInd = false): EdmtrainArtist => ({ id, name, b2bInd, link: `https://edmtrain.com/tours/x-${id}` });

/** A physical NYC event modelled on the docs sample; override what a test cares about. */
function event(over: Partial<EdmtrainEvent> = {}): EdmtrainEvent {
  return {
    ...(fixture.data[0] as EdmtrainEvent),
    id: 90001,
    link: 'https://edmtrain.com/new-york/test-90001',
    venue: { ...(fixture.data[0] as EdmtrainEvent).venue, id: 7001, name: 'Nowadays', location: 'Ridgewood, NY', address: '56-06 Cooper Ave, Ridgewood, NY 11385, USA', state: 'New York', latitude: 40.706, longitude: -73.906 },
    ...over,
  };
}

describe('edmtrain: enabled()', () => {
  it('names exactly which prerequisite is missing', () => {
    expect(edmtrainEnabled({})).toEqual({ ok: false, reason: expect.stringMatching(/^EDMTRAIN_CLIENT_KEY is not set; NOCT_EDMTRAIN_ACCEPT_TERMS is not '1'/) });
    expect(edmtrainEnabled({ EDMTRAIN_CLIENT_KEY: 'k' })).toMatchObject({ ok: false, reason: expect.stringMatching(/^NOCT_EDMTRAIN_ACCEPT_TERMS is not '1'/) });
    expect(edmtrainEnabled({ NOCT_EDMTRAIN_ACCEPT_TERMS: '1' })).toEqual({ ok: false, reason: 'EDMTRAIN_CLIENT_KEY is not set' });
    // an empty string counts as unset, and only the literal '1' acknowledges the terms
    expect(edmtrainEnabled({ EDMTRAIN_CLIENT_KEY: '', NOCT_EDMTRAIN_ACCEPT_TERMS: '1' })).toEqual({ ok: false, reason: 'EDMTRAIN_CLIENT_KEY is not set' });
    expect(edmtrainEnabled({ EDMTRAIN_CLIENT_KEY: 'k', NOCT_EDMTRAIN_ACCEPT_TERMS: 'true' }).ok).toBe(false);
    expect(edmtrainEnabled({ EDMTRAIN_CLIENT_KEY: 'k', NOCT_EDMTRAIN_ACCEPT_TERMS: '1' })).toEqual({ ok: true });
    expect(edmtrain.enabled).toBe(edmtrainEnabled);
  });
});

describe('edmtrain: request URL', () => {
  it('targets NYC (locationIds=70), the date range and excludes livestreams server-side', () => {
    const url = new URL(buildEdmtrainUrl({ key: 'secret-key', fromDate: '2026-09-13', toDate: '2026-10-13' }));
    expect(url.origin + url.pathname).toBe('https://edmtrain.com/api/events');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      locationIds: String(EDMTRAIN_NYC_LOCATION_ID),
      startDate: '2026-09-13',
      endDate: '2026-10-13',
      livestreamInd: 'false',
      client: 'secret-key',
    });
  });
  it('redacts the client key for logs', () => {
    const url = buildEdmtrainUrl({ key: 'secret-key', fromDate: '2026-09-13', toDate: '2026-10-13' });
    const red = redactEdmtrainUrl(url);
    expect(red).not.toContain('secret-key');
    expect(red).toMatch(/client=\*\*\*$/);
  });
});

describe('edmtrain: b2b grouping', () => {
  it('folds b2bInd chains into one billing line with the NEXT artist', () => {
    expect(groupLineup([artist(1, 'A', true), artist(2, 'B'), artist(3, 'C')])).toEqual(['A b2b B', 'C']);
    expect(groupLineup([artist(1, 'A'), artist(2, 'B', true), artist(3, 'C')])).toEqual(['A', 'B b2b C']);
  });
  it('supports runs of any length and closes a dangling b2b on the last artist', () => {
    expect(groupLineup([artist(1, 'A', true), artist(2, 'B', true), artist(3, 'C')])).toEqual(['A b2b B b2b C']);
    expect(groupLineup([artist(1, 'A'), artist(2, 'B', true)])).toEqual(['A', 'B']);
  });
  it('ignores blank names and empty lists', () => {
    expect(groupLineup([artist(1, '  '), artist(2, 'B')])).toEqual(['B']);
    expect(groupLineup([])).toEqual([]);
    expect(groupLineup(null)).toEqual([]);
  });
});

describe('edmtrain: parse (docs sample)', () => {
  const { listings, warnings } = parseEdmtrainEvents(fixture);
  const l = listings[0]!;

  it('yields one date-only listing keyed by the EDMTrain id, link unmodified', () => {
    expect(listings).toHaveLength(1);
    expect(warnings).toEqual([]);
    expect(l.source).toBe('edmtrain');
    expect(l.sourceId).toBe('50839');
    expect(l.sourceUrl).toBe('https://edmtrain.com/new-york/ill-gates-kj-sawka-50839');
    expect(l.raw).toBe(fixture.data[0]);
  });
  it('uses the lineup as the title when name is null', () => {
    expect(l.title).toBe('ill.Gates, KJ Sawka');
    expect(l.lineup).toEqual(['ill.Gates', 'KJ Sawka']);
  });
  it('is date-only: no instant, night = local date', () => {
    expect(l.hasTime).toBe(false);
    expect(l.startsAt).toBeNull();
    expect(l.endsAt).toBeNull();
    expect(l.night).toBe('2017-01-14');
  });
  it('carries venue identity and coarse coordinates', () => {
    expect(l.venueName).toBe('Westcott Theater');
    expect(l.venueSourceId).toBe('543');
    expect(l.venueAddress).toBe('524 Westcott St, Syracuse, NY 13210, USA');
    expect(l.venueLat).toBe(43.041);
    expect(l.venueLng).toBe(-76.12);
  });
  it('maps ages, leaves prices/genres empty and keeps the flags in sourceTags', () => {
    expect(l.ageMin).toBe(0);
    expect(l.genres).toEqual([]);
    expect(l.prices).toEqual([]);
    expect(l.priceMin).toBeNull();
    expect(l.soldOut).toBeNull();
    expect(l.status).toBe('scheduled');
    expect(l.sourceTags).toEqual({
      festivalInd: false,
      electronicGenreInd: true,
      otherGenreInd: false,
      createdDate: '2016-12-08T18:39:58Z',
      ages: 'All Ages',
      artist_ids: [660, 367],
    });
  });
});

describe('edmtrain: parse edge cases', () => {
  it('prefers the event name over the lineup when present (festivals / branded parties)', () => {
    const { listings } = parseEdmtrainEvents({ success: true, data: [event({ name: 'Electric Zoo', artistList: [artist(1, 'A'), artist(2, 'B')] })] });
    expect(listings[0]?.title).toBe('Electric Zoo');
    expect(listings[0]?.lineup).toEqual(['A', 'B']);
  });
  it('joins b2b groups in the title and the lineup', () => {
    const { listings } = parseEdmtrainEvents({ success: true, data: [event({ name: null, artistList: [artist(1, 'A', true), artist(2, 'B'), artist(3, 'C')] })] });
    expect(listings[0]?.title).toBe('A b2b B, C');
    expect(listings[0]?.lineup).toEqual(['A b2b B', 'C']);
  });
  it('falls back to the venue when there is neither a name nor artists', () => {
    const { listings } = parseEdmtrainEvents({ success: true, data: [event({ name: null, artistList: [] })] });
    expect(listings[0]?.title).toBe('Event at Nowadays');
  });
  it('parses ages: "21+" -> 21, "18+" -> 18, null -> unknown', () => {
    const { listings } = parseEdmtrainEvents({
      success: true,
      data: [event({ id: 1, ages: '21+' }), event({ id: 2, ages: '18+' }), event({ id: 3, ages: null })],
    });
    expect(listings.map((x) => x.ageMin)).toEqual([21, 18, null]);
  });
  it('drops livestreams and non-New York venues, and says so in warnings', () => {
    const { listings, warnings } = parseEdmtrainEvents({
      success: true,
      data: [
        event({ id: 1 }),
        event({ id: 2, livestreamInd: true, startTime: '2026-09-13T20:00:00Z', venue: { ...event().venue, state: 'New York' } }),
        event({ id: 3, venue: { ...event().venue, state: 'New Jersey', location: 'Jersey City, NJ' } }),
      ],
    });
    expect(listings.map((x) => x.sourceId)).toEqual(['1']);
    expect(warnings).toEqual(['skipped 1 livestream(s)', 'skipped 1 event(s) whose venue.state is not "New York"']);
  });
  it('drops events without a YYYY-MM-DD date (night is not nullable downstream)', () => {
    const { listings, warnings } = parseEdmtrainEvents({ success: true, data: [event({ date: '' })] });
    expect(listings).toEqual([]);
    expect(warnings).toEqual(['skipped 1 event(s) without a YYYY-MM-DD date']);
  });
  it('tolerates a missing address by falling back to "City, ST"', () => {
    const { listings } = parseEdmtrainEvents({ success: true, data: [event({ venue: { ...event().venue, address: null } })] });
    expect(listings[0]?.venueAddress).toBe('Ridgewood, NY');
  });
  it('treats HTTP 200 + success:false as an API error carrying the message', () => {
    // exact body captured live 2026-09-13 for a bogus key
    expect(() => parseEdmtrainEvents({ data: [], message: 'Invalid client', success: false })).toThrow('EDMTrain API error: Invalid client');
    expect(() => parseEdmtrainEvents({ data: [], success: false })).toThrow(/success=false/);
  });
});

describe('edmtrain: adapter metadata', () => {
  it('matches the source table row and states the terms constraints', () => {
    expect(edmtrain).toMatchObject({ key: 'edmtrain', kind: 'api', priority: 40, feesIncludedDefault: false });
    expect(edmtrain.tosNote).toMatch(/combines our events with other event sources/);
    expect(edmtrain.tosNote).toMatch(/24 hours/);
    expect(edmtrain.tosNote).toMatch(/unmodified/);
  });
});
