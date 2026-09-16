import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { foldName, pickTrack, resolveArtistTracks, searchUrl, type ItunesSong } from '../../src/enrich/artist_tracks.js';
import { buildFeed } from '../../src/feed/query.js';
import { closePool, query } from '../../src/lib/db.js';

const song = (over: Partial<ItunesSong>): ItunesSong => ({
  wrapperType: 'track', kind: 'song', trackId: 1, artistName: 'Nils Hoffmann', trackName: 'Afterglow',
  trackViewUrl: 'https://music.apple.com/us/album/afterglow/1?i=2', previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview/x.m4a',
  primaryGenreName: 'Dance', ...over,
});

describe('artist tracks: the pick rule (offline)', () => {
  it('folds names the way norm_text() does', () => {
    expect(foldName('MËSTIZA')).toBe('mestiza');
    expect(foldName('  Âme ')).toBe('ame');
    expect(foldName('A$AP Ferg')).toBe('a ap ferg');
    expect(foldName('re:ni')).toBe('re ni');
  });
  it('keeps the first song whose artist is exactly this name, and nothing looser', () => {
    const results = [
      song({ artistName: 'Nils Hoffmann & Ben Böhmer', trackName: 'Together' }),   // a collaboration is not his
      song({ artistName: 'nils hoffmann', trackName: 'Afterglow', trackId: 42 }),
      song({ artistName: 'Nils Hoffmann', trackName: 'Second' }),
    ];
    expect(pickTrack('Nils Hoffmann', results)).toMatchObject({ apple_id: 42, title: 'Afterglow', genre: 'Dance' });
    expect(pickTrack('MËSTIZA', [song({ artistName: 'MESTIZA', trackName: 'Cruz' })])?.title).toBe('Cruz');
    expect(pickTrack('Woof', [song({ artistName: 'Woof Woof' }), song({ artistName: 'DJ Woof' })])).toBeNull();
    expect(pickTrack('Love Higher', [song({ artistName: 'Kygo & Whitney Houston' })])).toBeNull();
  });
  it('skips genres no DJ is filed under, non-songs, and anything not on Apple\'s own hosts', () => {
    expect(pickTrack('Salameh', [song({ artistName: 'Salameh', primaryGenreName: 'Classical' })])).toBeNull();
    expect(pickTrack('Salameh', [song({ artistName: 'Salameh', primaryGenreName: 'Classical' }), song({ artistName: 'Salameh', primaryGenreName: 'Electronic', trackName: 'Ok' })])?.title).toBe('Ok');
    expect(pickTrack('Nils Hoffmann', [song({ kind: 'music-video' })])).toBeNull();
    expect(pickTrack('Nils Hoffmann', [song({ previewUrl: 'https://evil.example/x.m4a' })])).toBeNull();
    expect(pickTrack('Nils Hoffmann', [song({ previewUrl: 'http://audio-ssl.itunes.apple.com/x.m4a' })])).toBeNull();
    expect(pickTrack('Nils Hoffmann', [song({ trackViewUrl: 'https://music.apple.com.evil.example/x' })])).toBeNull();
    expect(pickTrack('Nils Hoffmann', [song({ previewUrl: undefined })])).toBeNull();
    expect(pickTrack('X', [song({ artistName: 'X' })])).toBeNull();          // one letter is not a name to search
    expect(pickTrack('Nils Hoffmann', null)).toBeNull();
  });
  it('asks Apple for songs in the US store, ten at a time', () => {
    const u = new URL(searchUrl('Âme'));
    expect(u.hostname).toBe('itunes.apple.com');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ term: 'Âme', entity: 'song', media: 'music', limit: '10', country: 'US' });
  });
});

