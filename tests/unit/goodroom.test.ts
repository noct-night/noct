import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sha1 } from '../../src/lib/normalize.js';
import {
  buildGoodRoomListings,
  parseGoodRoomFeed,
  parseGoodRoomHome,
  parseLongDate,
  parseRoomLine,
  ticketRef,
} from '../../src/sources/goodroom.js';

// real http://www.goodroombk.com/ and events RSS captured 2026-09-13
const homeHtml = readFileSync(new URL('../fixtures/goodroom_home.html', import.meta.url), 'utf8');
const feedXml = readFileSync(new URL('../fixtures/goodroom_feed.xml', import.meta.url), 'utf8');
const range = { fromDate: '2026-09-13', toDate: '2026-12-31' };

describe('goodroom: homepage articles', () => {
  const { articles, warnings } = parseGoodRoomHome(homeHtml, range);

  it('reads every article with its full date, rooms, ticket link and flyer', () => {
    expect(warnings).toEqual([]);
    expect(articles).toHaveLength(11);
    expect(articles[1]).toMatchObject({
      postId: '5935',
      date: '2026-09-18',
      dateLabel: 'Friday, September 18, 2026',
      ticketUrl: 'https://ra.co/events/2515798',
      flyer: 'http://www.goodroombk.com/dev/wp-content/uploads/2026/08/September_18-web.jpg',
      rooms: [
        { room: 'Good Room', text: 'Eli Escobar (all night)' },
        { room: 'Bad Room', text: 'Eternal Love (all night)' },
      ],
    });
    expect(articles[1]!.html).toContain('id="post-5935"');
    // entities in lineup lines are decoded
    expect(articles[2]!.rooms[0]!.text).toBe('Love Games: Tony Humphries, Lauren Murada & Finn Jones');
    // missing pieces are null, not empty strings
    expect(articles.find((a) => a.postId === '5949')!.flyer).toBeNull();
    expect(articles.find((a) => a.postId === '5915')!.ticketUrl).toBeNull();
  });

  it('falls back to "M/D" + inferred year when the long date label is missing, and says so', () => {
    const html = `<article id="post-1" class="type-events">
      <div class="event-day"><p class="a_main">Sunday:</p></div><div class="event-date"><p class="b_date">1/3</p></div>
      <div class="lineup-title goodroom"><p class="a_main">Good Room:</p></div>
      <div class="lineup goodroom"><p class="c_lineup goodroom">Someone</p></div></article>`;
    const r = parseGoodRoomHome(html, { fromDate: '2026-12-30' });
    expect(r.articles[0]).toMatchObject({ postId: '1', date: '2027-01-03', dateLabel: null });
    expect(r.warnings).toEqual([expect.stringContaining('inferred 2027-01-03')]);
    // a date that just passed stays in the past (nextMonthDay) and is then dropped by the range filter
    const past = parseGoodRoomHome(html.replace('1/3', '9/11'), { fromDate: '2026-09-13' });
    expect(past.articles[0]!.date).toBe('2026-09-11');
    expect(buildGoodRoomListings(past.articles, [], { fromDate: '2026-09-13', toDate: '2026-12-31' }).listings).toEqual([]);
    // an impossible M/D is rejected, not turned into a bogus night
    const bad = parseGoodRoomHome(html.replace('1/3', '2/30'), { fromDate: '2026-01-01' });
    expect(bad.articles[0]!.date).toBeNull();
    expect(bad.warnings).toEqual([expect.stringContaining('inferred nothing from 2/30')]);
  });

  it('parseLongDate', () => {
    expect(parseLongDate('Friday, September 18, 2026')).toEqual({ date: '2026-09-18', weekday: 5 });
    expect(parseLongDate('October 1, 2026')).toEqual({ date: '2026-10-01', weekday: null });
    expect(parseLongDate('9/18')).toBeNull();
  });
});

