/**
 * Which nights lead a post.
 *
 * The first version ranked by RA's `interested` and took one per venue. That is a popularity list, and a
 * popularity list in New York is the same four rooms every week: the big ones sell the most tickets, so the
 * big ones always win, and a weekend guide that says Brooklyn Mirage, Knockdown, Avant Gardner, Elsewhere
 * every Friday is a listings page with a logo on it.
 *
 * So interest is the base and everything else is a correction:
 *
 *   - what NOCT is for: queer parties, local collectives, underground rooms, one-offs, sound-system rooms.
 *     A commercial big-room night has to be considerably more wanted to beat a party that is the point.
 *   - what was posted recently: a venue that led a post in the last few weeks is tired, and a venue that
 *     led two is tireder. This is the whole of "it cannot be the same every week" -- it is memory, not taste.
 *   - what is already in this deck: one night per venue, and the second night of a genre is worth less than
 *     the first, so four techno slides do not happen by accident.
 *   - which night it is: every night of the window gets a slide before any night gets a second one.
 *
 * Deterministic: the same feed and the same memory produce the same deck, which is what makes a redraft a
 * redraft rather than a reshuffle.
 */
import type { FeedEvent } from '../feed/shape.js';

/**
 * Whether a listing is a night out rather than something else that happens at a venue.
 *
 * RA lists merch pop-ups, talks and plays alongside parties, and a merch pop-up with a famous name on it can
 * out-rank every club night on "interested". It is still not the post. Deliberately a short list of words
 * that never name a party: tables still list everything, only the slides a whole post leads with are filtered.
 */
const NOT_A_NIGHT = /\b(pop[- ]?up|merch|market|panel|workshop|talk|screening|lecture|class|exhibition|a play)\b/i;
export function isNightOut(ev: Pick<FeedEvent, 'head'>): boolean {
  return !NOT_A_NIGHT.test(ev.head);
}

/**
 * What NOCT leads with, as weights on the enrichment's own vibe codes (src/enrich/taxonomy.ts).
 *
 * Read these against the base, which is log10(1 + interested): a night with 1,000 interested scores 3.0 and
 * one with 100 scores 2.0, so a whole point is a tenfold difference in ticket interest. A queer party with
 * local residents (+0.85) beats a big room (-0.5) with three times its interest; it does not beat one with
 * thirty times, and it should not -- that one is the weekend's news.
 */
export const TASTE: Readonly<Record<string, number>> = {
  queer_party: 0.5,
  underground: 0.45,
  local_crews: 0.35,
  black_diaspora_party: 0.3,
  latinx_party: 0.3,
  one_off_special: 0.3,
  sound_system_focus: 0.25,
  performance_or_cabaret: 0.2,
  live_act: 0.15,
  outdoor_yard: 0.15,
  art_space: 0.15,
  sweaty_basement: 0.1,
  all_nighter: 0.1,
  weekly_residency: -0.15,
  boat_party: -0.15,
  pricey: -0.2,
  mainstream_club: -0.5,
};

/** How much a venue's recent appearances cost it, and how many of them count. */
export const FATIGUE_PER_POST = 0.8;
export const FATIGUE_MAX = 2;
/** What the second night of a genre in one deck is worth against the first. */
export const GENRE_REPEAT = 0.55;
/** What a night costs when another night of the window still has no slide at all. */
export const NIGHT_REPEAT = 1.1;
/**
 * How far below the deck's best a night may be and still be worth covering the calendar with.
 *
 * Spreading across the nights is worth a lot and not worth anything: on a weekend where Sunday's best
 * listing is a bar with forty people interested, a slide for Sunday is a slide spent on nothing. A point
 * and a quarter is about fifteen times the interest -- past that the empty night stays empty and the
 * strongest night gets a second slide.
 */
export const SPREAD_FLOOR = 1.25;

/**
 * Listings with no address to print.
 *
 * "Location TBA", "DM 4 Address": real parties, often the best ones, and a slide that names the venue has
 * nothing to name. They stay in the tables, where a line can say TBA without the post looking broken.
 */
const NOT_A_VENUE = /\blocation\s+tba\b|\btba\b|secret location|dm\s*(4|for)\s*(the\s*)?address/i;
export const hasVenue = (ev: FeedEvent): boolean => Boolean(ev.venue) && !NOT_A_VENUE.test(ev.venue);

/**
 * What the account has been leading with lately.
 *
 * Venues by how many recent posts featured them, and the feed events that already had a slide of their own.
 * Built from the post store (recentlyFeatured) so that drafting stays a pure function of feed plus memory.
 */
export interface Memory {
  venues: Map<string, number>;
  events: Set<string>;
}

export const noMemory = (): Memory => ({ venues: new Map(), events: new Set() });

/** A venue family, folded the way the deck's one-per-venue rule folds it. */
export const venueKey = (venue: string): string => venue.trim().toLowerCase();

const vibeCodes = (ev: FeedEvent): string[] => (ev.vibes ?? []).map((v) => v.code);

/** The house taste, as one number. */
export function tasteOf(ev: FeedEvent): number {
  return vibeCodes(ev).reduce((n, code) => n + (TASTE[code] ?? 0), 0);
}

