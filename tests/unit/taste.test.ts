import { afterAll, describe, expect, it } from 'vitest';
import { GENRE_BY_CODE, GENRE_CODES } from '../../src/enrich/taxonomy.js';
import { CHIP_LABELS, MAX_GENRES, MIN_EVENTS, arrangeGenres, tasteOptions, type TasteGenreRow } from '../../src/feed/taste.js';
import { closePool } from '../../src/lib/db.js';

const row = (code: string, events: number, sort: number, label = GENRE_BY_CODE.get(code)?.label ?? code): TasteGenreRow =>
  ({ code, label, events, family: code.split('.')[0]!, sort });

describe('taste options: the picker\'s arrangement (offline)', () => {
  it('every chip label names a real taxonomy code, and says something shorter', () => {
    for (const [code, chip] of Object.entries(CHIP_LABELS)) {
      expect(GENRE_CODES, code).toContain(code);
      expect(chip.length, code).toBeLessThanOrEqual(GENRE_BY_CODE.get(code)!.label.length);
    }
    expect(CHIP_LABELS['house.garage']).toBe('UK Garage');
    expect(CHIP_LABELS['house.deep']).toBe('House');
  });
  it('groups a family together, busiest family first, siblings in taxonomy order, chip labels on', () => {
    const rows = [
      row('disco.disco', 104, 1510),
      row('house.garage', 17, 170),
      row('techno.acid', 19, 250),
      row('house.deep', 354, 110),
      row('bass.breaks', 9, 510),
      row('techno.peak', 168, 210),
      row('dnb.jungle', 5, 430),
      row('bass.club', 60, 530),
    ];
    expect(arrangeGenres(rows).map((g) => g.label)).toEqual([
      'House', 'UK Garage',          // house 371
      'Techno', 'Acid',              // techno 187
      'Disco',                       // disco 104
      'Breaks', 'Club / Bass',       // bass 69, in taxonomy order not by count
      'Jungle',                      // dnb 5
    ]);
    expect(arrangeGenres(rows)[0]).toEqual({ code: 'house.deep', label: 'House', events: 354 });
  });
  it('falls back to the taxonomy label, and never mutates its input', () => {
    const rows = [row('carib.soca', 4, 1330), row('trance.uplifting', 13, 320)];
    const out = arrangeGenres(rows);
    expect(out.map((g) => g.label)).toEqual(['Trance', 'Soca']);
    expect(rows[0]!.code).toBe('carib.soca');
  });
});

describe.skipIf(!process.env.DATABASE_URL)('taste options against Postgres', () => {
  afterAll(async () => { await closePool(); });
  it('offers at most the cap, nothing under the floor, each code once', async () => {
    const { genres } = await tasteOptions('nyc');
    expect(genres.length).toBeLessThanOrEqual(MAX_GENRES);
    expect(new Set(genres.map((g) => g.code)).size).toBe(genres.length);
    for (const g of genres) {
      expect(g.events, g.code).toBeGreaterThanOrEqual(MIN_EVENTS);
      expect(GENRE_CODES, g.code).toContain(g.code);
      expect(g.label).toBe(CHIP_LABELS[g.code] ?? GENRE_BY_CODE.get(g.code)!.label);
    }
  });
});
