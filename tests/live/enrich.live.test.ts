/**
 * Opt-in tests for the enrichment pipeline.
 *
 *  - "live classifier": NOCT_LIVE=1 + ANTHROPIC_API_KEY — one real Claude call on the Ivkovic example.
 *  - "database run": DATABASE_URL set (e.g. `bash scripts/db-local.sh noct_enrich`) — seeds a venue, a promoter and two
 *    listings through upsert_listing(), then runs runEnrichment() with a FAKE classifier and checks what was written.
 */
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../../src/lib/db.js';
import { localDatePlus, zonedToUtc } from '../../src/lib/time.js';
import { classifyEvent, type ClassifierClient, type ClassifierResponse, type RawClassifierOutput } from '../../src/enrich/classify.js';
import { buildEvidenceBundle, computeInputHash, toRuleInput, type CandidateRow } from '../../src/enrich/evidence.js';
import { applyRules } from '../../src/enrich/rules.js';
import { mergeOutputs, runEnrichment } from '../../src/enrich/run.js';
import { GENRE_BY_CODE } from '../../src/enrich/taxonomy.js';

const ny = (local: string): string => (zonedToUtc(local) as Date).toISOString();

const IVKOVIC: CandidateRow = {
  event_id: '00000000-0000-0000-0000-000000000001',
  title: 'Vladimir Ivkovic All Night',
  night: '2026-09-12',
  starts_at: ny('2026-09-12T22:00:00'), ends_at: ny('2026-09-13T06:00:00'), has_time: true, status: 'scheduled',
  age_min: 21, genres: [], lineup: ['Vladimir Ivkovic'],
  description: 'Nowadays resident and Offen Music founder, playing the full night. Low tempo, psychedelic, drawing on coldwave and outsider dance music. $10 before 23:00, $15 before midnight.',
  interested_count: 412, source_tags: { ra: {} }, input_hash: null, classification_version: null, venue_id: '00000000-0000-0000-0000-0000000000aa',
  venue: { name: 'Nowadays', kind: 'venue', neighborhood: 'Ridgewood', borough: 'Queens', capacity: 600, space_types: ['club', 'outdoor_yard'], outdoor: true, phone_policy: 'no_photos', typical_genres: ['house.deep', 'leftfield.experimental'], vibe_priors: ['sound_system_focus', '21_plus'], underground_prior: 5, notes: null },
  promoters: [], listing_promoters: ['Nowadays'],
  source_genres: [], price_min: 10, price_max: 15, price_note: null, sold_out: false,
  artist_profiles: [{ name: 'Vladimir Ivkovic', source: 'discogs', status: 'ok', release_count: 14, taxonomy: { 'leftfield.experimental': 0.5, 'techno.peak': 0.2, 'leftfield.ambient': 0.2 }, styles: { Techno: 2, Ambient: 2, Abstract: 2, Experimental: 2 } }],
  human_tags: [],
};

