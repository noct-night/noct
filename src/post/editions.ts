/**
 * Posts beyond the weekend deck: genre editions and big-night spotlights.
 *
 * Both are built from the same feed and the same slide templates as the weekend deck, and both land in the
 * studio as queued drafts. Nothing here approves or publishes -- a person still decides what NOCT says.
 *
 * Each draft names its `edition` (a genre family, an event id) so that several can share a weekend without
 * one overwriting another, and so that drafting again updates the same post rather than stacking copies.
 */
import { GENRES } from '../enrich/taxonomy.js';
import type { FeedEvent, FeedResponse } from '../feed/shape.js';
import { draftHashtags, SITE, scrubLines } from './caption.js';
import { CTA_SLIDE, draftWeekend, headlineOf, heroSlide, namesNotIn, pickHeroes, supportingCast } from './draft.js';
import type { Series, Slide } from './types.js';

export interface EditionDraft {
  series: Series;
  slot: string | null;
  /** Which one within the series and slot: a genre family, an event id. */
  edition: string;
  slides: Slide[];
  caption: string;
}

// ── Genre editions ─────────────────────────────────────────────────────────

/**
 * How each family reads in a sentence ("Where to hear ___ in New York"). Families, not sub-genres: a weekend
 * has 47 deep house nights and 8 afro house ones, and "House" is one strong post where four thin ones are not.
 * Open format is left out on purpose -- "eclectic" is the absence of a genre, not an edition of one.
 */
export const FAMILY_PHRASE: Record<string, string> = {
  house: 'house',
  techno: 'techno',
  trance: 'trance',
  dnb: 'drum & bass',
  bass: 'bass and breaks',
  dubstep: 'dubstep',
  hard: 'hard dance',
  electro: 'electro and EBM',
  leftfield: 'ambient and experimental',
  hiphop: 'hip-hop and R&B',
  latin: 'reggaeton and Latin club',
  afro: 'afrobeats and amapiano',
  carib: 'dancehall and soca',
  ballroom: 'ballroom',
  disco: 'disco',
  live: 'live electronic',
  jazz: 'jazz and broken beat',
};

const FAMILY_BY_LABEL = new Map(GENRES.map((g) => [g.label, g.family]));

/** An event's genre family: its enriched primary genre if there is one, else its first genre code. */
export function familyOf(ev: Pick<FeedEvent, 'primary' | 'genre_codes'>): string | null {
  if (ev.primary && FAMILY_BY_LABEL.has(ev.primary)) return FAMILY_BY_LABEL.get(ev.primary)!;
  const code = ev.genre_codes[0];
  return code ? (code.split('.')[0] ?? null) : null;
}

/** Fewer nights than this and an edition is a table with nothing in it. */
export const EDITION_MIN_EVENTS = 6;
/** Editions per weekend. Three is plenty next to the main deck; more is the same post again. */
export const EDITIONS_PER_WEEKEND = 3;

/**
 * The weekend's strongest genres, each as its own deck: cover, hero nights, table, CTA -- the weekend deck's
 * shape, restricted to one family. Ranked by how many nights that family has, which is how much there is to
 * say about it.
 */
export function draftGenreEditions(
  feed: FeedResponse, limit = EDITIONS_PER_WEEKEND, minEvents = EDITION_MIN_EVENTS,
): EditionDraft[] {
  const byFamily = new Map<string, FeedEvent[]>();
  for (const ev of feed.events) {
    const family = familyOf(ev);
    if (!family || !FAMILY_PHRASE[family]) continue;
    byFamily.set(family, [...(byFamily.get(family) ?? []), ev]);
  }

  return [...byFamily.entries()]
    .filter(([, evs]) => evs.length >= minEvents)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .flatMap(([family, evs]) => {
      const phrase = FAMILY_PHRASE[family]!;
      const deck = draftWeekend({ ...feed, events: evs }, {
        lede: `Where to hear ${phrase}\nin New York`,
        captionLead: `Where to hear ${phrase} in New York`,
      });
      return deck ? [{ series: 'genre' as const, slot: deck.slot, edition: family, slides: deck.slides, caption: deck.caption }] : [];
    });
}

// ── Big-night spotlights ───────────────────────────────────────────────────

/** Spotlights per run. A spotlight is a single night given the whole post, so a few is the point. */
export const SPOTLIGHTS = 3;

const WEEKDAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The most anticipated nights in the window, one post each: the event slide and the CTA. Nights only --
 * a merch pop-up can out-rank every party on RA interest, and it is still not the post (see isNightOut).
 *
 * Ranked by RA "interested", one per venue, the same rule the weekend deck uses for its heroes, so one room
 * with a big month cannot take every spotlight. The slide names the date as well as the weekday, because a
 * spotlight can be for a night two weeks out.
 *
 * The full line-up goes in the caption. The slide leads with the headliner, and a spotlight is exactly the
 * post where the rest of the bill deserves to be named.
 */
