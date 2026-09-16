import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FeedParamError, haversineKm, nightFor, NightNotFound, resolveNightParams,
  LATER_BY_HOURS, MAX_DURATION_HOURS, RADIUS_DEFAULT_KM, START_WITHIN_HOURS,
} from '../../src/feed/night.js';
import { closePool, query } from '../../src/lib/db.js';

describe('night: parameters and distance (offline)', () => {
  it('validates the id and clamps radius and limit', () => {
    const p = resolveNightParams({ e: '0F9B4A3E-1C2D-4E5F-8A9B-0C1D2E3F4A5B' });
    expect(p).toEqual({ id: '0f9b4a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', radiusKm: RADIUS_DEFAULT_KM, limit: 3 });
    expect(resolveNightParams({ e: p.id, radiusKm: '1.5', limit: '6' })).toMatchObject({ radiusKm: 1.5, limit: 6 });
    expect(() => resolveNightParams({})).toThrow(FeedParamError);
    expect(() => resolveNightParams({ e: 'not-a-uuid' })).toThrow(FeedParamError);
    expect(() => resolveNightParams({ e: p.id, radiusKm: '40' })).toThrow(/radius_km/);
    expect(() => resolveNightParams({ e: p.id, limit: '0' })).toThrow(/limit/);
    expect(() => resolveNightParams({ e: p.id, limit: '2.5' })).toThrow(/limit/);
  });
  it('haversine: a hundredth of a degree of latitude is 1.1 km, and Ridgewood to City Hall is about 9 km', () => {
    expect(haversineKm(40.70, -73.93, 40.71, -73.93)).toBeCloseTo(1.112, 2);
    expect(haversineKm(40.692462, -73.901536, 40.7128, -74.006)).toBeCloseTo(9.09, 1);
    expect(haversineKm(40.7, -73.9, 40.7, -73.9)).toBe(0);
  });
});

/**
 * The rule against Postgres: a main event at 23:00–04:00 and a spread of rooms around it. Only the one that is
 * near, another family, closes >= 2 h later, starts within 3 h of the main's close, is listed <= 12 h, is a
 * night out and has a coordinate makes the list. Same harness as recommend.test.ts (direct event rows).
 */
