import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFeed } from '../../src/feed/query.js';
import { listingParams, UPSERT_SQL } from '../../src/ingest/persist.js';
import { closePool, getPool, query } from '../../src/lib/db.js';
import { baseListing } from '../../src/sources/types.js';
import type pg from 'pg';

/**
 * 0036: a ticket link is an offer whoever carried it, and it is named after where it goes. A 19hz row that
 * links to axs.com with a price is "AXS · $18" on the event sheet; a 19hz row that links to a Facebook event
 * is still only a source.
 */
describe.skipIf(!process.env.DATABASE_URL)('ticket links by platform (0036)', () => {
  const TAG = 'offertest-';
  const NIGHT = '2031-09-05';
  const TITLES = ['Daniel Avery (Live)', 'Warehouse Social'];
  const VENUE_TABLES_LOCK = 720611;
  let lock: pg.PoolClient | undefined;
  let runId = 0;

  const upsert = async (l: ReturnType<typeof baseListing>) => {
    const up = (await query<{ listing_id: string }>(UPSERT_SQL, listingParams(l, runId))).rows[0]!;
    await query('select resolve_pending()');
    return (await query<{ event_id: string }>('select event_id from listing where listing_id = $1', [up.listing_id])).rows[0]!.event_id;
  };
  async function cleanup(): Promise<void> {
    await query(`delete from listing where source_id like $1`, [`${TAG}%`]);
    await query(`delete from event where night = $1::date and title = any($2::text[])`, [NIGHT, TITLES]);
    await query(`delete from venue_alias where alias like 'Qx %'`);
    await query(`delete from venue where name like 'Qx %'`);
    await query(`delete from ingest_run where trigger = 'offertest'`);
  }
  beforeAll(async () => {
    lock = await getPool().connect();
    await lock.query('select pg_advisory_lock($1)', [VENUE_TABLES_LOCK]);
    await cleanup();
    const run = await query<{ run_id: string }>(
      `insert into ingest_run (source_key, status, finished_at, listings_seen, window_start, window_end, trigger)
       values ('19hz', 'ok', now(), 1, $1, $1, 'offertest') returning run_id`, [NIGHT]);
    runId = Number(run.rows[0]!.run_id);
  });
  afterAll(async () => {
    await cleanup();
    await lock?.query('select pg_advisory_unlock($1)', [VENUE_TABLES_LOCK]);
    lock?.release();
    await closePool();
  });

  it('names the platform a link sells on, and leaves a Facebook link out', async () => {
    expect((await query<{ n: string }>(`select ticket_platform_name('axs.com') as n`)).rows[0]!.n).toBe('AXS');
    expect((await query<{ n: string }>(`select ticket_platform_name(platform_host('19hz', 'https://www.tixr.com/groups/x/events/y-123')) as n`)).rows[0]!.n).toBe('Tixr');
    expect((await query<{ n: string | null }>(`select ticket_platform_name(platform_host('19hz', 'https://www.facebook.com/events/1')) as n`)).rows[0]!.n).toBeNull();
    expect((await query<{ n: string | null }>(`select ticket_platform_name(null) as n`)).rows[0]!.n).toBeNull();
  });

  it('a 19hz row linking to AXS is an offer on the sheet beside RA\'s, named AXS; a Facebook link is not', async () => {
    // RA lists the night with a price; 19hz carries the same night with the AXS link and its own price
    const ev = await upsert(baseListing({
      source: 'ra', sourceId: `${TAG}ra`, sourceUrl: 'https://ra.co/events/9990001', raw: { id: 1 },
      title: 'Daniel Avery (Live)', city: 'la', tz: 'America/Los_Angeles', hasTime: true, night: NIGHT,
      startsAt: '2031-09-06T04:00:00.000Z', venueName: 'Qx Rey Theatre', priceMin: 28.75,
    }));
    const ev2 = await upsert(baseListing({
      source: '19hz', sourceId: `${TAG}hz`, sourceUrl: 'https://www.axs.com/events/1485526', raw: { id: 2 },
      title: 'Daniel Avery (Live)', city: 'la', tz: 'America/Los_Angeles', hasTime: true, night: NIGHT,
      startsAt: '2031-09-06T04:00:00.000Z', venueName: 'Qx Rey Theatre', priceMin: 18,
    }));
    expect(ev2).toBe(ev);
    const offers = await query<{ platform: string; platform_name: string; price: string | null }>(
      `select platform, platform_name, price from event_offer where event_id = $1 order by platform`, [ev]);
    expect(offers.rows.map((o) => [o.platform, o.platform_name, Number(o.price)])).toEqual([['19hz', 'AXS', 18], ['ra', 'Resident Advisor', 28.75]]);
    const feed = await buildFeed({ city: 'la', from: NIGHT, to: NIGHT, now: new Date('2031-09-05T20:00:00Z') });
    const card = feed.events.find((e) => e.id === ev)!;
    expect(card.srcs.map((s) => [s[0], s[1], s[3]])).toEqual([
      ['AXS', 18, 'https://www.axs.com/events/1485526'],
      ['Resident Advisor', 28.75, 'https://ra.co/events/9990001'],
    ]);

    // a 19hz row whose link is a Facebook event: a source, not an offer
    const fb = await upsert(baseListing({
      source: '19hz', sourceId: `${TAG}fb`, sourceUrl: 'https://www.facebook.com/events/123', raw: { id: 3 },
      title: 'Warehouse Social', city: 'la', tz: 'America/Los_Angeles', hasTime: true, night: NIGHT,
      startsAt: '2031-09-06T05:00:00.000Z', venueName: 'Qx Rey Theatre', priceMin: 10,
    }));
    expect((await query(`select 1 from event_offer where event_id = $1`, [fb])).rows).toEqual([]);
    const feed2 = await buildFeed({ city: 'la', from: NIGHT, to: NIGHT, now: new Date('2031-09-05T20:00:00Z') });
    const social = feed2.events.find((e) => e.id === fb)!;
    expect(social.srcs).toEqual([['19hz', null, 'See listing', 'https://www.facebook.com/events/123']]);
  });
});
