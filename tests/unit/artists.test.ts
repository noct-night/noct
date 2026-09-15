import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../../src/lib/db.js';

/** 0013: canonical line-ups resolved into artist / event_artist rows. */
describe.skipIf(!process.env.DATABASE_URL)('artist linking against Postgres', () => {
  const MARK = 'ArtistTest 2033';
  const NIGHT = '2033-06-11';
  let eventId = '';

  const seed = async (lineup: string[]) => {
    await query(`delete from event where title like $1`, [`%${MARK}%`]);
    const r = await query<{ event_id: string }>(
      `insert into event (title, night, lineup, city, tz) values ($1, $2::date, $3::text[], 'nyc', 'America/New_York') returning event_id`,
      [`Probe ${MARK}`, NIGHT, lineup],
    );
    eventId = r.rows[0]!.event_id;
    return eventId;
  };
  const roster = () =>
    query<{ name: string; disambig: string | null; position: number; group_pos: number; is_live: boolean }>(
      `select a.name, a.disambig, ea.position, ea.group_pos, ea.is_live
       from event_artist ea join artist a using (artist_id) where ea.event_id = $1
       order by ea.position, ea.group_pos`,
      [eventId],
    );

  beforeAll(async () => {
    await query(`delete from event where title like $1`, [`%${MARK}%`]);
  });
  afterAll(async () => {
    await query(`delete from event where title like $1`, [`%${MARK}%`]);
    await query(`delete from artist a where not exists (select 1 from event_artist e where e.artist_id = a.artist_id)
                   and a.name in ('Probe Only Kendig','Probe Only Axon','Probe Only Lake','Probe Only Harkin','Probe Only Solo')`);
    await closePool();
  });

  it('splits b2b into one billing position, keeps (live) and the country tag, drops placeholders', async () => {
    await seed([
      'Probe Only Kendig b2b Probe Only Axon (US)',
      'Probe Only Lake (live)',
      'TBA',
      'Special Guest',
      'Probe Only Harkin All Night',
    ]);
    const n = await query<{ n: number }>(`select link_event_artists($1) as n`, [eventId]);
    expect(Number(n.rows[0]!.n)).toBe(4);
    const rows = (await roster()).rows;
    expect(rows.map((r) => [r.name, r.disambig, r.position, r.group_pos, r.is_live])).toEqual([
      ['Probe Only Kendig', null, 1, 1, false],
      ['Probe Only Axon', 'US', 1, 2, false],   // same billing line as Kendig
      ['Probe Only Lake', null, 2, 1, true],
      ['Probe Only Harkin', null, 5, 1, false], // "All Night" stripped; TBA / Special Guest skipped
    ]);
  });

  it('is idempotent and only revisits events whose line-up changed', async () => {
    await seed(['Probe Only Solo']);
    // a fresh event has no lineup_key, so it is pending
    const first = await query<{ n: number }>(`select link_pending_artists(5000) as n`);
    expect(Number(first.rows[0]!.n)).toBeGreaterThanOrEqual(1);
    expect((await roster()).rows.map((r) => r.name)).toEqual(['Probe Only Solo']);

    const second = await query<{ n: number }>(`select link_pending_artists(5000) as n`);
    expect(Number(second.rows[0]!.n)).toBe(0);           // nothing changed, nothing re-linked

    await query(`update event set lineup = $2::text[] where event_id = $1`, [eventId, ['Probe Only Solo', 'Probe Only Lake']]);
    const third = await query<{ n: number }>(`select link_pending_artists(5000) as n`);
    expect(Number(third.rows[0]!.n)).toBe(1);            // the changed line-up, and only it
    expect((await roster()).rows.map((r) => r.name)).toEqual(['Probe Only Solo', 'Probe Only Lake']);
  });

  it('reuses one artist row across nights and honours curated aliases', async () => {
    await seed(['Probe Only Solo']);
    await query(`select link_event_artists($1)`, [eventId]);
    const id1 = (await query<{ artist_id: string }>(`select artist_id from event_artist where event_id = $1`, [eventId])).rows[0]!.artist_id;

    await seed(['probe   only   SOLO']);                 // same name, different spacing/case
    await query(`select link_event_artists($1)`, [eventId]);
    const id2 = (await query<{ artist_id: string }>(`select artist_id from event_artist where event_id = $1`, [eventId])).rows[0]!.artist_id;
    expect(id2).toBe(id1);                               // normalised match, not a second row

    // an alias redirects a variant spelling onto the same artist
    await query(`insert into artist_alias (alias_norm, artist_id, kind) values (norm_text('Probe Only Sollo'), $1, 'alias')
                 on conflict (alias_norm) do update set artist_id = excluded.artist_id`, [id1]);
    await seed(['Probe Only Sollo']);
    await query(`select link_event_artists($1)`, [eventId]);
    const id3 = (await query<{ artist_id: string }>(`select artist_id from event_artist where event_id = $1`, [eventId])).rows[0]!.artist_id;
    expect(id3).toBe(id1);
    await query(`delete from artist_alias where alias_norm = norm_text('Probe Only Sollo')`);
  });

  it('never creates an artist for a placeholder', async () => {
    for (const p of ['TBA', 'Special Guest', 'Surprise Guests', 'more', 'DJs', 'Open Decks']) {
      const r = await query<{ id: string | null }>(`select resolve_artist($1) as id`, [p]);
      expect(r.rows[0]!.id, p).toBeNull();
    }
    expect((await query<{ n: number }>(`select count(*)::int as n from artist where is_placeholder_artist(name_norm)`)).rows[0]!.n).toBe(0);
  });

  it('going_count stays an owner-privilege view (0005/0013, not security_invoker)', async () => {
    const r = await query<{ opts: string[] | null }>(`select reloptions as opts from pg_class where relname = 'going_count'`);
    const opts = r.rows[0]?.opts ?? [];
    expect(opts.join(',')).not.toContain('security_invoker');
  });
});