describe('goodroom: RSS feed', () => {
  it('yields permalink, post id and the "M.D – Headliner" split', () => {
    const items = parseGoodRoomFeed(feedXml);
    expect(items).toHaveLength(10);
    expect(items[0]).toEqual({
      title: '9.26 – Denham Audio',
      link: 'http://www.goodroombk.com/events/9-26-denham-audio/',
      postId: '5950',
      month: 9,
      day: 26,
      headliner: 'Denham Audio',
    });
    expect(items.find((i) => i.postId === '5936')).toMatchObject({ month: 12, day: 3, headliner: 'St Vitus Presents: LUCY (Cooper B. Handy), F.G.S.' });
  });
});

describe('goodroom: text helpers', () => {
  it('ticketRef recognises RA, DICE and Eventbrite event links', () => {
    expect(ticketRef('https://ra.co/events/2515798')).toEqual({ source: 'ra', id: '2515798' });
    expect(ticketRef('https://dice.fm/partner/tickets/event/avxxvv-lucy-cooper-b-handy-fgs-3rd-dec-good-room-new-york-tickets?dice_id=10214088')).toEqual({ source: 'dice', id: 'avxxvv' });
    expect(ticketRef('https://dice.fm/event/pywe38-mark-ernestus-umfang-25th-sep-public-records-new-york-tickets')).toEqual({ source: 'dice', id: 'pywe38' });
    expect(ticketRef('https://www.eventbrite.com/e/everyday-people-nyc-elsewhere-tickets-1986350074544')).toEqual({ source: 'eventbrite', id: '1986350074544' });
    expect(ticketRef('https://otha.eventbrite.com')).toBeNull(); // organiser page, no event id
    expect(ticketRef('https://example.com/tickets/1')).toBeNull();
    expect(ticketRef('not a url')).toBeNull();
    expect(ticketRef(null)).toBeNull();
  });

  it('parseRoomLine separates party/series/promoter labels from billing items', () => {
    expect(parseRoomLine('Eli Escobar (all night)')).toEqual({ series: null, promoter: null, items: ['Eli Escobar (all night)'] });
    expect(parseRoomLine('Love Games: Tony Humphries, Lauren Murada &amp; Finn Jones')).toEqual({
      series: 'Love Games', promoter: null, items: ['Tony Humphries', 'Lauren Murada', 'Finn Jones'],
    });
    expect(parseRoomLine('FIXED with James Axon b2b JDH (all night)')).toEqual({ series: 'FIXED', promoter: null, items: ['James Axon b2b JDH (all night)'] });
    expect(parseRoomLine('Synthicide Halloween ft Terence Fixmer, Andi')).toEqual({ series: 'Synthicide Halloween', promoter: null, items: ['Terence Fixmer', 'Andi'] });
    expect(parseRoomLine('Elsewhere Presents: Otha - Club 20 Tour 2026')).toEqual({ series: null, promoter: 'Elsewhere', items: ['Otha'] });
    expect(parseRoomLine('St Vitus Presents: LUCY (Cooper B. Handy), F.G.S.')).toEqual({ series: null, promoter: 'St Vitus', items: ['LUCY (Cooper B. Handy)', 'F.G.S.'] });
    expect(parseRoomLine('Dam Vera + more')).toEqual({ series: null, promoter: null, items: ['Dam Vera'] });
    expect(parseRoomLine('RA25: NYC')).toEqual({ series: 'RA25', promoter: null, items: [] });
  });
});