describe.skipIf(!process.env.NOCT_LIVE || !process.env.ANTHROPIC_API_KEY)('live classifier (NOCT_LIVE + ANTHROPIC_API_KEY)', () => {
  it('classifies the Ivkovic example into a house/techno/leftfield family with at least one vibe', async () => {
    const rules = applyRules(toRuleInput(IVKOVIC));
    const bundle = buildEvidenceBundle(IVKOVIC, rules);
    const client = new Anthropic() as unknown as ClassifierClient;
    const res = await classifyEvent({ bundle, client });
    expect(res.ok, !res.ok ? res.error : '').toBe(true);
    if (!res.ok) return;
    const primary = res.output.genres[0]!;
    expect(['house', 'techno', 'leftfield']).toContain(GENRE_BY_CODE.get(primary.code)?.family);
    expect(primary.why.length).toBeGreaterThan(5);
    expect(res.output.is_electronic).toBe(true);
    const merged = mergeOutputs(IVKOVIC, rules, res.output);
    expect(merged.vibes.length).toBeGreaterThanOrEqual(1);
    expect(merged.vibes.map((v) => v.code)).toContain('all_nighter');
    expect(res.usage.input_tokens + res.usage.cache_read_input_tokens + res.usage.cache_creation_input_tokens).toBeGreaterThan(2000);
    expect(res.costUsd).toBeGreaterThan(0);
    expect(res.costUsd).toBeLessThan(0.2);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------
// Database-backed end-to-end run with a fake classifier
// ---------------------------------------------------------------------------------------------------
const MARK = '[enrich-test]';
const CANNED_BY_TITLE: Array<[RegExp, RawClassifierOutput]> = [
  [/Ivkovic/, {
    genres: [{ code: 'leftfield.experimental', confidence: '0.8', why: 'description: coldwave, outsider dance music; artist profile' }, { code: 'techno.dub', confidence: '0.5', why: 'RA tag Techno, low tempo all night' }],
    vibes: [{ code: 'underground', why: 'venue prior' }],
    scalars: { energy: '2', darkness: '4', crowd_size: '3', start_lateness: '4', end_lateness: '4', underground_index: '5', price_tier: '1' },
    sound_summary: 'Slow, psychedelic leftfield selections all night in the main room.', is_electronic: true, flags: [],
  }],
  [/Mister Sunday/, {
    genres: [{ code: 'house.deep', confidence: '0.65', why: 'promoter prior house/disco; resident DJ' }, { code: 'house.disco', confidence: '0.5', why: 'promoter prior' }],
    vibes: [{ code: 'local_crews', why: 'resident-run series' }],
    scalars: { energy: '3', darkness: '1', crowd_size: '3', start_lateness: '1', end_lateness: '1', underground_index: '4', price_tier: '1' },
    sound_summary: 'Sun-soaked deep house and disco in the yard, one resident all day.', is_electronic: true, flags: ['sparse_input'],
  }],
];

function fakeClient(): { client: ClassifierClient; bundles: string[] } {
  const bundles: string[] = [];
  const client: ClassifierClient = {
    messages: {
      async parse(params): Promise<ClassifierResponse> {
        const bundle = String((params.messages[0] as { content: string }).content);
        bundles.push(bundle);
        const canned = CANNED_BY_TITLE.find(([re]) => re.test(bundle))?.[1];
        if (!canned) throw new Error(`fake classifier: no canned output for bundle starting "${bundle.slice(0, 40)}"`);
        return { stop_reason: 'end_turn', parsed_output: canned, model: 'claude-opus-5', usage: { input_tokens: 600, output_tokens: 400, cache_read_input_tokens: 2500, cache_creation_input_tokens: 0 } };
      },
    },
  };
  return { client, bundles };
}

describe.skipIf(!process.env.DATABASE_URL)('runEnrichment against the database (fake classifier)', () => {
  const night1 = localDatePlus(3);
  const night2 = localDatePlus(4);
  let ivkovicId = '';
  let sundayId = '';

  async function cleanup(): Promise<void> {
    await query(`delete from listing where source_id like 'enrich-test-%'`);
    await query(`delete from event where title like $1`, [`%${MARK}%`]);
    await query(`delete from promoter where name like $1`, [`%${MARK}%`]);
    await query(`delete from venue where name like $1`, [`%${MARK}%`]);
  }

  beforeAll(async () => {
    await cleanup();
    await query(
      `insert into venue (name, kind, capacity, space_types, outdoor, phone_policy, typical_genres, vibe_priors, underground_prior)
       values ($1, 'venue', 600, '{club,outdoor_yard}', true, 'no_photos', '{house.deep,leftfield.experimental}', '{sound_system_focus,21_plus}', 5)`,
      [`Nowadays ${MARK}`],
    );
    await query(
      `insert into promoter (name, aliases, genre_priors, vibe_priors, underground_prior) values ($1, '{"Mister Saturday Night"}', '{house.deep,house.disco}', '{weekly_residency,local_crews}', 4)`,
      [`Mister Sunday ${MARK}`],
    );
    const up = async (sourceKey: string, id: string, title: string, start: string, end: string, night: string, lineup: string[], priceMin: number, priceMax: number, genres: string[], promoters: string[], description: string, tags: unknown) =>
      query(
        `select * from upsert_listing($1,$2,$3,$4::jsonb,null,$5,$6::timestamptz,$7::timestamptz,true,$8::date,$9,null,null,null,null,$10::text[],$11,$12,true,null,'[]'::jsonb,false,'scheduled',21,$13::text[],$14::text[],$15,null,412,$16::jsonb,'[]'::jsonb)`,
        [sourceKey, id, null, JSON.stringify({ test: true }), title, start, end, night, `Nowadays ${MARK}`, lineup, priceMin, priceMax, genres, promoters, description, JSON.stringify(tags)],
      );
    await up('ra', 'enrich-test-1', `Vladimir Ivkovic All Night ${MARK}`, ny(`${night1}T22:00:00`), ny(`${localDatePlus(4)}T06:00:00`), night1, ['Vladimir Ivkovic'], 10, 15, ['Techno'], ['Nowadays'],
      'Nowadays resident and Offen Music founder, playing the full night. Low tempo, psychedelic, drawing on coldwave and outsider dance music. $10 before 23:00, $15 before midnight.', { ra: { genres: ['Techno'] } });
    await up('ra', 'enrich-test-2', `Mister Sunday: Eamon Harkin All Day ${MARK}`, ny(`${night2}T15:00:00`), ny(`${night2}T21:00:00`), night2, ['Eamon Harkin All Day'], 15, 25, [], ['Mister Saturday Night'],
      'In the yard. $10 off the door before 16:00, $5 off before 17:00.', { ra: {} });
    await query('select resolve_pending()');
    const ev = await query<{ event_id: string; title: string }>(`select event_id, title from event where title like $1 order by night`, [`%${MARK}%`]);
    expect(ev.rows).toHaveLength(2);
    ivkovicId = ev.rows[0]!.event_id;
    sundayId = ev.rows[1]!.event_id;
  });

  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  it('writes denormalised columns, provenance tags and a run record; reruns skip unchanged events', async () => {
    const { client, bundles } = fakeClient();
    const first = await runEnrichment({ client, limit: 10, eventIds: [ivkovicId, sundayId] });
    expect(first.errors).toEqual([]);
    expect(first).toMatchObject({ model: 'claude-opus-5', considered: 2, rulesApplied: 2, classified: 2, skipped: 0 });
    expect(first.costUsd).toBeCloseTo(2 * 0.01425, 6);
    expect(bundles).toHaveLength(2);
    expect(bundles.find((b) => /Ivkovic/.test(b))).toMatch(/source genres: ra: Techno/);
    expect(bundles.find((b) => /Mister Sunday/.test(b))).toMatch(/promoter prior: Mister Sunday \[enrich-test\] — genres house.deep, house.disco/);

    const iv = (await query(`select * from event where event_id = $1`, [ivkovicId])).rows[0]!;
    expect(iv.primary_genre).toBe('leftfield.experimental');
    expect(iv.genre_codes).toEqual(['leftfield.experimental', 'techno.dub']);
    expect(Number(iv.genre_confidence)).toBe(0.8);
    expect(iv.vibe_codes).toEqual(expect.arrayContaining(['all_nighter', 'one_dj_all_night', 'long_sets', 'cheap_early', 'phone_free', 'sound_system_focus', '21_plus', 'underground']));
    expect(iv).toMatchObject({ energy: 2, darkness: 4, crowd_size: 3, start_lateness: 4, end_lateness: 4, price_tier: 1, underground_index: 5, is_electronic: true, needs_review: false });
    expect(iv.classification_version).toBe('rules-v1/p1/claude-opus-5');
    expect(iv.classified_at).toBeTruthy();
    expect(iv.input_hash).toMatch(/^[0-9a-f]{64}$/);

    const su = (await query(`select * from event where event_id = $1`, [sundayId])).rows[0]!;
    expect(su.primary_genre).toBe('house.deep');
    expect(su.needs_review).toBe(true); // sparse_input flag
    expect(su.vibe_codes).toEqual(expect.arrayContaining(['sunny_day_party', 'outdoor_yard', 'weekly_residency', 'local_crews', 'cheap_early']));

    const tags = await query<{ kind: string; code: string; status: string; confidence: string; sources: { source: string }[] }>(
      `select kind, code, status, confidence, sources from event_tag where event_id = $1 order by kind, code`, [ivkovicId],
    );
    const genreTags = tags.rows.filter((t) => t.kind === 'genre');
    expect(genreTags.map((t) => t.code)).toEqual(['leftfield.experimental', 'techno.dub']);
    expect(genreTags[0]?.sources.map((s) => s.source)).toEqual(expect.arrayContaining(['llm', 'text:description', 'venue_prior']));
    expect(tags.rows.every((t) => t.status === 'auto')).toBe(true);
    const phone = tags.rows.find((t) => t.kind === 'vibe' && t.code === 'phone_free');
    expect(phone?.sources[0]?.source).toBe('rule:venue.phone_policy');

    const runs = await query<{ model: string; cost_usd: string; input_tokens: number; error: string | null }>(`select model, cost_usd, input_tokens, error from classification_run where event_id = $1`, [ivkovicId]);
    expect(runs.rows).toEqual([{ model: 'claude-opus-5', cost_usd: '0.01425', input_tokens: 600, error: null }]);

    // unchanged inputs -> skipped without another model call (event ids narrow the run; they do not force it)
    const second = await runEnrichment({ client, limit: 10, eventIds: [ivkovicId, sundayId] });
    expect(second).toMatchObject({ considered: 2, skipped: 2, classified: 0, costUsd: 0 });
    expect(bundles).toHaveLength(2);
    // force -> classified again
    const third = await runEnrichment({ client, limit: 10, force: true, eventIds: [ivkovicId] });
    expect(third.classified).toBe(1);
    expect(bundles).toHaveLength(3);
  });

  it('keeps human-verified tags, drops rejected ones, and falls back to rules-only without a client', async () => {
    await query(`insert into event_tag (event_id, kind, code, confidence, sources, status) values ($1, 'genre', 'electro.ebm_industrial', 0.9, '[{"source":"community","evidence":"votes"}]', 'community')
                 on conflict (event_id, kind, code) do update set status = 'community', confidence = 0.9`, [ivkovicId]);
    await query(`insert into event_tag (event_id, kind, code, confidence, sources, status) values ($1, 'vibe', 'underground', 0.5, '[]', 'rejected')
                 on conflict (event_id, kind, code) do update set status = 'rejected'`, [ivkovicId]);

    const rulesOnly = await runEnrichment({ client: null, limit: 10, force: true, eventIds: [ivkovicId] });
    expect(rulesOnly).toMatchObject({ model: 'rules-only', classified: 0, rulesApplied: 1, costUsd: 0, errors: [] });
    const iv = (await query(`select * from event where event_id = $1`, [ivkovicId])).rows[0]!;
    expect(iv.genre_codes[0]).toBe('electro.ebm_industrial');       // community tag first
    expect(iv.genre_codes).toContain('techno.peak');                 // RA "Techno" via crosswalk, capped
    expect(Number(iv.genre_confidence)).toBe(0.9);
    expect(iv.vibe_codes).not.toContain('underground');              // rejected by humans
    expect(iv.vibe_codes).toContain('all_nighter');
    expect(iv.energy).toBeNull();                                    // rules cannot judge energy
    expect(iv.classification_version).toBe('rules-v1/p1/rules');
    const tags = await query<{ code: string; status: string }>(`select code, status from event_tag where event_id = $1 and kind = 'genre' order by code`, [ivkovicId]);
    expect(tags.rows.find((t) => t.code === 'electro.ebm_industrial')?.status).toBe('community');
    const conf = await query<{ confidence: string }>(`select confidence from event_tag where event_id = $1 and code = 'techno.peak'`, [ivkovicId]);
    expect(Number(conf.rows[0]?.confidence)).toBeLessThanOrEqual(0.5);
    const runs = await query<{ model: string | null }>(`select model from classification_run where event_id = $1 order by id desc limit 1`, [ivkovicId]);
    expect(runs.rows[0]?.model).toBeNull();
  });

  it('a quota error (429 twice) ends the run without parking the event as classified', async () => {
    await query(`update event set classified_at = null, input_hash = null, classification_version = null where event_id = $1`, [sundayId]);
    const before = (await query(`select count(*)::int as n from classification_run where event_id = $1`, [sundayId])).rows[0]!.n;
    const quotaClient = { messages: { parse: async () => { throw new Error('RateLimitError 429: daily quota exceeded'); } } };
    const res = await runEnrichment({ client: quotaClient, limit: 10, eventIds: [sundayId] });
    expect(res.quotaStopped).toBe(true);
    expect(res.classified).toBe(0);
    expect(res.errors[0]).toMatch(/429/);
    const ev = (await query(`select classified_at, input_hash from event where event_id = $1`, [sundayId])).rows[0]!;
    expect(ev.classified_at).toBeNull();                              // still pending for the next run
    expect(ev.input_hash).toBeNull();
    const after = (await query(`select count(*)::int as n from classification_run where event_id = $1`, [sundayId])).rows[0]!.n;
    expect(after).toBe(before);                                       // nothing recorded, nothing spent
  });

  it('a transient provider error (503) defers the event without recording a run, and the loop continues', async () => {
    await query(`update event set classified_at = null, input_hash = null, classification_version = null where event_id = any($1)`, [[ivkovicId, sundayId]]);
    let n = 0;
    const flaky = { messages: { parse: async () => { n++; throw new Error('HTTP 503 from https://x/chat/completions: high demand'); } } };
    const res = await runEnrichment({ client: flaky, limit: 10, eventIds: [ivkovicId, sundayId] });
    expect(n).toBe(2);                                                  // both attempted (no stop)
    expect(res.deferred).toBe(2);
    expect(res.quotaStopped).toBeUndefined();
    const rows = await query(`select classified_at from event where event_id = any($1)`, [[ivkovicId, sundayId]]);
    expect(rows.rows.every((r) => r.classified_at === null)).toBe(true);
  });

  it('input_hash is stable for identical inputs and changes when priors change', () => {
    const a = computeInputHash(IVKOVIC);
    expect(computeInputHash({ ...IVKOVIC, interested_count: 9999 })).toBe(a);
    expect(computeInputHash({ ...IVKOVIC, venue: { ...IVKOVIC.venue!, phone_policy: 'pouch' } })).not.toBe(a);
    expect(computeInputHash({ ...IVKOVIC, description: 'changed' })).not.toBe(a);
  });
});
