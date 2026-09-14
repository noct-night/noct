import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sha1 } from '../../src/lib/normalize.js';
import {
  parsePublicRecordsHome,
  parseRow,
  parseTitleLineup,
  publicRecordsWindow,
  rowToListing,
  stripSubtitles,
  weekdayOf,
} from '../../src/sources/publicrecords.js';

// real https://publicrecords.nyc/ captured 2026-09-13 (83 rows, Sun 9.13 .. Sat 12.19)
const html = readFileSync(new URL('../fixtures/publicrecords_home.html', import.meta.url), 'utf8');
const range = { fromDate: '2026-09-13', toDate: '2026-12-31' };

const row = (dateCell: string, title: string, attrs = 'href="https://link.dice.fm/abc123" data-id="42"') =>
  `<a target="_blank" class="event table-row" ${attrs}><div class="table-cell date">${dateCell}</div>
   <div class="table-cell title">${title}<span class="hide-desktop get-tickets-mobile">Get tickets</span></div></a>`;

describe('publicrecords: homepage', () => {
  const parsed = parsePublicRecordsHome(html, range);
  const byId = (id: string) => parsed.listings.find((l) => l.sourceTags.site_event_id === id)!;

  it('parses every row, in range, with no weekday complaints', () => {
    expect(parsed.rowCount).toBe(83);
    expect(parsed.listings).toHaveLength(83);
    expect(parsed.maxDate).toBe('2026-12-19');
    // the only complaint is the one row the site prints as "7:00 am" (a pm typo on a Live show)
    expect(parsed.warnings).toEqual([expect.stringMatching(/"Dent May": implausible start 7:00 am/)]);
    expect(parsed.warnings.filter((w) => /printed/.test(w))).toEqual([]);
    expect(parsed.listings.every((l) => l.source === 'publicrecords' && l.venueName === 'Public Records' && l.night)).toBe(true);
  });

  it('keeps a Live row with a morning "am" clock date-only instead of storing a 7am start', () => {
    const dent = parsed.listings.find((l) => l.title === 'Dent May')!;
    expect(dent).toMatchObject({ hasTime: false, startsAt: null, night: '2026-10-28', sourceTags: { clock: '7:00 am', pr_type: 'Live' } });
    // a genuine late-morning Etc event keeps its clock
    const gong = parsed.listings.find((l) => /Gong Meditation/.test(l.title))!;
    expect(gong).toMatchObject({ hasTime: true, startsAt: '2026-11-14T16:00:00.000Z', night: '2026-11-14' });
  });

  it('turns "Sun 9.13 Club, 3:00 pm, The Nursery" into a New York instant, room, type and series', () => {
    expect(byId('591')).toMatchObject({
      sourceId: sha1('publicrecords|591'),
      sourceUrl: 'https://link.dice.fm/Q03f22ae9aec',
      title: 'The Nursery: Benji B, Nabihah Iqbal [DJ]',
      startsAt: '2026-09-13T19:00:00.000Z',
      endsAt: null,
      hasTime: true,
      night: '2026-09-13',
      venueAddress: '233 Butler St, Brooklyn, NY 11217',
      lineup: ['Benji B', 'Nabihah Iqbal'],
      promoters: [],
      externalRefs: [{ source: 'dice_short', id: 'Q03f22ae9aec' }],
      sourceTags: { room: 'The Nursery', rooms: ['The Nursery'], pr_type: 'Club', pr_types: ['Club'], series: 'The Nursery', site_event_id: '591', date_label: 'Sun 9.13', clock: '3:00 pm' },
    });
    expect(byId('591').raw).toMatchObject({ siteId: '591', month: 9, day: 13, html: expect.stringContaining('data-id="591"') });
  });

  it('handles multi-room club nights, rooms-less rows, dual types and EST dates', () => {
    expect(byId('760')).toMatchObject({
      startsAt: '2026-09-19T03:00:00.000Z',
      night: '2026-09-18',
      lineup: ['upsammy', 'Kamran Sadeghi', 'OK EG (live)', 'Severja', 'Aion', 'Jacob Gorchov'],
      sourceTags: { room: 'Sound Room / The Atrium / Upstairs', rooms: ['Sound Room', 'The Atrium', 'Upstairs'], series: 'Midgar' },
    });
    expect(byId('812')).toMatchObject({ sourceTags: { room: null, rooms: [], pr_type: 'Live' }, lineup: ['Hana Stretton', 'Jana Horn'] });
    expect(byId('643')).toMatchObject({ sourceTags: { pr_type: 'Club/Live', pr_types: ['Club', 'Live'] }, lineup: ['A Joyful Noise (live)'], promoters: ['Razor-N-Tape'] });
    expect(byId('743')).toMatchObject({ sourceTags: { pr_type: 'Festival' }, lineup: [], startsAt: '2026-11-10T00:00:00.000Z', night: '2026-11-09' });
    expect(byId('798')).toMatchObject({ sourceTags: { pr_type: 'Etc' }, lineup: [], promoters: [] });
  });

  it('drops rows before fromDate and after toDate but still reports the page extent', () => {
    const early = parsePublicRecordsHome(html, { fromDate: '2026-09-17', toDate: '2026-12-31' });
    expect(early.listings).toHaveLength(81);
    expect(early.listings[0]!.night).toBe('2026-09-17');
    const short = parsePublicRecordsHome(html, { fromDate: '2026-09-13', toDate: '2026-09-27' });
    expect(short.listings).toHaveLength(22);
    expect(short.maxDate).toBe('2026-12-19');
    expect(short.rowCount).toBe(83);
  });
});

