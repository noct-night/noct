import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../../src/lib/db.js';
import { fillDays, foldRef, formatTraffic, trafficReport, type TrafficReport } from '../../src/ops/traffic.js';

describe('traffic: the helpers (offline)', () => {
  it('folds referrer hosts to names, keeps unknown hosts, and calls nothing "direct"', () => {
    expect(foldRef(null)).toBe('direct');
    expect(foldRef('')).toBe('direct');
    expect(foldRef('l.instagram.com')).toBe('instagram');
    expect(foldRef('app.instagram')).toBe('instagram');
    expect(foldRef('t.co')).toBe('x');
    expect(foldRef('www.google.co.kr')).toBe('google');
    expect(foldRef('out.reddit.com')).toBe('reddit');
    expect(foldRef('noct-abc-jayce.vercel.app')).toBe('preview');
    expect(foldRef('brooklynvegan.com')).toBe('brooklynvegan.com');
  });
  it('zero-fills every day of the series, oldest first, ending today', () => {
    const d = fillDays([{ day: '2026-09-15', visits: 3, devices: 2 }], 3, '2026-09-16');
    expect(d).toEqual([
      { day: '2026-09-14', visits: 0, devices: 0 },
      { day: '2026-09-15', visits: 3, devices: 2 },
      { day: '2026-09-16', visits: 0, devices: 0 },
    ]);
  });
  it('formats without throwing on an empty report', () => {
    const empty: TrafficReport = {
      generated_at: 'x', window_days: 30, visits: { recent: 0, window: 0 }, devices: { recent: 0, window: 0, new_recent: 0, new_window: 0 },
      returning_share: 0, daily: [], sources: [], campaigns: [], entry: [], city: [], device: [], lang: [], standalone: 0, actions: [],
      funnel: { visited: 0, opened_a_night: 0, saved_or_going: 0, set_taste: 0, planned: 0 },
    };
    expect(formatTraffic(empty)).toContain('visits 0 [0]');
    expect(formatTraffic(empty)).toContain('funnel    visited 0');
  });
});

describe.skipIf(!process.env.DATABASE_URL)('traffic report against Postgres', () => {
  // two devices of our own; everything they did is removed again afterwards
  const A = '00000000-0000-4000-8000-00000000aa30';
  const B = '00000000-0000-4000-8000-00000000bb30';
  const MARK = 'TrafficTest 2031';
  let eventId = '';
  const cleanup = async () => {
    await query(`delete from visit where user_id in ($1, $2)`, [A, B]);
    await query(`delete from action where user_id in ($1, $2)`, [A, B]);
    await query(`delete from saved where user_id in ($1, $2)`, [A, B]);
    await query(`delete from event where title like $1`, [`%${MARK}%`]);
  };
  beforeAll(async () => {
    await cleanup();
    const r = await query<{ event_id: string }>(
      `insert into event (title, night, city, tz, status, is_electronic) values ($1, '2031-08-01', 'nyc', 'America/New_York', 'scheduled', true) returning event_id`, [`Night ${MARK}`]);
    eventId = r.rows[0]!.event_id;
    // A: came from Instagram's app twice on two days, opened a night, saved it. B: a shared link on a laptop, once.
    await query(`insert into visit (user_id, at, city, ref, entry, device, lang, tz) values
      ($1, now() - interval '2 days', 'nyc', 'app.instagram', 'home', 'phone', 'ko-KR', 'Asia/Seoul'),
      ($1, now() - interval '1 hour', 'nyc', 'l.instagram.com', 'home', 'phone', 'ko-KR', 'Asia/Seoul'),
      ($2, now() - interval '3 hours', 'la', null, 'event', 'desktop', 'en-US', 'America/Los_Angeles')`, [A, B]);
    await query(`insert into visit (user_id, at, city, utm_source, utm_medium, utm_campaign, entry, device) values ($1, now() - interval '40 days', 'nyc', 'Newsletter', 'email', 'sept', 'home', 'phone')`, [A]);
    await query(`insert into action (user_id, kind, event_id, city) values ($1, 'event_open', $3, 'nyc'), ($1, 'track_play', $3, 'nyc'), ($2, 'event_open', $3, 'la')`, [A, B, eventId]);
    await query(`insert into saved (user_id, event_id) values ($1, $2)`, [A, eventId]);
  });
  afterAll(async () => { await cleanup(); await closePool(); });

  it('counts visits and devices, folds sources, and walks the funnel per device', async () => {
    const t = await trafficReport(30);
    expect(t.visits.window).toBeGreaterThanOrEqual(3);          // the 40-day-old visit is outside the window
    expect(t.devices.window).toBeGreaterThanOrEqual(2);
    const ig = t.sources.find((s) => s.key === 'instagram');
    expect(ig?.visits).toBeGreaterThanOrEqual(2);               // app.instagram and l.instagram.com are one source
    expect(t.sources.find((s) => s.key === 'direct')?.visits).toBeGreaterThanOrEqual(1);
    expect(t.entry.find((e) => e.key === 'event')?.visits).toBeGreaterThanOrEqual(1);
    expect(t.lang.find((l) => l.key === 'ko')?.visits).toBeGreaterThanOrEqual(2);
    expect(t.actions.find((a) => a.key === 'event_open')?.devices).toBeGreaterThanOrEqual(2);
    expect(t.funnel.visited).toBeGreaterThanOrEqual(2);
    expect(t.funnel.opened_a_night).toBeGreaterThanOrEqual(2);
    expect(t.funnel.saved_or_going).toBeGreaterThanOrEqual(1);
    expect(t.funnel.saved_or_going).toBeLessThanOrEqual(t.funnel.opened_a_night);
    expect(t.daily).toHaveLength(14);
    expect(t.daily.at(-1)!.visits).toBeGreaterThanOrEqual(2);   // A's second visit and B's, today in New York
    expect(t.returning_share).toBeGreaterThan(0);               // A came on two different days
    expect(formatTraffic(t)).toContain('instagram');
  });

  it('is insert-only for the app: RLS on, authenticated may insert and nothing else, anon nothing', async () => {
    for (const table of ['visit', 'action']) {
      const rls = await query<{ relrowsecurity: boolean }>(`select relrowsecurity from pg_class where oid = ('public.' || $1)::regclass`, [table]);
      expect(rls.rows[0]!.relrowsecurity, table).toBe(true);
      const g = await query<{ grantee: string; privilege_type: string }>(
        `select grantee, privilege_type from information_schema.role_table_grants where table_name = $1 and grantee in ('anon', 'authenticated')`, [table]);
      const have = g.rows.map((r) => `${r.grantee}:${r.privilege_type}`).sort();
      // on a Postgres without the Supabase roles there is nothing to grant to; where they exist it is exactly one grant
      if (have.length) expect(have, table).toEqual(['authenticated:INSERT']);
      const pol = await query<{ cmd: string; roles: string[] }>(`select cmd, roles::text[] as roles from pg_policies where tablename = $1`, [table]);
      if (pol.rows.length) expect(pol.rows.map((p) => p.cmd), table).toEqual(['INSERT']);
    }
  });
});