export function draftSpotlights(feed: FeedResponse, limit = SPOTLIGHTS): EditionDraft[] {
  return pickHeroes(feed.events, limit).map((ev) => {
    const day = feed.days[ev.d];
    const hero = heroSlide(feed.days, ev);
    const when = day ? `${WEEKDAY_FULL[day.dow] ?? day.label}, ${day.sub}` : '';
    const slide: Slide = hero.template === 'event' ? { ...hero, data: { ...hero.data, position: when } } : hero;

    const venue = ev.room ? `${ev.venue} / ${ev.room}` : ev.venue;
    const headline = headlineOf(ev);
    const cast = namesNotIn(headline, supportingCast(ev));
    const caption = scrubLines(
      [
        `${headline}, ${venue}${when ? `, ${when}` : ''}${ev.door ? ` from ${ev.door}` : ''}.`,
        ...(cast.length ? ['', `With ${cast.join(', ')}.`] : []),
        '',
        `Tickets and details at ${SITE}`,
        '',
        draftHashtags(ev.primary ? [ev.primary] : ev.genre.slice(0, 2)).join(' '),
      ].join('\n'),
    );

    return { series: 'single' as const, slot: day?.date ?? null, edition: ev.id, slides: [slide, CTA_SLIDE], caption };
  });
}


// ── Venue posts ────────────────────────────────────────────────────────────

/** Venue posts per run. Each is a standalone feature, so a handful at a time is plenty to review. */
export const VENUE_POSTS = 4;
/** A venue needs this many nights in the window for "coming up" to be worth a slide. */
export const VENUE_MIN_NIGHTS = 3;

/** "Location TBA" is a placeholder the sources use, not a venue, and it has no address to print. */
const NOT_A_VENUE = /\blocation\s+tba\b|\btba\b|secret location/i;

/**
 * What a venue is like, in NOCT's own words: the vibe tags and genres of the nights actually booked there.
 *
 * Built from listings rather than written, because a venue post is read as fact and the only facts NOCT has
 * about a room are what it programmes. Time-of-night tags ("Ends early") describe a party, not the room, so
 * they are left out.
 */
export function venueVibe(events: FeedEvent[]): string {
  const count = <T extends string>(items: T[]): T[] => {
    const tally = new Map<T, number>();
    for (const x of items) tally.set(x, (tally.get(x) ?? 0) + 1);
    return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([x]) => x);
  };
  const vibes = count(events.flatMap((e) => (e.vibes ?? []).filter((v) => v.kind !== 'time').map((v) => v.label))).slice(0, 3);
  const genres = count(events.flatMap((e) => (e.primary ? [e.primary] : []))).slice(0, 2);

  // Lowercase for running prose, except acronyms: "UK garage" and "IDM", not "uk garage" and "idm".
  const inProse = (label: string): string =>
    label.split(' ').map((w) => (/^[A-Z0-9&]{2,}$/.test(w) ? w : w.toLowerCase())).join(' ');
  const parts: string[] = [];
  if (vibes.length) {
    parts.push(`${vibes.map((v, i) => (i === 0 ? v : inProse(v))).join(', ')}.`);
  }
  if (genres.length) parts.push(`Mostly ${genres.map(inProse).join(' and ')}.`);
  return parts.join(' ');
}

/**
 * One post per busy venue: who they are, what the room is like, and what is on there soon.
 *
 * Venues come from the listings, ranked by nights booked in the window. Almost none have been checked by a
 * person, and a venue post prints an address in public, so each slide carries `verified` and the studio
 * warns before approval. The photo band is empty until someone adds a photo in the studio.
 */
export function draftVenuePosts(feed: FeedResponse, limit = VENUE_POSTS, minNights = VENUE_MIN_NIGHTS): EditionDraft[] {
  const byVenue = new Map<string, FeedEvent[]>();
  for (const ev of feed.events) {
    if (!ev.venue || NOT_A_VENUE.test(ev.venue)) continue;
    byVenue.set(ev.venue, [...(byVenue.get(ev.venue) ?? []), ev]);
  }

  return [...byVenue.entries()]
    .filter(([name, evs]) => evs.length >= minNights && Boolean(feed.venues[name]?.addr))
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, evs]) => {
      const info = feed.venues[name]!;
      const hood = [info.hood, info.boro].filter(Boolean).join(', ');
      const vibe = venueVibe(evs);
      const upcoming = [...evs].sort((a, b) => a.d - b.d || a.door.localeCompare(b.door));
      const dayOf = (e: FeedEvent): string => {
        const day = feed.days[e.d];
        return day ? `${day.label} ${day.sub.split(' ')[1] ?? ''}`.trim() : '';
      };

      const slides: Slide[] = [
        {
          template: 'venue',
          data: {
            index: '', name, hood, note: vibe, foot: info.addr ?? '', image: null,
            verified: Boolean(info.verified),
          },
        },
        {
          template: 'table',
          data: {
            kicker: `Coming up at ${name}`,
            when: 'Next two weeks',
            rows: upcoming.slice(0, 7).map((e) => ({
              day: dayOf(e), time: e.door, event: headlineOf(e), venue: e.primary ?? e.genre[0] ?? '',
            })),
          },
        },
        CTA_SLIDE,
      ];

      const caption = scrubLines(
        [
          `${name}${hood ? `, ${hood}` : ''}.`,
          ...(vibe ? ['', vibe] : []),
          '',
          'Coming up:',
          ...upcoming.slice(0, 5).map((e) => {
            const day = feed.days[e.d];
            return `- ${day ? `${day.label} ${day.sub}` : ''}: ${headlineOf(e)}`;
          }),
          '',
          `Listings and tickets at ${SITE}`,
          '',
          draftHashtags(evs.flatMap((e) => (e.primary ? [e.primary] : []))).join(' '),
        ].join('\n'),
      );

      return { series: 'venues' as const, slot: null, edition: name, slides, caption };
    });
}