describe('publicrecords: rows and dates', () => {
  it('parseRow splits the date cell on <br> and collects location spans', () => {
    expect(parseRow(row('Fri 9.18<br>\n Club, \n 11:00 pm, <br><span class="location">Sound Room</span><span class="location">Upstairs</span>', 'X: A, B'))).toMatchObject({
      siteId: '42', href: 'https://link.dice.fm/abc123', weekday: 'Fri', month: 9, day: 18, types: ['Club'], clock: '11:00 pm', rooms: ['Sound Room', 'Upstairs'], title: 'X: A, B',
    });
    expect(parseRow(row('Thu 10.15<br>Club, Live, 8:00 pm, <br><span class="location">Sound Room</span>', 'T'))).toMatchObject({ types: ['Club', 'Live'], clock: '8:00 pm' });
    expect(parseRow(row('Mon 11.9<br>Festival, 7:00 pm', 'T'))).toMatchObject({ types: ['Festival'], rooms: [] });
    expect(parseRow(row('TBA<br>Club', 'T'))).toBeNull();
  });

  it('rowToListing warns when the printed weekday disagrees with the inferred date', () => {
    const warnings: string[] = [];
    const l = rowToListing(parseRow(row('Mon 9.13<br>Club, 3:00 pm', 'Someone'))!, '2026-09-13', warnings);
    expect(l?.night).toBe('2026-09-13');
    expect(warnings).toEqual([expect.stringMatching(/printed Mon 9\.13 but 2026-09-13 is a sun/)]);
  });

  it('rows without a clock are date-only; rows without data-id key on the href', () => {
    const warnings: string[] = [];
    const l = rowToListing(parseRow(row('Sat 9.19<br>Club', 'Someone', 'href="https://link.dice.fm/zzz"'))!, '2026-09-13', warnings);
    expect(l).toMatchObject({ hasTime: false, startsAt: null, night: '2026-09-19', sourceId: sha1('publicrecords|https://link.dice.fm/zzz') });
    expect(warnings).toEqual([]);
  });

  it('year inference: yesterday counts, older dates stay in the past and are dropped, impossible dates are rejected', () => {
    const warnings: string[] = [];
    expect(rowToListing(parseRow(row('Sat 9.12<br>Club, 11:00 pm', 'Yesterday'))!, '2026-09-13', warnings)?.night).toBe('2026-09-12');
    expect(rowToListing(parseRow(row('Fri 9.11<br>Club, 11:00 pm', 'Two days ago'))!, '2026-09-13', warnings)?.night).toBe('2026-09-11');
    expect(rowToListing(parseRow(row('Sat 1.2<br>Club, 11:00 pm', 'Next year'))!, '2026-12-28', warnings)?.night).toBe('2027-01-02');
    expect(warnings).toEqual([]);
    expect(rowToListing(parseRow(row('Mon 2.30<br>Club, 11:00 pm', 'Nope'))!, '2026-01-01', warnings)).toBeNull();
    expect(warnings).toEqual([expect.stringContaining('impossible date 2.30')]);
    // through the page parser the past row is dropped but still counted
    const page = `<html><body>${row('Fri 9.11<br>Club, 11:00 pm', 'Old')}${row('Sat 9.19<br>Club, 11:00 pm', 'New', 'href="https://link.dice.fm/x" data-id="2"')}</body></html>`;
    const parsed = parsePublicRecordsHome(page, { fromDate: '2026-09-13', toDate: '2026-09-30' });
    expect(parsed.rowCount).toBe(2);
    expect(parsed.listings.map((l) => l.night)).toEqual(['2026-09-19']);
  });

  it('weekdayOf', () => {
    expect(weekdayOf('2026-09-13')).toBe(0);
    expect(weekdayOf('2026-09-18')).toBe(5);
  });
});

