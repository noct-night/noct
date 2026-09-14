import { afterAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../../src/lib/db.js';
import { mapRaGenre } from '../../src/enrich/crosswalk.js';
import {
  GENRES, GENRE_BY_CODE, GENRE_CODES, GENRE_FAMILIES, GenreCodeSchema, RA_GENRE_NAMES, VIBES, VIBE_CODES, VIBE_KINDS, VibeCodeSchema,
} from '../../src/enrich/taxonomy.js';

describe('genre taxonomy', () => {
  it('codes are unique and every code carries its family prefix', () => {
    expect(new Set(GENRE_CODES).size).toBe(GENRE_CODES.length);
    for (const g of GENRES) {
      expect(g.code, g.code).toMatch(/^[a-z]+\.[a-z0-9_]+$/);
      expect(g.family).toBe(g.code.split('.')[0]);
      expect(g.label.length).toBeGreaterThan(0);
      expect(g.description.length).toBeGreaterThan(10);
    }
  });
  it('has the proposed ~18 families and ~50-60 codes', () => {
    expect(GENRE_FAMILIES).toEqual(['house', 'techno', 'trance', 'dnb', 'bass', 'dubstep', 'hard', 'electro', 'leftfield', 'hiphop', 'latin', 'afro', 'carib', 'ballroom', 'disco', 'live', 'jazz', 'open']);
    expect(GENRES.length).toBeGreaterThanOrEqual(50);
    expect(GENRES.length).toBeLessThanOrEqual(65);
  });
  it('every one of the 70 RA genre names maps to exactly one code (and no ra_names entry is a typo)', () => {
    expect(RA_GENRE_NAMES).toHaveLength(70);
    expect(new Set(RA_GENRE_NAMES).size).toBe(70);
    for (const name of RA_GENRE_NAMES) {
      const owners = GENRES.filter((g) => g.ra_names.includes(name)).map((g) => g.code);
      expect(owners, `RA "${name}"`).toHaveLength(1);
      expect(mapRaGenre(name)?.code, `crosswalk for RA "${name}"`).toBe(owners[0]);
    }
    for (const g of GENRES) for (const n of g.ra_names) expect(RA_GENRE_NAMES, `${g.code}.ra_names has "${n}"`).toContain(n);
  });
  it('source labels are not claimed by two codes', () => {
    for (const field of ['ra_names', 'dice_tags', 'discogs_styles'] as const) {
      const seen = new Map<string, string>();
      for (const g of GENRES) for (const n of g[field]) {
        // 'tech-house' / 'techhouse' / 'tech house' are the same key; that is fine inside one code, not across two
        const key = n.toLowerCase().replace(/[^a-z0-9]+/g, '');
        const owner = seen.get(key);
        expect(owner === undefined || owner === g.code, `${field} "${n}" claimed by ${g.code} and ${owner}`).toBe(true);
        seen.set(key, g.code);
      }
    }
  });
  it('zod enums are derived from the arrays', () => {
    expect(GenreCodeSchema.options).toEqual([...GENRE_CODES]);
    expect(VibeCodeSchema.options).toEqual([...VIBE_CODES]);
    expect(GenreCodeSchema.safeParse('house.deep').success).toBe(true);
    expect(GenreCodeSchema.safeParse('house.nope').success).toBe(false);
    expect(GENRE_BY_CODE.get('techno.dub')?.label).toBe('Dub / Hypnotic Techno');
  });
});

describe('vibe vocabulary', () => {
  it('codes are unique, kinds valid, chips have a label and glyph', () => {
    expect(new Set(VIBE_CODES).size).toBe(VIBE_CODES.length);
    for (const v of VIBES) {
      expect(VIBE_KINDS).toContain(v.kind);
      expect(v.code).toMatch(/^[a-z0-9_]+$/);
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.glyph.length).toBeGreaterThan(0);
    }
    for (const kind of VIBE_KINDS) expect(VIBES.some((v) => v.kind === kind), kind).toBe(true);
    for (const must of ['sunny_day_party', 'day_into_night', 'afters_marathon', 'all_nighter', 'one_dj_all_night', 'free_rsvp', 'cheap_early', 'phone_free', 'dark_warehouse', 'outdoor_yard', 'sold_out_risk', '21_plus']) {
      expect(VIBE_CODES).toContain(must);
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)('taxonomy rows in the database (0004 seed)', () => {
  afterAll(async () => { await closePool(); });

  it('genre table equals the TS list', async () => {
    const res = await query<{ code: string; family: string; label: string; description: string; ra_names: string[]; dice_tags: string[]; discogs_styles: string[]; aliases: string[]; sort: number }>(
      'select code, family, label, description, ra_names, dice_tags, discogs_styles, aliases, sort from genre order by sort, code',
    );
    const expected = [...GENRES].sort((a, b) => a.sort - b.sort || a.code.localeCompare(b.code)).map((g) => ({
      code: g.code, family: g.family, label: g.label, description: g.description, ra_names: g.ra_names, dice_tags: g.dice_tags,
      discogs_styles: g.discogs_styles, aliases: g.aliases, sort: g.sort,
    }));
    expect(res.rows).toEqual(expected);
  });

  it('vibe table equals the TS list', async () => {
    const res = await query<{ code: string; kind: string; label: string; glyph: string; description: string; sort: number }>(
      'select code, kind, label, glyph, description, sort from vibe order by sort, code',
    );
    const expected = [...VIBES].sort((a, b) => a.sort - b.sort || a.code.localeCompare(b.code)).map((v) => ({
      code: v.code, kind: v.kind, label: v.label, glyph: v.glyph, description: v.description, sort: v.sort,
    }));
    expect(res.rows).toEqual(expected);
  });

  it('new tables exist with RLS enabled and only the taxonomy is publicly readable', async () => {
    const rls = await query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname in ('genre','vibe','artist_genre_profile','classification_run','tag_vote') order by relname`,
    );
    expect(rls.rows.map((r) => r.relname)).toEqual(['artist_genre_profile', 'classification_run', 'genre', 'tag_vote', 'vibe']);
    expect(rls.rows.every((r) => r.relrowsecurity)).toBe(true);
    const pol = await query<{ tablename: string }>(`select tablename from pg_policies where schemaname = 'public' and tablename in ('genre','vibe','artist_genre_profile','classification_run','tag_vote')`);
    expect(pol.rows.map((r) => r.tablename).sort()).toEqual(['genre', 'vibe']);
  });
});
