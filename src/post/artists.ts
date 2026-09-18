/**
 * Coming to New York: the big names playing here soon, one slide each.
 *
 * Every other post NOCT makes is about a night. This one is about who is coming, which is the thing people
 * ask each other and the thing a follower saves a post for. What makes it possible is knowing how big a name
 * is independently of how well its event is selling -- Spotify's follower count (0037), which ranks the post
 * and is never printed on it.
 *
 * Pure, like the other drafters: it takes a feed and what is known about the names in it, so the whole shape
 * of the post is testable with no database and no network.
 */
import type { FeedDay, FeedEvent, FeedResponse } from '../feed/shape.js';
import type { KnownArtist } from '../enrich/artist_spotify.js';
import { foldName } from '../enrich/artist_tracks.js';
import { draftHashtags, SITE, scrubLines } from './caption.js';
import { CTA_SLIDE, isNightOut, spanLabel } from './draft.js';
import type { EditionDraft } from './editions.js';
import type { Slide, Tone } from './types.js';

/** How many names get a slide. Five, a cover and the closing slide is a seven-slide post. */
export const ARTIST_SLIDES = 5;
/**
 * The smallest following that makes a name worth leading a post with.
 *
 * Twenty thousand is a working number, not a law: it is roughly where a name stops being known only to the
 * people already going and starts being a reason to go. The studio can always draft with fewer.
 */
export const MIN_FOLLOWERS = 20_000;

const WEEKDAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const venueOf = (ev: FeedEvent): string => (ev.room ? `${ev.venue} / ${ev.room}` : ev.venue);

/** "Friday, Sep 26" -- a post about a name two weeks out has to say which day it means. */
function whenOf(days: FeedDay[], ev: FeedEvent): string {
  const day = days[ev.d];
  if (!day) return '';
  return `${WEEKDAY_FULL[day.dow] ?? day.label}, ${day.sub}`;
}

export interface BigName {
  artist: KnownArtist;
  ev: FeedEvent;
}

/** The biggest known name on a bill, or null when nobody on it has been looked up or matched. */
export function biggestOn(ev: FeedEvent, known: Map<string, KnownArtist>): KnownArtist | null {
  let best: KnownArtist | null = null;
  for (const name of ev.lineup) {
    const found = known.get(foldName(name));
    if (found && (!best || found.followers > best.followers)) best = found;
  }
  return best;
}

/**
 * The names this post is about: the biggest following first, one night each and one artist each.
 *
 * An artist playing twice in a fortnight is one slide, not two -- the second night belongs in the caption of
 * a different post. Nights only, the same rule the weekend deck uses: a merch pop-up with a famous name on
 * it out-ranks a lot of parties and is still not a gig.
 */
export function pickBigNames(
  feed: FeedResponse, known: Map<string, KnownArtist>, limit = ARTIST_SLIDES, minFollowers = MIN_FOLLOWERS,
): BigName[] {
  const found: BigName[] = [];
  for (const ev of feed.events) {
    if (!isNightOut(ev)) continue;
    const artist = biggestOn(ev, known);
    if (!artist || artist.followers < minFollowers) continue;
    found.push({ artist, ev });
  }
  found.sort((a, b) => b.artist.followers - a.artist.followers || a.ev.d - b.ev.d);

  const seen = new Set<string>();
  const out: BigName[] = [];
  for (const pick of found) {
    if (out.length >= limit) break;
    if (seen.has(pick.artist.id)) continue;
    seen.add(pick.artist.id);
    out.push(pick);
  }
  // Soonest first, because the post is read as a diary rather than as a chart.
  return out.sort((a, b) => a.ev.d - b.ev.d);
}

/**
 * One name's slide: who, where, when, and nothing else.
 *
 * The same composition as a spotlight -- the flyer if the event has one, the name at the foot. A match that
 * Spotify spelled differently from the listing carries `check`, which never renders: it is what the studio
 * shows as a warning before the post can be approved.
 */
export function artistSlide(days: FeedDay[], pick: BigName): Slide {
  const { artist, ev } = pick;
  return {
    template: 'event',
    data: {
      position: whenOf(days, ev),
      name: artist.name,
      venue: venueOf(ev),
      time: '',
      genre: '',
      tex: (ev.tex as Tone) ?? 'x1',
      image: ev.image ? { src: ev.image, fit: 'cover' } : null,
      ref: ev.id,
      ...(artist.confident
        ? {}
        : { check: `Spotify matched "${artist.name}" to the line-up's "${ev.lineup[0] ?? artist.name}". Confirm it is the same artist.` }),
    },
  };
}

export interface ArtistsOptions {
  limit?: number;
  minFollowers?: number;
  cta?: Slide;
}

/**
 * Build the post, or return null when nobody in the window clears the bar.
 *
 * Null rather than a thin post on purpose: "Coming to New York" with two names nobody has heard of is worse
 * for the account than no post at all, and a quiet fortnight is a real answer.
 */
export function draftComingToNewYork(
  feed: FeedResponse, known: Map<string, KnownArtist>, opts: ArtistsOptions = {},
): EditionDraft | null {
  const picks = pickBigNames(feed, known, opts.limit ?? ARTIST_SLIDES, opts.minFollowers ?? MIN_FOLLOWERS);
  if (picks.length < 2 || feed.days.length === 0) return null;
  const when = spanLabel(feed.days);

  const cover: Slide = {
    template: 'cover',
    data: { lede: 'Big names coming\nto New York', date: when, foot: SITE, image: null },
  };

  const caption = scrubLines(
    [
      `Big names playing New York, ${when}.`,
      '',
      ...picks.map(({ artist, ev }) => `- ${artist.name}, ${venueOf(ev)}, ${whenOf(feed.days, ev)}`),
      '',
      `Tickets and the rest of the calendar at ${SITE}`,
      '',
      draftHashtags(picks.flatMap(({ ev }) => (ev.primary ? [ev.primary] : ev.genre.slice(0, 1)))).join(' '),
    ].join('\n'),
  );

  return {
    series: 'artists',
    slot: null,
    // The window's first day, so drafting again next week is a new post rather than an overwrite of this one.
    edition: feed.range.from,
    slides: [cover, ...picks.map((pick) => artistSlide(feed.days, pick)), opts.cta ?? CTA_SLIDE],
    caption,
  };
}
