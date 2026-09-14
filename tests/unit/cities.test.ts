import { afterAll, describe, expect, it } from 'vitest';
import { CITIES, enabledCityKeys, findCity, getCity } from '../../src/lib/cities.js';
import { raTargets } from '../../src/sources/ra.js';
import { resolveParams, buildFeed, FeedParamError } from '../../src/feed/query.js';
import { closePool, query } from '../../src/lib/db.js';

describe('city registry', () => {
  it('has unique keys, a time zone and an RA area per city', () => {
    expect(new Set(CITIES.map((c) => c.key)).size).toBe(CITIES.length);
    for (const c of CITIES) {
      expect(c.tz).toMatch(/^[A-Z][A-Za-z_]+\/[A-Za-z_]+$/);
      expect(c.raAreaId).toBeGreaterThan(0);
    }
    expect(getCity('nyc')).toMatchObject({ raAreaId: 8, tz: 'America/New_York' });
    expect(getCity('la')).toMatchObject({ raAreaId: 23, tz: 'America/Los_Angeles', hzRegion: 'LosAngeles' });
    expect(() => getCity('mars')).toThrow(/Unknown city/);
  });
  it('findCity accepts keys, names and aliases', () => {
    expect(findCity('LA')?.key).toBe('la');
    expect(findCity('Los Angeles')?.key).toBe('la');
    expect(findCity('new york city')?.key).toBe('nyc');
    expect(findCity('bay area')?.key).toBe('sf');
    expect(findCity('atlantis')).toBeNull();
    expect(findCity('')).toBeNull();
  });
  it('NOCT_CITIES selects ingestion cities, defaulting to nyc, rejecting typos', () => {
    expect(enabledCityKeys({})).toEqual(['nyc']);
    expect(enabledCityKeys({ NOCT_CITIES: 'nyc, la ,LA,ber' })).toEqual(['nyc', 'la', 'ber']);
    expect(() => enabledCityKeys({ NOCT_CITIES: 'nyc,sydney' })).toThrow(/Unknown city/);
  });
  it('the RA adapter targets one area per enabled city, NOCT_RA_AREA_ID still overriding New York', () => {
    expect(raTargets({}).targets).toEqual([{ city: 'nyc', areaId: 8, tz: 'America/New_York' }]);
    expect(raTargets({ NOCT_CITIES: 'nyc,la', NOCT_RA_AREA_ID: '99' }).targets).toEqual([
      { city: 'nyc', areaId: 99, tz: 'America/New_York' },
      { city: 'la', areaId: 23, tz: 'America/Los_Angeles' },
    ]);
  });
  it('feed params resolve the city and compute "today" in its zone', () => {
    // 2026-09-14T05:30Z = 01:30 New York (Sep 14) but 22:30 Los Angeles on Sep 13
    const now = new Date('2026-09-14T05:30:00Z');
    expect(resolveParams({}, now)).toMatchObject({ from: '2026-09-14', city: { key: 'nyc' } });
    expect(resolveParams({ city: 'la' }, now)).toMatchObject({ from: '2026-09-13', to: '2026-09-15', city: { key: 'la' } });
    expect(resolveParams({ city: 'la', area: 'Hollywood' }, now).area).toBe('Hollywood');
    expect(() => resolveParams({ city: 'nyc', area: 'Hollywood' }, now)).toThrow(FeedParamError);
    expect(() => resolveParams({ city: 'atlantis' }, now)).toThrow(/unknown/);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('multi-city against Postgres', () => {
  const MARK = 'CityTest 2031';
  afterAll(async () => {
    await query(`delete from listing where source_id like 'citytest-%'`);
    await query(`delete from event where title like $1`, [`%${MARK}%`]);
    await query(`delete from venue where name like $1`, [`%${MARK}%`]);
    await closePool();
  });
  it('an LA listing gets an LA night, an LA venue, and only shows in the LA feed with LA clocks', async () => {
    // 2031-04-05 06:00Z = Fri Apr 4 23:00 PDT (LA night Apr 4) but Sat Apr 5 02:00 EDT (NY night Apr 4 too)
    await query(
      `select * from upsert_listing('ra','citytest-la',null,'{}'::jsonb,null,$1,'2031-04-05T06:00:00Z','2031-04-05T10:00:00Z',true,null,$2,'1642 N Las Palmas Ave, Los Angeles, CA','citytest-v',34.1,-118.33,
         '{"DJ West"}',20,20,true,null,'[]'::jsonb,false,'scheduled',21,'{}','{}',null,null,null,'{}'::jsonb,'[]'::jsonb,'la','America/Los_Angeles')`,
      [`Sound ${MARK}`, `Sound Hollywood ${MARK}`],
    );
    await query(
      `select * from upsert_listing('ra','citytest-ny',null,'{}'::jsonb,null,$1,'2031-04-05T06:00:00Z','2031-04-05T10:00:00Z',true,null,$2,null,'citytest-v2',null,null,
         '{"DJ East"}',20,20,true,null,'[]'::jsonb,false,'scheduled',21,'{}','{}',null,null,null,'{}'::jsonb,'[]'::jsonb)`,
      [`Basement ${MARK}`, `Basement ${MARK}`],
    );
    await query('select resolve_pending()');
    const rows = await query<{ title: string; city: string; tz: string; night: string; vcity: string }>(
      `select e.title, e.city, e.tz, e.night::text as night, v.city as vcity from event e join venue v on v.venue_id = e.venue_id where e.title like $1 order by e.title`, [`%${MARK}%`]);
    expect(rows.rows).toEqual([
      expect.objectContaining({ city: 'nyc', tz: 'America/New_York', night: '2031-04-04', vcity: 'nyc' }),
      expect.objectContaining({ city: 'la', tz: 'America/Los_Angeles', night: '2031-04-04', vcity: 'la' }),
    ]);
    const la = await buildFeed({ from: '2031-04-04', to: '2031-04-04', city: 'la', includeAll: true });
    expect(la.city.key).toBe('la');
    expect(la.events.map((e) => e.head)).toEqual([`Sound ${MARK}`]);
    expect(la.events[0]!.door).toBe('23:00');                     // Los Angeles wall clock, not 02:00 New York
    expect(la.cities.find((c) => c.key === 'la')?.enabled).toBe(true);
    const ny = await buildFeed({ from: '2031-04-04', to: '2031-04-04', includeAll: true });
    expect(ny.events.map((e) => e.head)).toContain(`Basement ${MARK}`);
    expect(ny.events.map((e) => e.head)).not.toContain(`Sound ${MARK}`);
    expect(ny.events.find((e) => e.head === `Basement ${MARK}`)!.door).toBe('02:00');
  });
});
