/**
 * Choosing a deck's nights by hand.
 *
 * The drafter picks a weekend deck's event slides by RA interest, one per venue. That is a reasonable first
 * pass and nothing more: she knows which nights NOCT wants to be seen recommending. So a weekend deck or a
 * genre edition can be rebuilt around nights chosen from the same ranked list the drafter picked from.
 *
 * Pure apart from nothing: the API fetches the feed, and everything about what is offered and what counts as
 * already chosen is decided here, where it can be tested against a canned feed.
 */
import type { FeedEvent, FeedResponse } from '../feed/shape.js';
import { localDatePlus } from '../lib/time.js';
import { candidateNights, headlineOf, type DeckOptions } from './draft.js';
import { FAMILY_PHRASE, genreDeckOptions, inFamily } from './editions.js';
import type { Post, Slide } from './types.js';

/** One night on offer, as the studio lists it. `interested` is shown to her, never printed on a post. */
export interface Candidate {
  id: string;
  name: string;
  venue: string;
  day: string;
  door: string;
  genre: string;
  interested: number;
}

/** Why a post cannot have its nights chosen, or null when it can. */
export function cannotChoose(post: Pick<Post, 'kind' | 'series' | 'slot' | 'edition' | 'status'>): string | null {
  if (post.kind !== 'carousel' || (post.series !== 'weekend' && post.series !== 'genre') || !post.slot) {
    return 'only weekend decks and genre editions are built from a list of nights';
  }
  if (post.series === 'genre' && !(post.edition && FAMILY_PHRASE[post.edition])) {
    return 'this genre edition does not name a genre it can be rebuilt from';
  }
  if (post.status === 'posted') return 'this post is already published and cannot be changed';
  return null;
}

/** The three nights a deck covers, Friday to Sunday, from the Friday it is slotted on. */
export function deckWindow(slot: string): { from: string; to: string } {
  return { from: slot, to: localDatePlus(2, 'UTC', new Date(`${slot}T12:00:00Z`)) };
}

/** The feed a deck is drawn from, and how its cover and caption read: a genre edition sees only its genre. */
export function deckSource(
  post: Pick<Post, 'series' | 'edition'>, feed: FeedResponse,
): { feed: FeedResponse; opts: DeckOptions } {
  if (post.series === 'genre' && post.edition) {
    return { feed: inFamily(feed, post.edition), opts: genreDeckOptions(post.edition) };
  }
  return { feed, opts: {} };
}

const venueLine = (ev: FeedEvent): string => (ev.room ? `${ev.venue} / ${ev.room}` : ev.venue);

/**
 * The feed events a deck's event slides are about, in slide order. By `ref` when the slide has one; a deck
 * drafted before slides carried it is matched on headline and venue instead.
 */
export function chosenIds(slides: Slide[], events: FeedEvent[]): string[] {
  const ids: string[] = [];
  for (const s of slides) {
    if (s.template !== 'event') continue;
    const match = s.data.ref
      ? events.find((e) => e.id === s.data.ref)
      : events.find((e) => headlineOf(e) === s.data.name && venueLine(e) === s.data.venue);
    if (match && !ids.includes(match.id)) ids.push(match.id);
  }
  return ids;
}

/**
 * The events a deck's table rows are about.
 *
 * Table rows carry no event id -- they are display strings, deliberately (see types.ts) -- so they are
 * matched the way a deck drafted before `ref` existed is: by the headline and the venue as they were
 * printed. A row whose event has since left the feed simply is not found, which is the right answer.
 */
export function listedIds(slides: Slide[], events: FeedEvent[]): string[] {
  const ids: string[] = [];
  for (const s of slides) {
    if (s.template !== 'table') continue;
    for (const row of s.data.rows) {
      const match = events.find((e) => headlineOf(e) === row.event && venueLine(e) === row.venue);
      if (match && !ids.includes(match.id)) ids.push(match.id);
    }
  }
  return ids;
}

/** What the studio offers: the ranked nights, plus any already in the deck that fell outside the top of it. */
export function candidatesFor(
  feed: FeedResponse, slides: Slide[], limit = 40,
): { candidates: Candidate[]; chosen: string[]; rows: string[] } {
  const chosen = chosenIds(slides, feed.events);
  const rows = listedIds(slides, feed.events);
  const offered = candidateNights(feed.events, limit);
  const inDeck = new Set([...chosen, ...rows]);
  const extra = feed.events.filter((e) => inDeck.has(e.id) && !offered.includes(e));
  const candidates = [...offered, ...extra].map((ev) => ({
    id: ev.id,
    name: headlineOf(ev),
    venue: venueLine(ev),
    day: feed.days[ev.d]?.label ?? '',
    door: ev.door,
    genre: ev.primary ?? ev.genre[0] ?? '',
    interested: ev.interested,
  }));
  return { candidates, chosen, rows };
}
