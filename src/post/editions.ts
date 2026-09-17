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

