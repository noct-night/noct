import { describe, expect, it } from 'vitest';
import { zonedToUtc } from '../../src/lib/time.js';
import { applyRules, endLateness, priceTier, RULES_VERSION, startLateness, type RuleInput, type RuleVenue } from '../../src/enrich/rules.js';

const ny = (local: string): string => (zonedToUtc(local) as Date).toISOString();

const NOWADAYS: RuleVenue = {
  name: 'Nowadays', kind: 'venue', space_types: ['club', 'outdoor_yard'], outdoor: true, phone_policy: 'no_photos', capacity: 600,
  typical_genres: ['house.deep', 'leftfield.experimental'], vibe_priors: ['sound_system_focus', '21_plus'], underground_prior: 5,
};
const KNOCKDOWN: RuleVenue = {
  name: 'Knockdown Center', kind: 'complex', space_types: ['warehouse', 'outdoor_yard'], outdoor: true, phone_policy: null, capacity: 3000,
  typical_genres: [], vibe_priors: ['21_plus'], underground_prior: 3,
};

const base: RuleInput = {
  title: '', lineup: [], starts_at: null, ends_at: null, has_time: false, night: '2026-09-12', price_min: null, price_max: null, age_min: null,
  description: null, venue: null, promoter_priors: [], source_tags: {}, source_genres: [],
};

const codes = (out: ReturnType<typeof applyRules>): string[] => out.vibes.map((v) => v.code);

describe('rules: worked example 1 — Vladimir Ivkovic All Night @ Nowadays 22:00–06:00', () => {
  const out = applyRules({
    ...base,
    title: 'Vladimir Ivkovic All Night',
    lineup: ['Vladimir Ivkovic'],
    starts_at: ny('2026-09-12T22:00:00'), ends_at: ny('2026-09-13T06:00:00'), has_time: true, night: '2026-09-12',
    price_min: 10, price_max: 15, age_min: 21,
    description: 'Nowadays resident and Offen Music founder, playing the full night. Low tempo, psychedelic, drawing on coldwave and outsider dance music. $10 before 23:00, $15 before midnight.',
    venue: NOWADAYS, source_tags: { ra: {} },
  });
  it('emits the all-night / one-DJ / price / policy vibes', () => {
    const v = codes(out);
    for (const must of ['all_nighter', 'one_dj_all_night', 'long_sets', 'cheap_early', 'phone_free', 'sound_system_focus', '21_plus', 'underground']) expect(v, must).toContain(must);
    for (const not of ['sunny_day_party', 'day_into_night', 'afters_marathon', 'outdoor_yard', 'free_rsvp', 'early_finish', 'pricey', 'big_room_club']) expect(v, not).not.toContain(not);
  });
  it('scalars: start 4, end 4, price tier 1, crowd 3, underground 5', () => {
    expect(out.scalars).toEqual({ start_lateness: 4, end_lateness: 4, price_tier: 1, crowd_size: 3, underground_index: 5 });
    expect(out.timing).toMatchObject({ start_local: '22:00', end_local: '06:00', duration_h: 8, weekday: 6 });
  });
  it('genre priors come from the description text and the venue', () => {
    const byCode = Object.fromEntries(out.genre_priors.map((p) => [p.code, p]));
    expect(byCode['electro.ebm_industrial']).toMatchObject({ source: 'text:description' });
    expect(byCode['leftfield.experimental']).toBeDefined();
    expect(out.genre_priors.filter((p) => p.source === 'venue_prior').map((p) => p.code)).toEqual(['house.deep', 'leftfield.experimental']);
    expect(out.crosswalk.ranked.map((r) => r.code)).toEqual(expect.arrayContaining(['electro.ebm_industrial', 'leftfield.experimental']));
  });
  it('records provenance on every vibe and the rules version', () => {
    expect(out.version).toBe(RULES_VERSION);
    expect(out.vibes.find((v) => v.code === 'phone_free')).toMatchObject({ rule: 'venue.phone_policy' });
    expect(out.vibes.find((v) => v.code === 'cheap_early')?.evidence).toMatch(/\$10 before 23:00/);
    expect(out.vibes.find((v) => v.code === 'sound_system_focus')).toMatchObject({ rule: 'venue_prior' });
    expect(out.flags).not.toContain('no_time');
  });
});

