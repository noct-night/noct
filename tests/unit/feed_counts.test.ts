import { afterAll, describe, expect, it } from 'vitest';
import { buildCounts, FeedParamError, MAX_COUNTS_DAYS, MAX_RANGE_DAYS, resolveParams } from '../../src/feed/query.js';
import { closePool, query } from '../../src/lib/db.js';

describe('counts mode: range rules (offline)', () => {
  const now = new Date('2026-09-14T20:00:00Z');
  it('allows a whole month grid but still caps it', () => {
    expect(MAX_COUNTS_DAYS).toBeGreaterThan(MAX_RANGE_DAYS);
    // a 42-day calendar grid is fine for counts but too wide for full records
    expect(resolveParams({ from: '2026-09-01', to: '2026-10-12', countsOnly: true }, now).to).toBe('2026-10-12');
    expect(() => resolveParams({ from: '2026-09-01', to: '2026-10-12' }, now)).toThrow(FeedParamError);
    expect(() => resolveParams({ from: '2026-01-01', to: '2026-12-31', countsOnly: true }, now)).toThrow(/at most/);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('buildCounts against Postgres', () => {
  const MARK = 'CountsTest 2032';
  const N1 = '2032-03-05';
  const N2 = '2032-03-07';

  afterAll(async () => {
    await query(`delete from listing where source_id like 'counts-test-%'`);
    await query(`delete from event where title like $1`, [`%${MARK}%`]);
    await closePool();
  });

  it('returns one row per night in the range, zeros included, and a total', async () => {
    // distinct titles AND venues: same-venue near-identical titles on one night are deliberately merged by
    // resolve_listing(), which would make this a test of entity resolution rather than of counting.
    const up = (id: string, title: string, night: string, venue: string) =>
      query(
        `select * from upsert_listing('ra',$1,null,'{}'::jsonb,null,$2,null,null,false,$3::date,$4,null,null,null,null,
           '{}'::text[],null,null,null,null,'[]'::jsonb,null,'scheduled',null,'{}','{}',null,null,null,'{}'::jsonb,'[]'::jsonb)`,
        [id, title, night, venue],
      );
    await up('counts-test-a', `Alpha Warehouse ${MARK}`, N1, 'Nowadays');
    await up('counts-test-b', `Zebra Basement Session ${MARK}`, N1, 'Good Room');
    await up('counts-test-c', `Kilo Rooftop ${MARK}`, N2, 'Elsewhere');
    await query('select resolve_pending()');

    const c = await buildCounts({ from: N1, to: N2, includeAll: true });
    expect(c.range).toEqual({ from: N1, to: N2 });
    expect(c.city.key).toBe('nyc');
    expect(c.days.map((d) => d.date)).toEqual([N1, '2032-03-06', N2]);
    const byDate = Object.fromEntries(c.days.map((d) => [d.date, d.events]));
    expect(byDate[N1]).toBe(2);
    expect(byDate['2032-03-06']).toBe(0);   // an empty night still gets a cell in the grid
    expect(byDate[N2]).toBe(1);
    expect(c.total).toBe(3);
    // days carry the same labels the feed uses, so the grid and the feed agree
    expect(c.days[0]).toMatchObject({ dow: 5, label: 'Fri', sub: 'Mar 5' });
    // and it is genuinely light: no event records ride along
    expect(c).not.toHaveProperty('events');
    expect(JSON.stringify(c).length).toBeLessThan(2000);
  });

  it('counts the same set the feed would return for that night', async () => {
    const [counts, feedRange] = await Promise.all([
      buildCounts({ from: N1, to: N1, includeAll: true }),
      import('../../src/feed/query.js').then((m) => m.buildFeed({ from: N1, to: N1, includeAll: true })),
    ]);
    expect(counts.days[0]!.events).toBe(feedRange.events.length);
  });
});
