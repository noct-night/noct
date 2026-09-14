import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool, query } from '../../src/lib/db.js';

const SEED = new URL('../../supabase/migrations/0006_seed_venues.sql', import.meta.url);
/** Same key as tests/unit/feed.test.ts: vitest runs files in parallel and both touch the venue tables. */
const VENUE_TABLES_LOCK = 720611;

interface Resolved {
  venue_id: string;
  method: string;
  score: number;
  slug: string | null;
  kind: string;
  family_slug: string | null;
}

async function resolve(source: string, sourceId: string | null, name: string): Promise<Resolved | undefined> {
  const r = await query<Resolved>(
    `select r.venue_id, r.method, r.score, v.slug, v.kind, f.slug as family_slug
     from resolve_venue($1, $2, $3) r
     join venue v on v.venue_id = r.venue_id
     join venue f on f.venue_id = venue_family(r.venue_id)`,
    [source, sourceId, name],
  );
  return r.rows[0];
}

/**
 * What the seed owns, minus what changes on every apply (updated_at) and what ingest adds concurrently:
 * provisional venues ('<name>-<hash6>') and learned source labels (kind source_label with a source_key).
 */
async function curatedSnapshot(): Promise<unknown> {
  const venues = await query(
    `select v.slug, v.name, v.kind, p.slug as parent_slug, v.address, v.postal_code, v.borough, v.neighborhood, v.website, v.instagram,
            v.ra_url, v.dice_url, v.capacity, v.space_types, v.outdoor, v.underground_prior, v.typical_genres, v.vibe_priors, v.verified, v.needs_review, v.notes
     from venue v left join venue p on p.venue_id = v.parent_venue_id
     where v.slug !~ '-[0-9a-f]{6}$' order by v.slug`);
  const aliases = await query(
    `select a.alias_norm, a.alias, a.kind, a.source_key, v.slug from venue_alias a join venue v on v.venue_id = a.venue_id
     where a.kind <> 'source_label' order by a.alias_norm`);
  return { venues: venues.rows, aliases: aliases.rows };
}

