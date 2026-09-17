import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listingParams, UPSERT_SQL } from '../../src/ingest/persist.js';
import { closePool, getPool, query } from '../../src/lib/db.js';
import { baseListing } from '../../src/sources/types.js';
import type pg from 'pg';

/**
 * 0028: the merge layer's three seams, against Postgres. A placeholder venue no longer keeps an identical night
 * apart; a short venue name finds the long one it is part of; a listing can be moved after the fact and the
 * emptied event says where it went, marks included; a venue can be folded into another.
 *
 * Titles and venue names here are realistic on purpose: a shared test suffix would make every title and every
 * venue look alike to the trigram scorer and merge things that must stay apart. Venues carry a 'Zq ' prefix
 * (a word, so containment still works), events are cleaned up by the listings that made them.
 */
describe.skipIf(!process.env.DATABASE_URL)('cross-source dedup (0028)', () => {
  const TAG = 'deduptest-';
  const V = 'Zq ';
  const NIGHT = '2031-07-04';
  const TITLES = ['Brandon', 'Anton Khabbaz', 'Night Shift', 'Late Shift', 'Indo Warehouse'];
  const ME = '00000000-0000-4000-8000-00000000fc01';
  const VENUE_TABLES_LOCK = 720611;   // same lock as feed/seed_venues tests: upsert_listing learns venue aliases
  let lock: pg.PoolClient | undefined;
  let runId = 0;
  const vid: Record<string, string> = {};

  const mkVenue = async (key: string, name: string, city: string, kind = 'venue') => {
    const r = await query<{ venue_id: string }>(`insert into venue (name, city, kind) values ($1, $2, $3) returning venue_id`, [V + name, city, kind]);
    vid[key] = r.rows[0]!.venue_id;
    return vid[key]!;
  };
  /** upsert, then resolve -- upsert_listing() stores the row and resolve_pending() attaches it, as ingest does */
  const upsert = async (l: ReturnType<typeof baseListing>) => {
    const up = (await query<{ listing_id: string; is_new: boolean }>(UPSERT_SQL, listingParams(l, runId))).rows[0]!;
    await query('select resolve_pending()');
    const row = (await query<{ event_id: string }>('select event_id from listing where listing_id = $1', [up.listing_id])).rows[0]!;
    return { listing_id: up.listing_id, event_id: row.event_id, is_new: up.is_new };
  };

  async function cleanup(): Promise<void> {
    const ev = await query<{ event_id: string }>(`select distinct event_id from listing where source_id like $1 and event_id is not null`, [`${TAG}%`]);
    const ids = ev.rows.map((r) => r.event_id);
    await query(`delete from listing where source_id like $1`, [`${TAG}%`]);
    await query(`delete from going where user_id = $1`, [ME]);
    // a folded event points at its survivor (event_merged_into_fkey), so it goes first -- and it is never
    // un-merged, which would put it back under the dupe guard next to the survivor that took its title
    await query(`delete from event where merged_into is not null and (event_id = any($1::uuid[]) or (night = $2::date and title = any($3::text[])))`, [ids, NIGHT, TITLES]);
    await query(`delete from event where event_id = any($1::uuid[]) or (night = $2::date and title = any($3::text[]))`, [ids, NIGHT, TITLES]);
    await query(`delete from venue_alias where alias like $1 or alias like $2`, [`${V}%`, `The ${V}%`]);
    await query(`delete from venue_external_id where source_id like $1`, [`${TAG}%`]);
    await query(`delete from venue where name like $1 or name like $2`, [`${V}%`, `The ${V}%`]);
    await query(`delete from ingest_run where trigger = 'deduptest'`);
  }

  beforeAll(async () => {
    lock = await getPool().connect();
    await lock.query('select pg_advisory_lock($1)', [VENUE_TABLES_LOCK]);
    await cleanup();
    const run = await query<{ run_id: string }>(
      `insert into ingest_run (source_key, status, finished_at, listings_seen, window_start, window_end, trigger)
       values ('ra', 'ok', now(), 1, $1, $1, 'deduptest') returning run_id`, [NIGHT]);
    runId = Number(run.rows[0]!.run_id);
  });
  afterAll(async () => {
    await cleanup();
    await lock?.query('select pg_advisory_unlock($1)', [VENUE_TABLES_LOCK]);
    lock?.release();
    await closePool();
  });

  it('an RA night at "TBA" and the same title at a named room merge into one card', async () => {
    await mkVenue('tba', 'Location TBA', 'chi', 'tba');
    await mkVenue('named', 'Hideaway Room', 'chi');
    // RA first, filed at the placeholder
    const ra = await upsert(baseListing({
      source: 'ra', sourceId: `${TAG}ra-tba`, sourceUrl: 'https://ra.co/events/deduptest1', raw: { id: 1 },
      title: 'Brandon', city: 'chi', tz: 'America/Chicago', hasTime: true, night: NIGHT,
      startsAt: '2031-07-05T03:00:00.000Z', endsAt: '2031-07-05T08:00:00.000Z', venueName: `${V}Location TBA`,
    }));
    // 19hz names the room; no line-up on either side, so before 0028 the score stalled at 0.73
    const hz = await upsert(baseListing({
      source: '19hz', sourceId: `${TAG}hz-named`, sourceUrl: 'https://ra.co/events/deduptest1x', raw: { id: 2 },
      title: 'Brandon', city: 'chi', tz: 'America/Chicago', hasTime: true, night: NIGHT,
      startsAt: '2031-07-05T03:00:00.000Z', endsAt: '2031-07-05T08:00:00.000Z', venueName: `${V}Hideaway Room`,
    }));
    expect(hz.event_id).toBe(ra.event_id);
    // the decision that merged them was the placeholder floor, recorded on the candidate row
    const mc = await query<{ score: number; features: { placeholder: boolean; title: number }; decision: string }>(
      `select score, features, decision from match_candidate where listing_id = $1 and event_id = $2`, [hz.listing_id, ra.event_id]);
    expect(mc.rows[0]!.decision).toBe('auto_merged');
    expect(Number(mc.rows[0]!.score)).toBeGreaterThanOrEqual(0.78);
    expect(mc.rows[0]!.features).toMatchObject({ placeholder: true });
    expect(Number(mc.rows[0]!.features.title)).toBeGreaterThanOrEqual(0.95);
    // and the card now names the room, not the placeholder (refresh_event skips tba venues)
    const ev = await query<{ venue_id: string }>(`select venue_id from event where event_id = $1`, [ra.event_id]);
    expect(ev.rows[0]!.venue_id).toBe(vid.named);
  });

  it('a placeholder does not merge two DIFFERENT titles on the same night', async () => {
    const other = await upsert(baseListing({
      source: '19hz', sourceId: `${TAG}hz-other`, sourceUrl: 'https://ra.co/events/deduptest2', raw: { id: 3 },
      title: 'Anton Khabbaz', city: 'chi', tz: 'America/Chicago', hasTime: true, night: NIGHT,
      startsAt: '2031-07-05T03:00:00.000Z', venueName: `${V}Location TBA`,
    }));
    const brandon = await query<{ event_id: string }>(`select event_id from listing where source_id = $1`, [`${TAG}ra-tba`]);
    expect(other.event_id).not.toBe(brandon.rows[0]!.event_id);
  });

  it('resolve_venue: "Halcyon" finds "Halcyon Theatre" (the El Rey case); a three-letter name finds nothing', async () => {
    // an invented name: the seeded El Rey Theatre already carries an "El Rey" alias, which is not what is under test
    await mkVenue('theatre', 'Halcyon Theatre', 'la');
    const hit = await query<{ venue_id: string; method: string; score: number }>(
      `select * from resolve_venue('19hz', null, $1, 'la')`, [`${V}Halcyon`]);
    expect(hit.rows[0], JSON.stringify(hit.rows)).toMatchObject({ venue_id: vid.theatre, method: 'trgm' });
    expect(Number(hit.rows[0]!.score)).toBeGreaterThanOrEqual(0.55);
    // the reverse direction needs some substance: "Bar" is not "Bar Lubitsch"
    await mkVenue('bar', 'Bar Lubitsch', 'la');
    const bar = await query(`select * from resolve_venue('19hz', null, 'Bar', 'la')`);
    expect(bar.rows).toEqual([]);
  });

  it('0031: a guess needs the same words, is vetoed 500 m away, and is never learned (the Brooklyn Monarch case)', async () => {
    // an invented pair with the real pair's shape (the real Monarch has its own row since 0031, and the real
    // Mirage's one distinctive word would claim any "... Mirage ..." here): "Zq Harbor Lantern" at Stewart Ave;
    // an incoming "The Zq Harbor Monarch" sits about 0.6 inside it by word_similarity
    const mirage = await mkVenue('mirage', 'Harbor Lantern', 'nyc');
    await query(`update venue set lat = 40.710662, lng = -73.926258 where venue_id = $1`, [mirage]);
    // the words disagree (monarch is not mirage): no match, with or without coordinates
    for (const coords of ['', ', 40.71098, -73.936304']) {
      const r = await query(`select * from resolve_venue('ra', null, $1, 'nyc'${coords})`, [`The ${V}Harbor Monarch`]);
      expect(r.rows, coords).toEqual([]);
    }
    // the words agree ("terrace" is an extra word on the incoming side): a guess, and the guess stands blind
    const name = `${V}Harbor Lantern Terrace`;
    const blind = await query<{ venue_id: string; method: string }>(`select * from resolve_venue('ra', null, $1, 'nyc')`, [name]);
    expect(blind.rows[0]).toMatchObject({ venue_id: mirage, method: 'trgm' });
    // with the listing's own coordinates 850 m away on Meadow St, it does not
    const far = await query(`select * from resolve_venue('ra', null, $1, 'nyc', 40.71098, -73.936304)`, [name]);
    expect(far.rows).toEqual([]);
    // 200 m away it still does: same block, different door
    const near = await query<{ method: string }>(`select * from resolve_venue('ra', null, $1, 'nyc', 40.7118, -73.9250)`, [name]);
    expect(near.rows[0]).toMatchObject({ venue_id: mirage, method: 'trgm' });
    // a room without coordinates borrows its family's for the veto
    const room = await mkVenue('mroom', 'Lantern Terrace', 'nyc', 'room');
    await query(`update venue set parent_venue_id = $1 where venue_id = $2`, [mirage, room]);
    const roomFar = await query<{ venue_id: string }>(`select * from resolve_venue('ra', null, $1, 'nyc', 40.71098, -73.936304)`, [`${V}Lantern Terrace Harbor`]);
    expect(roomFar.rows.map((r) => r.venue_id)).not.toContain(room);
    // a placeholder is never a guess, whatever the words
    const tba = await mkVenue('tbaharbor', 'TBA Harbor', 'nyc', 'tba');
    const ph = await query<{ venue_id: string }>(`select * from resolve_venue('ra', null, $1, 'nyc')`, [`${V}TBA Harbor Rooftop`]);
    expect(ph.rows.map((r) => r.venue_id)).not.toContain(tba);

    // ingest: a listing that only trigram-matches (no coordinates) is filed there for now, but nothing is learned
    const l = await upsert(baseListing({
      source: 'ra', sourceId: `${TAG}ra-monarch`, sourceUrl: 'https://ra.co/events/deduptest9', raw: { id: 9 },
      title: 'Indo Warehouse', hasTime: true, night: NIGHT, startsAt: '2031-07-05T02:00:00.000Z',
      venueName: name, venueSourceId: 'deduptest-188422',
    }));
    expect(l.event_id).toBeTruthy();
    expect((await query(`select venue_id from listing where listing_id = $1`, [l.listing_id])).rows[0]).toEqual({ venue_id: mirage });
    const learned = await query(`select 1 from venue_alias where alias_norm = norm_text($1) union all select 1 from venue_external_id where source_key = 'ra' and source_id = 'deduptest-188422'`, [name]);
    expect(learned.rows).toEqual([]);
    // once the listing carries coordinates, reresolve_listing_venue() moves it off the Mirage to a row of its own
    await query(`update listing set venue_lat_raw = 40.71098, venue_lng_raw = -73.936304, venue_addr_raw = '23 Meadow St, Brooklyn, NY 11206' where listing_id = $1`, [l.listing_id]);
    const v = await query<{ reresolve_listing_venue: string }>(`select reresolve_listing_venue($1)`, [l.listing_id]);
    expect(v.rows[0]!.reresolve_listing_venue).not.toBe(mirage);
    const made = await query<{ name: string; kind: string; borough: string | null }>(`select name, kind, borough from venue where venue_id = $1`, [v.rows[0]!.reresolve_listing_venue]);
    expect(made.rows[0]).toMatchObject({ name, kind: 'venue', borough: 'Brooklyn' });
    const ev = await query<{ venue_id: string }>(`select venue_id from event where event_id = $1`, [l.event_id]);
    expect(ev.rows[0]!.venue_id).toBe(v.rows[0]!.reresolve_listing_venue);
  });

  it('0031: venue_names_agree() -- the same distinctive words, typos and stems included, place words not counted', async () => {
    const pairs: [string, string, boolean][] = [
      ['El Rey', 'El Rey Theatre', true], ['Nowadays NYC', 'Nowadays', true], ['Nowdays', 'Nowadays', true],
      ['Pacha New York - The Great Hall', 'The Great Hall', true], ['Knockdown Center - Basement', 'BASEMENT', true],
      ['Ramova Theater', 'Ramova Theatre', true], ['Circle Line Sightseeing Cruises', 'Circle Line Cruises', true],
      ['The Brooklyn Monarch', 'Brooklyn Mirage', false], ['Hollywood Bowl', 'W Hollywood', false], ['Sound Nightclub', 'Spin', false],
      ['Westlight Rooftop at The William Vale', 'Elsewhere Rooftop', false], ['EOS Lounge', 'Zero Lounge', false],
      ['Brooklyn Storehouse', 'Brooklyn Steel', false], ['Brooklyn', 'Brooklyn Bowl', false],
    ];
    for (const [a, b, want] of pairs) {
      const r = await query<{ ok: boolean }>(`select venue_names_agree($1, $2) as ok`, [a, b]);
      expect(r.rows[0]!.ok, `${a} ~ ${b}`).toBe(want);
    }
  });

  it('rematch_listing moves a listing to a better event, marks the emptied one merged_into it, and carries the marks', async () => {
    await mkVenue('room', 'Merge Room', 'nyc');
    // one listing -> one new event, which somebody marks going
    const a = await upsert(baseListing({
      source: 'dice', sourceId: `${TAG}dice-a`, sourceUrl: 'https://dice.fm/event/deduptesta', raw: { id: 4 },
      title: 'Night Shift', hasTime: true, night: NIGHT, startsAt: '2031-07-05T02:00:00.000Z', venueName: `${V}Merge Room`,
    }));
    expect(a.event_id).toBeTruthy();
    await query(`insert into going (user_id, event_id) values ($1, $2)`, [ME, a.event_id]);
    // a canonical event that hard-links this listing appears (as an RA record would): the better home
    const b = await query<{ event_id: string }>(
      `insert into event (title, venue_id, night, city, tz, starts_at, has_time, external_refs)
       values ($1, $2, $3, 'nyc', 'America/New_York', '2031-07-05T02:00:00.000Z', true, $4::jsonb) returning event_id`,
      ['Late Shift', vid.room, NIGHT, JSON.stringify([{ source: 'dice', id: `${TAG}dice-a` }])]);   // a different title_norm, so the dupe guard allows it; the hard link decides
    const target = b.rows[0]!.event_id;
    const moved = await query<{ from_event: string; to_event: string; method: string; score: number }>(`select * from rematch_listing($1)`, [a.listing_id]);
    expect(moved.rows[0]).toMatchObject({ from_event: a.event_id, to_event: target, method: 'external_ref' });
    const old = await query<{ merged_into: string | null; status: string }>(`select merged_into, status from event where event_id = $1`, [a.event_id]);
    expect(old.rows[0]).toEqual({ merged_into: target, status: 'removed' });
    const going = await query<{ event_id: string }>(`select event_id from going where user_id = $1`, [ME]);
    expect(going.rows.map((r) => r.event_id)).toEqual(expect.arrayContaining([target]));
    // nothing better: the listing stays where it is
    const kept = await query<{ method: string }>(`select * from rematch_listing($1)`, [a.listing_id]);
    expect(kept.rows[0]!.method).toBe('kept');
    // the folded event is out of every read model
    const feed = await query(`select 1 from event_feed where event_id = $1`, [a.event_id]);
    expect(feed.rows).toEqual([]);
  });

  it('merge_venue folds one venue into another and re-resolves what was there', async () => {
    await mkVenue('hall', 'Cermak Hall', 'chi');
    await mkVenue('radius', 'Radius', 'chi');
    const atRadius = await upsert(baseListing({
      source: 'ra', sourceId: `${TAG}ra-radius`, sourceUrl: 'https://ra.co/events/deduptest3', raw: { id: 5 },
      title: 'Indo Warehouse', city: 'chi', tz: 'America/Chicago', hasTime: true, night: NIGHT,
      startsAt: '2031-07-05T03:00:00.000Z', venueName: `${V}Radius`,
    }));
    const atHall = await upsert(baseListing({
      source: '19hz', sourceId: `${TAG}hz-hall`, sourceUrl: 'https://www.flite.city/e/deduptest3', raw: { id: 6 },
      title: 'Indo Warehouse', city: 'chi', tz: 'America/Chicago', hasTime: true, night: NIGHT,
      startsAt: '2031-07-05T03:00:00.000Z', venueName: `${V}Cermak Hall`,
    }));
    expect(atHall.event_id).not.toBe(atRadius.event_id);        // two names, two cards -- the bug
    const r = await query<{ listing_id: string; from_event: string; to_event: string; method: string }>(`select * from merge_venue($1, $2)`, [vid.hall, vid.radius]);
    expect(r.rows.map((x) => [Number(x.listing_id), x.to_event])).toEqual([[Number(atHall.listing_id), atRadius.event_id]]);
    // the old row stays, as a room of the survivor's family; its name now resolves to the survivor
    const hall = await query<{ parent_venue_id: string | null }>(`select parent_venue_id from venue where venue_id = $1`, [vid.hall]);
    expect(hall.rows[0]!.parent_venue_id).toBe(vid.radius);
    const alias = await query<{ venue_id: string; method: string }>(`select * from resolve_venue('19hz', null, $1, 'chi')`, [`${V}Cermak Hall`]);
    expect(alias.rows[0]).toMatchObject({ venue_id: vid.radius, method: 'alias_exact' });
    const folded = await query<{ merged_into: string | null }>(`select merged_into from event where event_id = $1`, [atHall.event_id]);
    expect(folded.rows[0]!.merged_into).toBe(atRadius.event_id);
    // the survivor now shows both ways in
    const srcs = await query<{ n: string }>(`select count(*) as n from listing where event_id = $1 and gone_at is null`, [atRadius.event_id]);
    expect(Number(srcs.rows[0]!.n)).toBe(2);
  });

  it('platform_host names the platform by URL host, not by adapter', async () => {
    const cases: [string, string | null, string][] = [
      ['silo', 'https://link.dice.fm/abc', 'dice.fm'],
      ['dice', 'https://dice.fm/event/xyz-tickets', 'dice.fm'],
      ['19hz', 'https://ra.co/events/2510218', 'ra.co'],
      ['19hz', 'https://www.ticketmaster.com/kelela/event/1', 'ticketmaster.com'],
      ['19hz', 'https://www.flite.city/e/saturdays?t=flite', 'flite.city'],
      ['19hz', 'https://www.eventbrite.com/e/x-tickets-1', 'eventbrite.com'],
      ['ra', null, 'ra.co'],
      ['elsewhere', 'https://www.elsewherebrooklyn.com/events/x', 'elsewherebrooklyn.com'],
    ];
    for (const [key, url, want] of cases) {
      const r = await query<{ h: string }>(`select platform_host($1, $2) as h`, [key, url]);
      expect(r.rows[0]!.h, `${key} ${url}`).toBe(want);
    }
  });
});