/**
 * How wanted a night is, before any of the corrections.
 *
 * Log-scaled on purpose: the difference between 50 and 500 interested is real, the difference between 2,000
 * and 2,500 is noise, and a linear score makes the biggest room the answer to every question.
 */
export const interestOf = (ev: FeedEvent): number => Math.log10(1 + Math.max(0, ev.interested));

export interface Chosen {
  venues: Set<string>;
  genres: Map<string, number>;
  nights: Map<number, number>;
}

export interface ScoreContext {
  memory: Memory;
  chosen: Chosen;
  /** How many uncovered nights still have something on them worth a slide. See SPREAD_FLOOR. */
  worthCovering: number;
}

/**
 * What one night is worth right now: with the deck as it stands, and the account's recent posts behind it.
 *
 * Returns null for a night that cannot be picked at all -- one per venue is a rule rather than a weight,
 * because two slides at the same address is the deck visibly repeating itself.
 */
export function scoreNight(ev: FeedEvent, ctx: ScoreContext): number | null {
  const venue = venueKey(ev.venue);
  if (ctx.chosen.venues.has(venue)) return null;

  const fatigue = Math.min(ctx.memory.venues.get(venue) ?? 0, FATIGUE_MAX) * FATIGUE_PER_POST;
  const genre = ev.primary ?? ev.genre[0] ?? '';
  const genreRepeat = genre ? (ctx.chosen.genres.get(genre) ?? 0) * GENRE_REPEAT : 0;

  // Every night of the window gets one before any night gets two: a weekend guide whose four slides are all
  // Friday is a Friday guide. Only while a night that is still empty has something worth covering it with.
  const mine = ctx.chosen.nights.get(ev.d) ?? 0;
  const spread = mine > 0 && ctx.worthCovering > 0 ? NIGHT_REPEAT * mine : 0;

  // An event already given a slide in a recent post is not news twice.
  const repeat = ctx.memory.events.has(ev.id) ? FATIGUE_PER_POST * 2 : 0;

  return interestOf(ev) + tasteOf(ev) - fatigue - genreRepeat - spread - repeat;
}

export interface CurateOptions {
  limit: number;
  /**
   * How many nights the window covers. Kept for callers that know it; the spread rule reads the feed's own
   * nights rather than this, because a window can be three days with only two of them worth posting about.
   */
  nights?: number;
  memory?: Memory;
}

/**
 * The nights that get a slide, best first.
 *
 * Greedy rather than a sort, because most of the corrections depend on what has already been picked: the
 * second techno night and the second Friday are only worth less once the first one is in the deck.
 */
export function curateHeroes(events: FeedEvent[], opts: CurateOptions): FeedEvent[] {
  const memory = opts.memory ?? noMemory();
  const pool = events.filter((ev) => isNightOut(ev) && hasVenue(ev));
  const raw = (ev: FeedEvent): number => interestOf(ev) + tasteOf(ev);
  const best = pool.reduce((n, ev) => Math.max(n, raw(ev)), 0);
  /** The best each night has to offer, for the spread rule's floor. */
  const bestByNight = new Map<number, number>();
  for (const ev of pool) bestByNight.set(ev.d, Math.max(bestByNight.get(ev.d) ?? 0, raw(ev)));
  const chosen: Chosen = { venues: new Set(), genres: new Map(), nights: new Map() };
  const out: FeedEvent[] = [];

  while (out.length < opts.limit) {
    // Nights with nothing on them yet, and something on them worth a slide.
    const worthCovering = [...bestByNight.entries()]
      .filter(([d, top]) => !(chosen.nights.get(d) ?? 0) && top >= best - SPREAD_FLOOR).length;
    let pick: { ev: FeedEvent; score: number } | null = null;
    for (const ev of pool) {
      if (out.includes(ev)) continue;
      const score = scoreNight(ev, { memory, chosen, worthCovering });
      if (score === null) continue;
      // Ties break on the id, so the same feed always gives the same deck.
      if (!pick || score > pick.score || (score === pick.score && ev.id < pick.ev.id)) pick = { ev, score };
    }
    if (!pick) break;
    out.push(pick.ev);
    chosen.venues.add(venueKey(pick.ev.venue));
    const genre = pick.ev.primary ?? pick.ev.genre[0] ?? '';
    if (genre) chosen.genres.set(genre, (chosen.genres.get(genre) ?? 0) + 1);
    chosen.nights.set(pick.ev.d, (chosen.nights.get(pick.ev.d) ?? 0) + 1);
  }

  // One venue per deck is a rule until it costs the deck a slide: a quiet week with three rooms open should
  // still produce a full weekend rather than a short one.
  if (out.length < opts.limit) {
    for (const ev of [...pool].sort((a, b) => interestOf(b) + tasteOf(b) - interestOf(a) - tasteOf(a))) {
      if (out.length >= opts.limit) break;
      if (!out.includes(ev)) out.push(ev);
    }
  }

  // Read as a diary, not as a chart: the deck is ordered by night once the picking is done.
  return out.sort((a, b) => a.d - b.d || b.interested - a.interested);
}