describe.skipIf(!process.env.DATABASE_URL)('nightFor against Postgres', () => {
  const MARK = 'Night Test 2031';
  const NIGHT = '2031-05-02';
  const ids: Record<string, string> = {};
  const vids: Record<string, string> = {};

  const mkVenue = async (key: string, lat: number | null, lng: number | null, parent: string | null = null) => {
    const r = await query<{ venue_id: string }>(
      `insert into venue (name, city, kind, lat, lng, parent_venue_id) values ($1, 'nyc', 'venue', $2, $3, $4) returning venue_id`,
      [`${MARK} ${key}`, lat, lng, parent]);
    vids[key] = r.rows[0]!.venue_id;
    return vids[key]!;
  };
  const mkEvent = async (key: string, title: string, venue: string | null, startsAt: string, endsAt: string | null, over: { night?: string; electronic?: boolean | null } = {}) => {
    const r = await query<{ event_id: string }>(
      `insert into event (title, night, city, tz, starts_at, ends_at, has_time, status, venue_id, is_electronic)
       values ($1, $2::date, 'nyc', 'America/New_York', $3::timestamptz, $4::timestamptz, true, 'scheduled', $5, $6)
       returning event_id`,
      [`${title} ${MARK}`, over.night ?? NIGHT, startsAt, endsAt, venue, over.electronic ?? null]);
    ids[key] = r.rows[0]!.event_id;
    return ids[key]!;
  };

  beforeAll(async () => {
    await query(`delete from event where title like $1`, [`%${MARK}%`]);
    await query(`delete from venue where name like $1`, [`%${MARK}%`]);
    // main room and its neighbours: 0.01 deg of latitude is ~1.1 km
    await mkVenue('main', 40.7000, -73.9300);
    await mkVenue('annex', 40.7001, -73.9301, vids.main!);   // a room of the main complex
    await mkVenue('later', 40.7040, -73.9300);               // 0.44 km
    await mkVenue('sameclose', 40.7020, -73.9300);           // 0.22 km
    await mkVenue('far', 40.7800, -73.9300);                 // 8.9 km
    await mkVenue('marathon', 40.7060, -73.9300);
    await mkVenue('morning', 40.7070, -73.9300);
    await mkVenue('classroom', 40.7030, -73.9300);
    await mkVenue('gig', 40.7035, -73.9300);
    await mkVenue('nowhere', null, null);

    // 23:00–04:00 New York (EDT) on the test night
    await mkEvent('main', 'Main Room All Night', vids.main!, '2031-05-03T03:00:00Z', '2031-05-03T08:00:00Z');
    await mkEvent('later', 'Later Room', vids.later!, '2031-05-03T02:00:00Z', '2031-05-03T11:00:00Z');          // closes 07:00: +3 h -> yes
    await mkEvent('sameclose', 'Closes With It', vids.sameclose!, '2031-05-03T02:00:00Z', '2031-05-03T09:00:00Z'); // +1 h -> no
    await mkEvent('far', 'Far Room', vids.far!, '2031-05-03T02:00:00Z', '2031-05-03T11:00:00Z');                 // 8.9 km -> only at a wide radius
    await mkEvent('annex', 'Annex Afters', vids.annex!, '2031-05-03T02:00:00Z', '2031-05-03T12:00:00Z');         // same family -> no
    await mkEvent('marathon', 'Thirty Hour Pass', vids.marathon!, '2031-05-02T20:00:00Z', '2031-05-04T02:00:00Z'); // 30 h listed -> no
    await mkEvent('morning', 'Sunday Morning Market', vids.morning!, '2031-05-03T13:00:00Z', '2031-05-03T20:00:00Z', { night: '2031-05-03' }); // starts 5 h after close -> no
    await mkEvent('classroom', 'Intro to Ableton Lab: Late Session', vids.classroom!, '2031-05-03T02:00:00Z', '2031-05-03T11:00:00Z'); // a class -> no
    await mkEvent('gig', 'Rock Show Late', vids.gig!, '2031-05-03T02:00:00Z', '2031-05-03T11:00:00Z', { electronic: false });         // not a night out -> no
    await mkEvent('nowhere', 'Unlocated Later Room', vids.nowhere!, '2031-05-03T02:00:00Z', '2031-05-03T11:00:00Z');                 // no coordinate -> no
    await mkEvent('noclose', 'No Close Time', vids.later!, '2031-05-03T03:00:00Z', null);
    // a second qualifying night at the same later room: one row per room, the later close wins
    await mkEvent('laterTwo', 'Later Room Second Floor', vids.later!, '2031-05-03T02:00:00Z', '2031-05-03T10:00:00Z');
    // mains that must not anchor anything: a weekend pass, and a postponed night
    await mkEvent('weekend', 'Weekend Pass', vids.main!, '2031-05-02T19:00:00Z', '2031-05-04T03:00:00Z');
    await mkEvent('postponed', 'Postponed Night', vids.main!, '2031-05-03T03:00:00Z', '2031-05-03T08:00:00Z');
    await query(`update event set status = 'postponed' where event_id = $1`, [ids.postponed]);
  });

  afterAll(async () => {
    await query(`delete from event where title like $1`, [`%${MARK}%`]);
    await query(`delete from venue where name like $1`, [`%${MARK}%`]);
    await closePool();
  });

  it('lists the near room that stays open later -- once -- and nothing else', async () => {
    const r = await nightFor({ e: ids.main });
    expect(r.main.head).toBe(`Main Room All Night ${MARK}`);
    expect(r.main).toMatchObject({ door: '23:00', close: '04:00', lat: 40.7, lng: -73.93, night: NIGHT });
    // two qualifying nights at the later room collapse to one row, the later close
    expect(r.next.map((n) => n.head)).toEqual([`Later Room ${MARK}`]);
    const later = r.next[0]!;
    expect(later).toMatchObject({ door: '22:00', close: '07:00', km: 0.4, walk: true, night: NIGHT });
    expect(later.lat).toBeCloseTo(40.704, 3);
    expect(r.radius_km).toBe(RADIUS_DEFAULT_KM);
  });

  it('a weekend pass or a postponed night anchors nothing', async () => {
    expect((await nightFor({ e: ids.weekend })).next).toEqual([]);
    const p = await nightFor({ e: ids.postponed });
    expect(p.main.status).toBe('postponed');
    expect(p.next).toEqual([]);
  });

  it('widening the radius adds the far room after the near one; the limit caps the list', async () => {
    const wide = await nightFor({ e: ids.main, radiusKm: '10' });
    expect(wide.next.map((n) => n.head)).toEqual([`Later Room ${MARK}`, `Far Room ${MARK}`]);
    expect(wide.next[1]).toMatchObject({ km: 8.9, walk: false });
    const one = await nightFor({ e: ids.main, radiusKm: '10', limit: '1' });
    expect(one.next.map((n) => n.head)).toEqual([`Later Room ${MARK}`]);
  });

  it('says nothing when the main has no close time, and 404s for a night that is not listed', async () => {
    const r = await nightFor({ e: ids.noclose });
    expect(r.next).toEqual([]);
    await expect(nightFor({ e: '00000000-0000-4000-8000-000000000000' })).rejects.toBeInstanceOf(NightNotFound);
    await expect(nightFor({ e: 'nope' })).rejects.toBeInstanceOf(FeedParamError);
  });

  it('the thresholds are the documented ones', () => {
    expect([LATER_BY_HOURS, START_WITHIN_HOURS, MAX_DURATION_HOURS]).toEqual([2, 3, 12]);
  });
});