describe('goodroom: listings', () => {
  const { articles } = parseGoodRoomHome(homeHtml, range);
  const feed = parseGoodRoomFeed(feedXml);
  const { listings, warnings } = buildGoodRoomListings(articles, feed, range);
  const on = (night: string) => listings.find((l) => l.night === night)!;

  it('builds one date-only listing per article', () => {
    expect(warnings).toEqual([]);
    expect(listings).toHaveLength(11);
    expect(listings.every((l) => l.source === 'goodroom' && !l.hasTime && l.startsAt === null && l.venueName === 'Good Room' && l.night)).toBe(true);
  });

  it('joins the feed by post id for permalink + title, keys on the post id', () => {
    expect(on('2026-09-18')).toMatchObject({
      sourceId: sha1('goodroom|post|5935'),
      sourceUrl: 'http://www.goodroombk.com/events/9-18-eli-escobar/',
      title: 'Eli Escobar (all night)',
      lineup: ['Eli Escobar (all night)', 'Eternal Love (all night)'],
      venueAddress: '98 Meserole Avenue, Brooklyn, NY 11222',
      externalRefs: [{ source: 'ra', id: '2515798' }],
      imageUrl: 'http://www.goodroombk.com/dev/wp-content/uploads/2026/08/September_18-web.jpg',
      sourceTags: {
        rooms: [
          { room: 'Good Room', lineup: 'Eli Escobar (all night)', artists: ['Eli Escobar (all night)'] },
          { room: 'Bad Room', lineup: 'Eternal Love (all night)', artists: ['Eternal Love (all night)'] },
        ],
        series: null,
        headliner: 'Eli Escobar',
        post_id: '5935',
        feed_title: '9.18 – Eli Escobar',
        permalink: 'http://www.goodroombk.com/events/9-18-eli-escobar/',
      },
    });
    expect(on('2026-09-18').raw).toMatchObject({ postId: '5935', feed: { postId: '5935' } });
  });

  it('falls back to the ticket link (then the homepage) when the post is not in the feed', () => {
    expect(on('2026-09-19')).toMatchObject({
      sourceUrl: 'https://ra.co/events/2509846',
      title: 'Love Games: Tony Humphries, Lauren Murada & Finn Jones',
      lineup: ['Tony Humphries', 'Lauren Murada', 'Finn Jones', 'TYLERFROMWHERE', 'Steph Vaye'],
      sourceTags: { series: 'Love Games', headliner: null, permalink: null },
    });
    expect(on('2026-10-09')).toMatchObject({ sourceUrl: 'http://www.goodroombk.com/', title: 'RA25: NYC', lineup: [], externalRefs: [] });
  });

  it('records DICE refs and presenters as promoters', () => {
    expect(on('2026-12-03')).toMatchObject({ externalRefs: [{ source: 'dice', id: 'avxxvv' }], promoters: ['St Vitus'], lineup: ['LUCY (Cooper B. Handy)', 'F.G.S.'] });
    expect(on('2026-09-17')).toMatchObject({ promoters: ['Elsewhere'], lineup: ['Otha'], externalRefs: [] });
    expect(on('2026-09-25')).toMatchObject({ lineup: ['James Axon b2b JDH (all night)', 'A lana (all night)'], sourceTags: { series: 'FIXED' } });
  });

  it('ids do not depend on the feed; permalink/date+title are only fallbacks', () => {
    const noFeed = buildGoodRoomListings(articles, [], range).listings;
    expect(noFeed.find((l) => l.night === '2026-09-18')).toMatchObject({ sourceId: sha1('goodroom|post|5935'), sourceUrl: 'https://ra.co/events/2515798' });
    const anonymous = articles.map((a) => ({ ...a, postId: null }));
    const viaFeed = buildGoodRoomListings(anonymous, feed, range).listings.find((l) => l.night === '2026-09-18')!;
    expect(viaFeed.sourceId).toBe(sha1('goodroom|http://www.goodroombk.com/events/9-18-eli-escobar/'));
    const viaTitle = buildGoodRoomListings(anonymous, [], range).listings.find((l) => l.night === '2026-09-18')!;
    expect(viaTitle.sourceId).toBe(sha1('goodroom|2026-09-18|eli escobar all night'));
  });

  it('keeps only nights inside [fromDate, toDate]', () => {
    const r = buildGoodRoomListings(articles, feed, { fromDate: '2026-09-19', toDate: '2026-10-01' });
    expect(r.listings.map((l) => l.night)).toEqual(['2026-09-19', '2026-09-25', '2026-09-26', '2026-10-01']);
  });
});