describe.skipIf(!process.env.DATABASE_URL)('artist tracks against Postgres', () => {
  const MARK = 'TrackTest 2031';
  const NIGHT = '2031-08-01';
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await query(`delete from event where title like $1`, [`%${MARK}%`]);
    await query(`delete from artist where name like 'TrackTest %'`);
    for (const [k, title, lineup] of [['a', 'Night A', ['TrackTest Alpha', 'TrackTest Beta']], ['b', 'Night B', ['TrackTest Beta']]] as const) {
      const r = await query<{ event_id: string }>(
        `insert into event (title, night, city, tz, status, is_electronic, lineup) values ($1, $2, 'nyc', 'America/New_York', 'scheduled', true, $3::text[]) returning event_id`,
        [`${title} ${MARK}`, NIGHT, lineup]);
      ids[k] = r.rows[0]!.event_id;
      await query(`select link_event_artists($1)`, [ids[k]]);
    }
  });
  afterAll(async () => {
    await query(`delete from event where title like $1`, [`%${MARK}%`]);
    await query(`delete from artist where name like 'TrackTest %'`);
    await closePool();
  });

  it('looks each pending artist up once, stores hits and misses, and the feed carries the hits per artist', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(decodeURIComponent(new URL(url).searchParams.get('term') ?? ''));
      if (url.includes('Alpha')) return { results: [song({ artistName: 'TrackTest Alpha', trackName: 'Alpha Anthem', trackId: 7 })] };
      return { results: [song({ artistName: 'Somebody Else' })] };
    };
    const artistIds = (await query<{ artist_id: string }>(`select artist_id from artist where name like 'TrackTest %'`)).rows.map((r) => r.artist_id);
    const s1 = await resolveArtistTracks({ fetchImpl, artistIds, budgetMs: 60_000 });
    expect(s1).toMatchObject({ looked_up: 2, found: 1, missed: 1, errors: 0, budgetStopped: false, pending: 0 });
    expect(calls.sort()).toEqual(['TrackTest Alpha', 'TrackTest Beta']);
    // a miss is remembered: nothing is asked again
    const s2 = await resolveArtistTracks({ fetchImpl, artistIds, budgetMs: 60_000 });
    expect(s2.looked_up).toBe(0);
    expect(calls).toHaveLength(2);

    const feed = await buildFeed({ from: NIGHT, to: NIGHT, now: new Date('2031-08-01T20:00:00Z') });
    const a = feed.events.find((e) => e.id === ids.a)!;
    const b = feed.events.find((e) => e.id === ids.b)!;
    expect(a.artist_tracks).toEqual([{ artist: 'TrackTest Alpha', platform: 'apple', title: 'Alpha Anthem', url: 'https://music.apple.com/us/album/afterglow/1?i=2', preview: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview/x.m4a' }]);
    expect(b.artist_tracks).toEqual([]);
  });

  it('stops at the time budget and reports what is left', async () => {
    await query(`update artist_track set checked_at = now() - interval '61 days' where artist_id in (select artist_id from artist where name like 'TrackTest %')`);
    const artistIds = (await query<{ artist_id: string }>(`select artist_id from artist where name like 'TrackTest %'`)).rows.map((r) => r.artist_id);
    const slow = async () => { await new Promise((r) => setTimeout(r, 40)); return { results: [] }; };
    const s = await resolveArtistTracks({ fetchImpl: slow, artistIds, budgetMs: 20 });
    expect(s.budgetStopped).toBe(true);
    expect(s.looked_up + s.pending).toBe(2);
  });

  it('is owner-only: RLS on, nothing granted to anon or authenticated', async () => {
    const rls = await query<{ relrowsecurity: boolean }>(`select relrowsecurity from pg_class where oid = 'public.artist_track'::regclass`);
    expect(rls.rows[0]!.relrowsecurity).toBe(true);
    const g = await query<{ n: string }>(`select count(*) as n from information_schema.role_table_grants where table_name = 'artist_track' and grantee in ('anon', 'authenticated')`);
    expect(Number(g.rows[0]!.n)).toBe(0);
  });
});