describe('rules: worked example 2 — Chaos In The CBD "Dust Till Dawn" @ Knockdown Center 15:00–05:00', () => {
  const out = applyRules({
    ...base,
    title: 'Chaos In The CBD presents Dust Till Dawn',
    lineup: ['Chaos In The CBD', 'Joe Claussell', 'Floorplan', 'Shy One', 'Suze Ijó', 'DJ Ray', 'Extra Andrew'],
    starts_at: '2026-08-29T19:00:00.000Z', ends_at: '2026-08-30T09:00:00.000Z', has_time: true, night: '2026-08-29',
    price_min: null, price_max: null, age_min: 21, sold_out: true,
    description: 'Shy One reinvents the genre with a fresh take on mercurial, jazzy and jacking house. Two stages across the Ruins and the main hall.',
    venue: KNOCKDOWN, source_tags: { dice: {} },
    source_genres: [{ source: 'dice', labels: ['dj:house', 'dj:deephouse'] }],
  });
  it('day-into-night warehouse party with a festival-size bill', () => {
    const v = codes(out);
    for (const must of ['day_into_night', 'festival_scale_lineup', 'dark_warehouse', 'outdoor_yard', 'big_room_club', 'sold_out_risk', '21_plus']) expect(v, must).toContain(must);
    for (const not of ['sunny_day_party', 'all_nighter', 'afters_marathon', 'one_dj_all_night', 'long_sets', 'free_rsvp', 'early_finish']) expect(v, not).not.toContain(not);
  });
  it('scalars: start 1, end 4, crowd 5; no price -> no tier and a no_price flag', () => {
    expect(out.scalars).toEqual({ start_lateness: 1, end_lateness: 4, crowd_size: 5, underground_index: 3 });
    expect(out.flags).toContain('no_price');
    expect(out.timing.duration_h).toBe(14);
  });
  it('crosswalk: DICE deep house beats the generic house tag; "jacking house" surfaces from the text', () => {
    expect(out.crosswalk.ranked[0]).toMatchObject({ code: 'house.deep', weight: 0.7 });
    expect(out.crosswalk.ranked.map((r) => r.code)).toContain('house.jackin');
    expect(out.crosswalk.is_electronic).toBe(true);
  });
});

describe('rules: worked example 3 — Mister Sunday: Eamon Harkin All Day @ Nowadays 15:00–21:00', () => {
  const out = applyRules({
    ...base,
    title: 'Mister Sunday: Eamon Harkin All Day',
    lineup: ['Eamon Harkin All Day'],
    starts_at: ny('2026-09-13T15:00:00'), ends_at: ny('2026-09-13T21:00:00'), has_time: true, night: '2026-09-13',
    price_min: 15, price_max: 25, age_min: null, interested_count: 1934,
    description: 'Mister Sunday in the yard. $10 off the door before 16:00, $5 off before 17:00.',
    venue: NOWADAYS, source_tags: { ra: {} },
    promoter_priors: [{ name: 'Mister Sunday', genre_priors: ['house.deep', 'house.disco'], vibe_priors: ['weekly_residency', 'local_crews'], underground_prior: 4 }],
    source_genres: [{ source: 'ra', labels: [] }],
  });
  it('sunny day party in the yard, one resident all day', () => {
    const v = codes(out);
    for (const must of ['sunny_day_party', 'outdoor_yard', 'one_dj_all_night', 'long_sets', 'weekly_residency', 'local_crews', 'cheap_early', 'phone_free', 'sound_system_focus', 'underground', 'sold_out_risk']) expect(v, must).toContain(must);
    for (const not of ['day_into_night', 'all_nighter', 'early_finish', 'afters_marathon', 'free_rsvp', 'festival_scale_lineup']) expect(v, not).not.toContain(not);
  });
  it('scalars: start 1, end 1, price tier 1, crowd 3; promoter prior wins the underground index (4, not the venue 5)', () => {
    expect(out.scalars).toEqual({ start_lateness: 1, end_lateness: 1, price_tier: 1, crowd_size: 3, underground_index: 4 });
    expect(out.timing).toMatchObject({ start_local: '15:00', end_local: '21:00', duration_h: 6, weekday: 0 });
  });
  it('genre priors carry the series prior', () => {
    const promo = out.genre_priors.filter((p) => p.source === 'promoter_prior');
    expect(promo.map((p) => p.code)).toEqual(['house.deep', 'house.disco']);
    expect(promo[0]).toMatchObject({ weight: 0.45 });
    expect(out.vibes.find((v) => v.code === 'weekly_residency')).toMatchObject({ rule: 'promoter_prior' });
  });
});

