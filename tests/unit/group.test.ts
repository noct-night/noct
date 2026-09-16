import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query, withTx } from '../../src/lib/db.js';

/**
 * 0025 Group Mode against Postgres: a session, votes from two people, and group_result() as each of them. The
 * function reads auth.uid(), which only exists on Supabase, so the local run installs the same stub the
 * recommendation tests use and sets it per transaction.
 */
describe.skipIf(!process.env.DATABASE_URL)('group_result against Postgres', () => {
  const MARK = 'GroupTest 2031';
  const OWNER = '00000000-0000-4000-8000-00000000fb01';
  const FRIEND = '00000000-0000-4000-8000-00000000fb02';
  const STRANGER = '00000000-0000-4000-8000-00000000fb03';
  const ids: string[] = [];
  let session = '';

  const asUser = <T>(uid: string | null, sql: string, params: unknown[] = []): Promise<T[]> =>
    withTx(async (c) => {
      await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? '']);
      const r = await c.query(sql, params);
      return r.rows as T[];
    });
  const result = async (uid: string | null) =>
    (await asUser<{ r: Record<string, any> | null }>(uid, `select group_result($1::uuid) as r`, [session]))[0]!.r;

  beforeAll(async () => {
    await query(`create schema if not exists auth`);
    await query(`create or replace function auth.uid() returns uuid language sql stable
                 as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$`);
    await query(`delete from event where title like $1`, [`%${MARK}%`]);
    for (const t of ['One', 'Two', 'Three', 'Gone']) {
      const r = await query<{ event_id: string }>(
        `insert into event (title, night, city, tz, status) values ($1, '2031-06-07', 'nyc', 'America/New_York', $2) returning event_id`,
        [`Card ${t} ${MARK}`, t === 'Gone' ? 'cancelled' : 'scheduled']);
      ids.push(r.rows[0]!.event_id);
    }
    const s = await query<{ session_id: string }>(
      `insert into group_session (owner_id, city, night, deck) values ($1, 'nyc', '2031-06-07', $2::uuid[]) returning session_id`,
      [OWNER, ids]);
    session = s.rows[0]!.session_id;
  });

  afterAll(async () => {
    await query(`delete from group_session where owner_id = $1`, [OWNER]);
    await query(`delete from event where title like $1`, [`%${MARK}%`]);
    await closePool();
  });

  it('nobody signed in, or an unknown session: nothing', async () => {
    expect(await result(null)).toBeNull();
    const none = await asUser<{ r: unknown }>(OWNER, `select group_result('00000000-0000-4000-8000-000000000000') as r`);
    expect(none[0]!.r).toBeNull();
  });

  it('a fresh session: the deck, the cards still listed, no members, nothing finished', async () => {
    const r = (await result(OWNER))!;
    expect(r.session).toMatchObject({ id: session, city: 'nyc', night: '2031-06-07', owner: true });
    expect(r.session.deck).toEqual(ids);
    expect(r.session.live).toEqual(ids.slice(0, 3));              // the cancelled card is not live
    expect(r).toMatchObject({ members: 0, finished: 0, mine: [] });
    expect(r.events.map((e: { event_id: string; likes: number }) => [e.event_id, e.likes])).toEqual(ids.map((id) => [id, 0]));
    expect((await result(FRIEND))!.session.owner).toBe(false);
  });

  it('counts likes per card, members and finishers, and shows each person only their own votes', async () => {
    const vote = (uid: string, event: string, liked: boolean) =>
      query(`insert into group_vote (session_id, user_id, event_id, liked) values ($1, $2, $3, $4)
             on conflict (session_id, user_id, event_id) do update set liked = excluded.liked`, [session, uid, event, liked]);
    // the owner votes on every live card; the friend on two of three; nobody can vote on the cancelled one
    await vote(OWNER, ids[0]!, true); await vote(OWNER, ids[1]!, false); await vote(OWNER, ids[2]!, true);
    await vote(FRIEND, ids[0]!, true); await vote(FRIEND, ids[1]!, true);
    const r = (await result(FRIEND))!;
    expect(r.members).toBe(2);
    expect(r.finished).toBe(1);                                    // the owner; the friend has one card to go
    // ranking: card One liked by both, then Two (1) and Three (1) by deck order, then the cancelled card
    expect(r.events.map((e: { event_id: string; likes: number; votes: number }) => [ids.indexOf(e.event_id), e.likes, e.votes]))
      .toEqual([[0, 2, 2], [1, 1, 2], [2, 1, 1], [3, 0, 0]]);
    // privacy: the friend sees their own two votes and nothing per person about the owner
    expect(r.mine).toEqual(expect.arrayContaining([{ event_id: ids[0], liked: true }, { event_id: ids[1], liked: true }]));
    expect(r.mine).toHaveLength(2);
    expect(JSON.stringify(r)).not.toContain(OWNER);
    // a stranger with the link sees the same counts and no votes of their own
    const s = (await result(STRANGER))!;
    expect(s).toMatchObject({ members: 2, finished: 1, mine: [] });
    // changing a vote is an update, not a second member
    await vote(FRIEND, ids[0]!, false);
    expect((await result(OWNER))!.events[0]).toMatchObject({ likes: 1, votes: 2 });
  });

  it('a vote for a card outside the deck is refused', async () => {
    const other = await query<{ event_id: string }>(
      `insert into event (title, night, city, tz) values ($1, '2031-06-07', 'nyc', 'America/New_York') returning event_id`, [`Not In Deck ${MARK}`]);
    await expect(query(`insert into group_vote (session_id, user_id, event_id, liked) values ($1, $2, $3, true)`,
      [session, FRIEND, other.rows[0]!.event_id])).rejects.toThrow(/not in the deck/);
  });

  it('is locked down: RLS on both tables, the function definer-only and reading auth.uid()', async () => {
    for (const t of ['group_session', 'group_vote']) {
      const rls = await query<{ relrowsecurity: boolean }>(`select relrowsecurity from pg_class where oid = ('public.' || $1)::regclass`, [t]);
      expect(rls.rows[0]!.relrowsecurity, t).toBe(true);
    }
    const src = await query<{ def: string }>(`select pg_get_functiondef(p.oid) as def from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'group_result'`);
    expect(src.rows[0]!.def).toContain('auth.uid()');
    expect(src.rows[0]!.def).toMatch(/security definer/i);
    expect(src.rows[0]!.def).toMatch(/search_path/i);
  });
});
