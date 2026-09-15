import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query, withTx } from '../../src/lib/db.js';

/**
 * 0015 recommend_events(). The function reads auth.uid(), which only exists on Supabase, so the local run
 * installs the same stub Supabase uses (the sub claim of the request JWT) and sets it per transaction.
 */
describe.skipIf(!process.env.DATABASE_URL)('recommend_events against Postgres', () => {
  const MARK = 'RecTest 2034';
  const ME = '00000000-0000-4000-8000-00000000fa01';
  const OTHER = '00000000-0000-4000-8000-00000000fa02';
  const ids: Record<string, string> = {};

  const asUser = <T>(uid: string, sql: string, params: unknown[] = []): Promise<T[]> =>
    withTx(async (c) => {
      await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
      const r = await c.query(sql, params);
      return r.rows as T[];
    });

  const mkEvent = async (key: string, title: string, nights: number, genres: string[], vibes: string[], venue: string | null, artists: string[]) => {
    const r = await query<{ event_id: string }>(
      `insert into event (title, night, city, tz, genre_codes, vibe_codes, venue_id, lineup, start_lateness, end_lateness, price_tier)
       values ($1, current_date + $2::int, 'nyc', 'America/New_York', $3::text[], $4::text[],
               (select venue_id from venue where name = $5), $6::text[], 4, 4, 2)
       returning event_id`,
      [`${title} ${MARK}`, nights, genres, vibes, venue, artists],
    );
    ids[key] = r.rows[0]!.event_id;
    await query(`select link_event_artists($1)`, [ids[key]]);
    return ids[key]!;
  };

  beforeAll(async () => {
    await query(`create schema if not exists auth`);
    await query(`create or replace function auth.uid() returns uuid language sql stable
                 as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$`);
    await query(`delete from event where title like $1`, [`%${MARK}%`]);
    await query(`delete from venue where name like $1`, [`%${MARK}%`]);
    await query(`insert into venue (name, city, kind) values ($1, 'nyc', 'venue') on conflict do nothing`, [`Home Room ${MARK}`]);

    // history: one night, one DJ, deep house, all-nighter, at "Home Room"
    await mkEvent('hist', 'History Night', -3, ['house.deep'], ['all_nighter'], `Home Room ${MARK}`, [`RecTest DJ Alpha`]);
    // candidates
    await mkEvent('sameArtist', 'Same Artist', 5, ['techno.peak'], [], null, [`RecTest DJ Alpha`]);
    await mkEvent('sameGenre', 'Same Genre', 6, ['house.deep'], [], null, [`RecTest DJ Beta`]);
    await mkEvent('sameVenue', 'Same Venue', 7, ['trance.psy'], [], `Home Room ${MARK}`, [`RecTest DJ Gamma`]);
    await mkEvent('unrelated', 'Unrelated', 8, ['hiphop.rap'], ['mainstream_club'], null, [`RecTest DJ Delta`]);
    await mkEvent('alreadyGoing', 'Already Going', 9, ['house.deep'], [], null, [`RecTest DJ Alpha`]);

    await query(`insert into going (user_id, event_id) values ($1, $2) on conflict do nothing`, [ME, ids.hist]);
    await query(`insert into going (user_id, event_id) values ($1, $2) on conflict do nothing`, [ME, ids.alreadyGoing]);
  });

  afterAll(async () => {
    await query(`delete from going where user_id in ($1, $2)`, [ME, OTHER]);
    await query(`delete from saved where user_id in ($1, $2)`, [ME, OTHER]);
    await query(`delete from event where title like $1`, [`%${MARK}%`]);
    await query(`delete from venue where name like $1`, [`%${MARK}%`]);
    await query(`delete from artist where name like 'RecTest DJ %'`);
    await closePool();
  });

  it('ranks a returning artist above a shared genre, and that above a shared venue', async () => {
    const rows = await asUser<{ event_id: string; score: number; reasons: { kind: string; detail: string }[]; history_size: number }>(
      ME, `select * from recommend_events(20, 'nyc', 60)`,
    );
    const pos = (k: string) => rows.findIndex((r) => r.event_id === ids[k]);
    expect(pos('sameArtist')).toBe(0);
    expect(pos('sameArtist')).toBeLessThan(pos('sameGenre'));
    expect(pos('sameGenre')).toBeLessThan(pos('sameVenue'));
    expect(Number(rows[0]!.history_size)).toBe(2);
  });

  it('explains itself: the top pick names the DJ the user already saw', async () => {
    const rows = await asUser<{ event_id: string; reasons: { kind: string; detail: string }[] }>(
      ME, `select * from recommend_events(20, 'nyc', 60)`,
    );
    const top = rows.find((r) => r.event_id === ids.sameArtist)!;
    const artist = top.reasons.find((r) => r.kind === 'artist');
    expect(artist?.detail).toContain('RecTest DJ Alpha');
    const venue = rows.find((r) => r.event_id === ids.sameVenue)!.reasons.find((r) => r.kind === 'venue');
    expect(venue?.detail).toContain(`Home Room ${MARK}`);
  });

  it('never recommends something already marked, and drops events sharing nothing', async () => {
    const rows = await asUser<{ event_id: string }>(ME, `select * from recommend_events(20, 'nyc', 60)`);
    const returned = rows.map((r) => r.event_id);
    expect(returned).not.toContain(ids.alreadyGoing);   // already going
    expect(returned).not.toContain(ids.hist);           // the history itself
    expect(returned).not.toContain(ids.unrelated);      // no overlap at all -> not a recommendation
  });

  it('returns nothing for a user with no history, and never leaks another user\'s taste', async () => {
    const none = await asUser<{ event_id: string }>(OTHER, `select * from recommend_events(20, 'nyc', 60)`);
    expect(none).toEqual([]);
    // the function takes no user argument: OTHER cannot ask for ME's profile
    const src = await query<{ def: string }>(`select pg_get_functiondef(p.oid) as def from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='recommend_events'`);
    expect(src.rows[0]!.def).toContain('auth.uid()');
    expect(src.rows[0]!.def).toMatch(/security definer/i);
    expect(src.rows[0]!.def).toMatch(/search_path/i);
  });

  it('saved counts for less than going', async () => {
    // a second user whose only signal is a *saved* deep-house night still gets deep-house recommendations
    await query(`insert into saved (user_id, event_id) values ($1, $2) on conflict do nothing`, [OTHER, ids.hist]);
    const rows = await asUser<{ event_id: string; score: number }>(OTHER, `select * from recommend_events(20, 'nyc', 60)`);
    expect(rows.map((r) => r.event_id)).toContain(ids.sameGenre);
    const mine = await asUser<{ event_id: string; score: number }>(ME, `select * from recommend_events(20, 'nyc', 60)`);
    const savedScore = rows.find((r) => r.event_id === ids.sameGenre)!.score;
    const goingScore = mine.find((r) => r.event_id === ids.sameGenre)!.score;
    expect(Number(savedScore)).toBeLessThanOrEqual(Number(goingScore));
  });
});