describe.skipIf(!process.env.DATABASE_URL)('0006 venue seed against Postgres', () => {
  let seedSql = '';
  let provisionalId: string | null = null;
  // true when a previous ingest into this database already learned the alias 'lohi' (then it points at the curated row)
  let aliasPreexisted = false;
  let lock: pg.PoolClient | undefined;

  beforeAll(async () => {
    lock = await getPool().connect();
    await lock.query('select pg_advisory_lock($1)', [VENUE_TABLES_LOCK]);
    seedSql = await readFile(SEED, 'utf8');
    // Simulate ingest running BEFORE the seed on a fresh database: no curated LoHi row exists, so upsert_listing()
    // creates a provisional venue ('lohi-<hash6>', needs_review) and learns the alias 'lohi'. The seed must still
    // apply on top of that. Only removable when nothing references the curated row (a re-used dev database).
    await query(`delete from venue v where v.slug = 'lohi'
                   and not exists (select 1 from listing l where l.venue_id = v.venue_id)
                   and not exists (select 1 from event e where e.venue_id = v.venue_id)`);
    aliasPreexisted = (await query(`select 1 from venue_alias where alias_norm = 'lohi'`)).rows.length > 0;
    const p = await query<{ id: string }>(`select create_provisional_venue('dice', null, 'LoHi', 'Brooklyn, NY', null, null) as id`);
    provisionalId = p.rows[0]!.id;
  });
  afterAll(async () => {
    // leave the database as the seed defines it; the provisional row goes unless a listing already points at it
    if (provisionalId) await query(`delete from venue v where v.venue_id = $1 and not exists (select 1 from listing l where l.venue_id = v.venue_id)`, [provisionalId]);
    await lock?.query('select pg_advisory_unlock($1)', [VENUE_TABLES_LOCK]);
    lock?.release();
    await closePool();
  });

  it('applies over a provisional venue and is idempotent', async () => {
    await expect(query(seedSql)).resolves.toBeDefined();
    const first = await curatedSnapshot();
    await expect(query(seedSql)).resolves.toBeDefined();
    expect(await curatedSnapshot()).toEqual(first);
    expect((first as { venues: unknown[] }).venues.length).toBeGreaterThanOrEqual(50);

    const rows = await query<{ slug: string; needs_review: boolean }>(`select slug, needs_review from venue where name_norm = 'lohi' order by slug`);
    expect(rows.rows.map((r) => r.slug)).toEqual(['lohi', expect.stringMatching(/^lohi-[0-9a-f]{6}$/)]);
    // the learned alias still wins over the curated name (alias_exact runs before name_exact), so listings ingested
    // before the seed keep resolving to the provisional row: a one-time manual merge, documented in 0006.
    const lohi = await resolve('dice', null, 'LoHi');
    expect(lohi?.method).toBe('alias_exact');
    if (!aliasPreexisted) expect(lohi?.venue_id).toBe(provisionalId);
    // the documented merge: point the alias at the curated row and the next run resolves there
    await query(`update venue_alias set venue_id = (select venue_id from venue where slug = 'lohi') where alias_norm = 'lohi'`);
    expect((await resolve('dice', null, 'LoHi'))?.slug).toBe('lohi');
  });

  it('resolves by source id, alias, name and trigram in that order', async () => {
    expect(await resolve('ra', '105873', 'Nowadays')).toMatchObject({ method: 'external_id', slug: 'nowadays', family_slug: 'nowadays' });
    // an unknown id falls through to the name (or to the label a previous ingest learned for it)
    const fallthrough = await resolve('ra', '000000', 'Nowadays');
    expect(fallthrough?.slug).toBe('nowadays');
    expect(fallthrough?.method).toMatch(/^(name|alias)_exact$/);
    expect(await resolve('edmtrain', null, 'Pacha New York')).toMatchObject({ method: 'alias_exact', slug: 'avant-gardner', family_slug: 'avant-gardner' });
    expect(await resolve('ra', '286414', 'Pacha New York')).toMatchObject({ method: 'external_id', slug: 'avant-gardner' });
    expect(await resolve('dice', null, 'Knockdown Center Maspeth')).toMatchObject({ method: 'trgm', slug: 'knockdown-center' });
    expect((await resolve('dice', null, 'Knockdown Center Maspeth'))!.score).toBeGreaterThanOrEqual(0.55);
    expect(await resolve('edmtrain', null, 'BASEMENT NY')).toMatchObject({ slug: 'basement', family_slug: 'basement' });
    expect(await resolve('ra', null, 'public records')).toMatchObject({ slug: 'public-records' });
    expect(await resolve('edmtrain', null, 'Signal Brooklyn')).toMatchObject({ slug: 'signal' });
    expect(await resolve('dice', '2435', 'Public Records')).toMatchObject({ method: 'external_id', slug: 'public-records' });
    expect(await resolve('ra', null, 'TBA - Brooklyn')).toMatchObject({ slug: 'tba-brooklyn', kind: 'tba' });
    expect(await resolve('ra', null, 'Secret Venue')).toMatchObject({ slug: 'secret-location', kind: 'secret' });
    // short unknown names never trigram-match anything
    expect(await resolve('ra', null, 'Zzz')).toBeUndefined();
  });

  it('rolls rooms up to their complex through venue_family()', async () => {
    expect(await resolve('elsewhere', null, 'Elsewhere Zone One')).toMatchObject({ slug: 'elsewhere-zone-one', kind: 'room', family_slug: 'elsewhere' });
    expect(await resolve('ra', null, 'Avant Gardner - The Great Hall')).toMatchObject({ slug: 'the-great-hall', family_slug: 'avant-gardner' });
    expect(await resolve('dice', null, 'The Ruins at Knockdown Center')).toMatchObject({ slug: 'knockdown-ruins', kind: 'outdoor', family_slug: 'knockdown-center' });
    expect(await resolve('ra', null, 'Nowadays (Yard)')).toMatchObject({ slug: 'nowadays-yard', family_slug: 'nowadays' });
    expect(await resolve('ra', null, 'Bad Room')).toMatchObject({ slug: 'bad-room', family_slug: 'good-room' });
    // BASEMENT shares the Knockdown site but is its own operator: never in the Knockdown family
    const fam = await query<{ same: boolean }>(`select venue_family(b.venue_id) = venue_family(k.venue_id) as same from venue b, venue k where b.slug = 'basement' and k.slug = 'knockdown-center'`);
    expect(fam.rows[0]!.same).toBe(false);
  });

  it('keeps the curated invariants', async () => {
    // curated rows only: other DB tests insert slug-less venues (with phone policies) and ingest adds provisional ones
    const curated = `slug is not null and slug !~ '-[0-9a-f]{6}$'`;
    const orphans = await query(`select slug from venue where ${curated} and kind = 'room' and parent_venue_id is null`);
    expect(orphans.rows).toEqual([]);
    const childless = await query(`select c.slug from venue c where ${curated} and c.kind = 'complex' and not exists (select 1 from venue r where r.parent_venue_id = c.venue_id)`);
    expect(childless.rows).toEqual([]);
    // nothing is claimed as verified beyond the two prototype-verified addresses, and no phone policy is asserted
    const verified = await query<{ slug: string }>(`select slug from venue where ${curated} and verified order by slug`);
    expect(verified.rows.map((r) => r.slug)).toEqual(['basement', 'nowadays']);
    const phones = await query(`select slug from venue where ${curated} and phone_policy is not null`);
    expect(phones.rows).toEqual([]);
    // ingest may add provisional tba rows for labels the aliases do not cover; the seeded sentinels must all be there
    const tba = await query<{ slug: string }>(`select slug from venue where kind in ('tba','secret') order by slug`);
    expect(tba.rows.map((r) => r.slug)).toEqual(expect.arrayContaining(['secret-location', 'tba-bronx', 'tba-brooklyn', 'tba-manhattan', 'tba-new-york', 'tba-queens', 'tba-staten-island']));
    // the source ids from the research notes (learn_venue_ref() adds more over time, so check these, not a count)
    const ext = await query<{ source_key: string; source_id: string; slug: string }>(
      `select x.source_key, x.source_id, v.slug from venue_external_id x join venue v using (venue_id)
       where (x.source_key, x.source_id) in (('ra','105873'),('ra','165976'),('ra','69401'),('ra','256148'),('ra','2495'),('ra','137550'),
             ('ra','97606'),('ra','195815'),('ra','71292'),('ra','105938'),('ra','286414'),('ra','236259'),('dice','2435'))
       order by x.source_key, x.source_id`);
    expect(Object.fromEntries(ext.rows.map((r) => [`${r.source_key}:${r.source_id}`, r.slug]))).toEqual({
      'dice:2435': 'public-records',
      'ra:105873': 'nowadays', 'ra:105938': 'avant-gardner', 'ra:137550': 'h0l0', 'ra:165976': 'basement', 'ra:195815': 'paragon',
      'ra:236259': 'brooklyn-army-terminal', 'ra:2495': 'moma-ps1', 'ra:256148': 'signal', 'ra:286414': 'avant-gardner',
      'ra:69401': 'knockdown-center', 'ra:71292': 'bossa-nova-civic-club', 'ra:97606': 'good-room',
    });
  });
});