describe('rules: edge cases', () => {
  it('no time -> no timing vibes, flagged', () => {
    const out = applyRules({ ...base, title: 'TBA', night: '2026-10-01', lineup: [] });
    expect(out.scalars).toEqual({});
    expect(out.flags).toEqual(expect.arrayContaining(['no_time', 'no_price', 'no_venue', 'no_lineup', 'sparse_description']));
    expect(codes(out)).toEqual(['pop_up_secret_location']);
  });
  it('an afters that starts at 04:00 and a free RSVP party', () => {
    const afters = applyRules({ ...base, title: 'Afters', has_time: true, night: '2026-09-12', starts_at: ny('2026-09-13T04:00:00'), ends_at: ny('2026-09-13T11:00:00'), lineup: ['A', 'B'] });
    expect(codes(afters)).toContain('afters_marathon');
    expect(afters.scalars).toMatchObject({ start_lateness: 5, end_lateness: 5 });
    const free = applyRules({ ...base, title: 'Free party — RSVP', price_min: 0, price_max: 0, has_time: true, starts_at: ny('2026-09-12T20:00:00'), ends_at: ny('2026-09-13T00:30:00'), lineup: ['A b2b B', 'C b2b D'] });
    expect(codes(free)).toEqual(expect.arrayContaining(['free_rsvp', 'early_finish', 'b2b_heavy']));
    expect(free.scalars.price_tier).toBe(0);
  });
  it('live acts, pricey tickets, age bands, queer / latinx text cues and source vibe hints', () => {
    const out = applyRules({
      ...base, title: 'Perreo Intenso: Ms Nina (live) — 18+', lineup: ['Ms Nina (live)', 'DJ Python'], price_min: 45, price_max: 80, age_min: 18,
      has_time: true, starts_at: ny('2026-09-12T23:00:00'), ends_at: ny('2026-09-13T04:00:00'),
      description: 'A queer reggaeton party. No photos on the dancefloor.', source_genres: [{ source: 'dice', labels: ['dj:reggaeton', 'dj:lgbtq+'] }],
    });
    const v = codes(out);
    expect(v).toEqual(expect.arrayContaining(['live_act', 'pricey', '18_plus', 'queer_party', 'latinx_party', 'phone_free']));
    expect(v).not.toContain('21_plus');
    expect(out.scalars).toMatchObject({ price_tier: 3, start_lateness: 4, end_lateness: 3 });
    expect(out.crosswalk.ranked[0]?.code).toBe('latin.reggaeton');
    expect(out.vibes.find((x) => x.code === 'queer_party')).toMatchObject({ rule: 'text.queer' });
  });
  it('helper thresholds', () => {
    expect([startLateness(15), startLateness(17), startLateness(20), startLateness(22), startLateness(1)]).toEqual([1, 2, 3, 4, 5]);
    expect([endLateness(22), endLateness(25), endLateness(28), endLateness(30), endLateness(31)]).toEqual([1, 2, 3, 4, 5]);
    expect([priceTier(0, 0), priceTier(15, 15), priceTier(20, 40), priceTier(60, 60), priceTier(61, null), priceTier(null, null)]).toEqual([0, 1, 2, 3, 4, undefined]);
  });
});
