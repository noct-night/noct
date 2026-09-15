import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query, withTx } from '../../src/lib/db.js';

/**
 * 0015 recommend_events() and the 0016 quality pass (class filter, per-venue cap, feedback loop). The
 * function reads auth.uid(), which only exists on Supabase, so the local run installs the same stub Supabase
 * uses (the sub claim of the request JWT) and sets it per transaction.
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
    await query(`insert into venue (name, city, kind) values ($1, 'nyc', 'venue') on conflict do nothing`, [`Cap Room ${MARK}`]);

    // history: one night, one DJ, deep house, all-nighter, at "Home Room"
    await mkEvent('hist', 'History Night', -3, ['house.deep'], ['all_nighter'], `Home Room ${MARK}`, [`RecTest DJ Alpha`]);
    // candidates
    await mkEvent('sameArtist', 'Same Artist', 5, ['techno.peak'], [], null, [`RecTest DJ Alpha`]);
    await mkEvent('sameGenre', 'Same Genre', 6, ['house.deep'], [], null, [`RecTest DJ Beta`]);
    await mkEvent('sameVenue', 'Same Venue', 7, ['trance.psy'], [], `Home Room ${MARK}`, [`RecTest DJ Gamma`]);
    await mkEvent('unrelated', 'Unrelated', 8, ['hiphop.rap'], ['mainstream_club'], null, [`RecTest DJ Delta`]);
    await mkEvent('alreadyGoing', 'Already Going', 9, ['house.deep'], [], null, [`RecTest DJ Alpha`]);
    // one room with three qualifying nights, for the diversity cap
    await mkEvent('cap1', 'Cap One', 10, ['house.deep'], [], `Cap Room ${MARK}`, [`RecTest DJ Eps`]);
    await mkEvent('cap2', 'Cap Two', 11, ['house.deep'], [], `Cap Room ${MARK}`, [`RecTest DJ Zeta`]);
    await mkEvent('cap3', 'Cap Three', 12, ['house.deep'], [], `Cap Room ${MARK}`, [`RecTest DJ Eta`]);
    // a workshop at the venue the user already goes to: the strongest possible case for the class filter
    await mkEvent('class', 'Intro to Ableton Lab: Building Chords', 13, ['house.deep'], ['all_nighter'], `Home Room ${MARK}`, []);

    await query(`insert into going (user_id, event_id) values ($1, $2) on conflict do nothing`, [ME, ids.hist]);
    await query(`insert into going (user_id, event_id) values ($1, $2) on conflict do nothing`, [ME, ids.alreadyGoing]);
  });

  afterAll(async () => {
    await query(`delete from rec_feedback where user_id in ($1, $2)`, [ME, OTHER]);
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

  it('keeps classes and karaoke nights out, however well they score', async () => {
    const rows = await asUser<{ event_id: string }>(ME, `select * from recommend_events(20, 'nyc', 60)`);
    // same venue, same genre, same vibe as the user's history — admitted on every signal but the title
    expect(rows.map((r) => r.event_id)).not.toContain(ids.class);
  });

  it('event_is_class() is anchored: it catches real classes and spares the acts and venues that read like them', async () => {
    const check = async (title: string) =>
      (await query<{ v: boolean }>(`select event_is_class($1) as v`, [title])).rows[0]!.v;

    // real ones, taken from live NOCT data
    for (const t of [
      'Intro to Ableton Lab: Building Chords, Basslines, & Melodies',
      'RA25 UNLOCKED with QNCC - Free Workshop',
      'Karaoke Mondays',
      'KARAOKE NIGHT',
      'DOWNSTAIRS: Karaoke (Free!)',
      'Techno Yoga with Yaya Flows & nataliepops',
      "Molly & June's Honky Tonk: Line Dance Classes & Country Music",
    ]) expect(await check(t), t).toBe(true);

    // every one of these is a real upcoming NOCT event a substring match would have thrown away
    for (const t of [
      'Ivy Lab: A Farewell Tour',                                  // a drum & bass act, not a lab
      'Elsewhere Presents: Jam City @ Market Hotel',               // Market Hotel is a venue
      'Italo Horror Disco with Street Cleaner LIVE & Dark Karaoke',// a club night that ends in karaoke
      'Banda Brunch - Sunset Mexican Independence Party at Watermark Beach NYC',
      'mezza 2 in collab with Le Frique Sonique',                  // "collab" ends in "lab"
      'Waxed.Market Record Fair',
      'Working Class',                                             // the reason "class" needs a noun in front
    ]) expect(await check(t), t).toBe(false);
  });

  it('caps how many nights one venue can take', async () => {
    const fam = (rows: { event_id: string }[]) =>
      rows.filter((r) => [ids.cap1, ids.cap2, ids.cap3].includes(r.event_id)).length;
    expect(fam(await asUser(ME, `select * from recommend_events(20, 'nyc', 60, 2)`))).toBe(2);
    expect(fam(await asUser(ME, `select * from recommend_events(20, 'nyc', 60, 1)`))).toBe(1);
    // the cap is per venue, so venue-less events are not competing for one shared slot
    const all = await asUser<{ event_id: string }>(ME, `select * from recommend_events(20, 'nyc', 60, 1)`);
    expect(all.map((r) => r.event_id)).toContain(ids.sameArtist);
    expect(all.map((r) => r.event_id)).toContain(ids.sameGenre);
  });

  it('a dismissal removes that night and demotes the ones like it', async () => {
    const scoreOf = (rows: { event_id: string; score: number }[], k: string) =>
      Number(rows.find((r) => r.event_id === ids[k])?.score ?? NaN);
    const before = await asUser<{ event_id: string; score: number }>(ME, `select * from recommend_events(20, 'nyc', 60)`);
    const capBefore = scoreOf(before, 'cap2');

    await query(`insert into rec_feedback (user_id, event_id, action) values ($1, $2, 'dismissed')
                 on conflict (user_id, event_id) do update set action = excluded.action`, [ME, ids.cap1]);
    const after = await asUser<{ event_id: string; score: number }>(ME, `select * from recommend_events(20, 'nyc', 60)`);

    expect(after.map((r) => r.event_id)).not.toContain(ids.cap1);      // gone for good
    expect(scoreOf(after, 'cap2')).toBeLessThan(capBefore);            // same room, same genre -> demoted
    // one "no" must not blacklist a whole genre: the artist match survives it
    expect(after.map((r) => r.event_id)).toContain(ids.sameArtist);
    await query(`delete from rec_feedback where user_id = $1`, [ME]);
  });

  it('opening a recommendation counts as a weak signal of its own', async () => {
    const base = await asUser<{ history_size: number }>(ME, `select * from recommend_events(20, 'nyc', 60)`);
    await query(`insert into rec_feedback (user_id, event_id, action) values ($1, $2, 'opened')
                 on conflict (user_id, event_id) do update set action = excluded.action`, [ME, ids.sameVenue]);
    const after = await asUser<{ event_id: string; history_size: number }>(ME, `select * from recommend_events(20, 'nyc', 60)`);
    expect(Number(after[0]!.history_size)).toBe(Number(base[0]!.history_size) + 1);
    // it joins the profile without being recommended back to the user
    expect(after.map((r) => r.event_id)).toContain(ids.sameVenue);
    await query(`delete from rec_feedback where user_id = $1`, [ME]);
  });

  it('rec_feedback is private: RLS scopes every row to its own user', async () => {
    const pol = await query<{ n: number }>(`select count(*)::int as n from pg_policies
      where schemaname = 'public' and tablename = 'rec_feedback'`);
    expect(Number(pol.rows[0]!.n)).toBeGreaterThan(0);
    const rls = await query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.rec_feedback'::regclass`);
    expect(rls.rows[0]!.relrowsecurity).toBe(true);
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