describe('publicrecords: title → lineup', () => {
  it('splits acts on commas, slashes, ampersands, ft. and with; converts [Live]; drops descriptors', () => {
    expect(parseTitleLineup('Genevieve Artadi ft. Louis Cole & Chiquita Magic', ['Live']).items).toEqual(['Genevieve Artadi', 'Louis Cole', 'Chiquita Magic']);
    expect(parseTitleLineup('Peter Matson [DJ/Hybrid], Stuart Bogie [Live]', ['Live']).items).toEqual(['Peter Matson', 'Stuart Bogie (live)']);
    expect(parseTitleLineup('Croz Boyce [Avey Tare and Geologist of Animal Collective], Masaaki', ['Live']).items).toEqual(['Croz Boyce', 'Masaaki']);
    expect(parseTitleLineup('DURATIONS: DJ Sprinkles, [g] / Naone, Abby Echiverri / Eden Aurelius', ['Club'])).toEqual({
      series: 'DURATIONS', promoter: null, items: ['DJ Sprinkles', '[g]', 'Naone', 'Abby Echiverri', 'Eden Aurelius'],
    });
    expect(parseTitleLineup('Diva Diva: PAURRO & Kiernan Laveaux, Saia & e-Lite, performance by Willow Pill', ['Club']).items).toEqual(['PAURRO', 'Kiernan Laveaux', 'Saia', 'e-Lite', 'Willow Pill']);
    expect(parseTitleLineup('An Evening with Lambchop', ['Live']).items).toEqual(['Lambchop']);
    expect(parseTitleLineup('Razor-N-Tape presents A Joyful Noise [Live], Special Guests', ['Club', 'Live'])).toEqual({ series: null, promoter: 'Razor-N-Tape', items: ['A Joyful Noise (live)'] });
  });

  it('uses the last colon for nested series and leaves billing qualifiers to the DB', () => {
    expect(parseTitleLineup('DURATIONS: Ballet: buttechno, Matana Roberts, Klein, Significant Other', ['Live'])).toMatchObject({ series: 'DURATIONS: Ballet', items: ['buttechno', 'Matana Roberts', 'Klein', 'Significant Other'] });
    expect(parseTitleLineup('Shelter: Timmy Regisford Open To Close', ['Club']).items).toEqual(['Timmy Regisford Open To Close']);
  });

  it('strips album/tour subtitles without eating the next act', () => {
    expect(stripSubtitles('Mark Guiliana – BEAT MUSIC')).toBe('Mark Guiliana');
    expect(stripSubtitles('Nate Mercereau – FANTASTIC THOUGHTS with special guests, Carlos Niño [DJ Set]')).toBe('Nate Mercereau, Carlos Niño [DJ Set]');
    expect(stripSubtitles('Shungu – FAITH IN THE UNKNOWN Live Film & Score')).toBe('Shungu');
    expect(stripSubtitles('Charlotte Greve – WATERBODIES & Kaoru Watanabe – THE ARCH Release Show')).toBe('Charlotte Greve & Kaoru Watanabe');
    expect(parseTitleLineup('New Amsterdam presents Charlotte Greve – WATERBODIES & Kaoru Watanabe – THE ARCH Release Show', ['Live'])).toEqual({
      series: null, promoter: 'New Amsterdam', items: ['Charlotte Greve', 'Kaoru Watanabe'],
    });
  });

  it('Etc and Festival rows carry no lineup', () => {
    expect(parseTitleLineup('Music Sets You Free: Listening to Ryuichi Sakamoto', ['Etc'])).toEqual({ series: null, promoter: null, items: [] });
    expect(parseTitleLineup('DURATIONS Festival 2026', ['Festival']).items).toEqual([]);
  });
});

describe('publicrecords: window promise', () => {
  it('only when the page is populated, runs past toDate and nothing was capped', () => {
    const opts = { fromDate: '2026-09-13', toDate: '2026-09-27', capped: false };
    expect(publicRecordsWindow({ rowCount: 83, maxDate: '2026-12-19' }, opts)).toEqual({ start: '2026-09-13', end: '2026-09-27' });
    expect(publicRecordsWindow({ rowCount: 83, maxDate: '2026-12-19' }, { ...opts, toDate: '2027-06-01' })).toBeNull();
    expect(publicRecordsWindow({ rowCount: 12, maxDate: '2026-12-19' }, opts)).toBeNull();
    expect(publicRecordsWindow({ rowCount: 83, maxDate: null }, opts)).toBeNull();
    expect(publicRecordsWindow({ rowCount: 83, maxDate: '2026-12-19' }, { ...opts, capped: true })).toBeNull();
  });
});
