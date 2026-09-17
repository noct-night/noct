/**
 * A weekend of feed into a seven-slide deck.
 *
 * Shape: cover, three or four event slides, then one or two table slides. That is what was reviewed and
 * approved as the format, and it is also what fits: ten is Instagram's carousel ceiling and seven rows is
 * the most a table slide holds before the type has to shrink.
 *
 * The NYC feed returns on the order of 300 events a night, so the whole job here is choosing. Ranking is by
 * `interested` descending, which is the only popularity signal the feed carries. Note that the number is
 * used to rank and never to print: interested counts and prices go stale between drafting and posting, so
 * they stay off the post face entirely.
 */
import type { FeedDay, FeedEvent, FeedResponse } from '../feed/shape.js';
import { draftWeekendCaption, SITE } from './caption.js';
import { CAROUSEL_MAX, TABLE_ROWS_MAX, type Slide, type Tone } from './types.js';

/** How many events get a slide of their own. Four plus a cover plus two tables is the seven-slide deck. */
const HERO_SLIDES = 4;
/** Rows across all table slides. Two slides at seven rows is the most the deck has room for. */
const TABLE_ROWS_TOTAL = TABLE_ROWS_MAX * 2;

/** Separators RA and DICE use to glue a promoter or series onto its lineup. */
const FEATURING = /\s+(?:ft\.?|feat\.?|featuring|w\/|with|presents?|pres\.?)\s+/i;

/**
 * A title led by its headliner.
 *
 * RA hands over titles like "Magnetic ft Artwork, Alex McCracken, Victor Florescu, UMA DJ, Boat Neck,
 * Lee Cash, whydan" -- the whole bill in one string. At feed-post size that is unreadable, and the name
 * doing the work of getting someone to the party is the first one. So the series keeps its billing, the
 * headliner follows it, and the rest folds away into the caption where there is room to be complete.
 */
export function headlineOf(ev: Pick<FeedEvent, 'head' | 'lineup'>): string {
  const title = ev.head.trim();
  const headliner = ev.lineup[0]?.trim();
  const split = FEATURING.exec(title);
  if (!split) return title;

  const series = title.slice(0, split.index).trim();
  const billed = title.slice(split.index + split[0].length).trim();
  // The separator RA used, so "presents" does not silently become "ft".
  const joiner = split[0].trim().toLowerCase().startsWith('pres') ? 'presents' : 'ft';
  const first = headliner ?? billed.split(/\s*,\s*/)[0]?.trim();
  if (!series) return first ?? title;
  if (!first) return series;
  // A bill of one is not a bill; do not re-glue what was already a single name.
  return billed.includes(',') || headliner ? `${series} ${joiner} ${first}` : title;
}

/** Everyone else on the bill, for the caption. Empty when the title already named them all. */
export function supportingCast(ev: Pick<FeedEvent, 'head' | 'lineup'>): string[] {
  return ev.lineup.slice(1).map((n) => n.trim()).filter(Boolean);
}

/** The venue line on a slide. A room of a complex is named by its complex, then its room. */
function venueOf(ev: FeedEvent): string {
  return ev.room ? `${ev.venue} / ${ev.room}` : ev.venue;
}

/** The genre line. The enriched primary when there is one, else whatever the source said, capped at two. */
function genreOf(ev: FeedEvent): string {
  if (ev.primary) return ev.primary;
  return ev.genre.slice(0, 2).join(' / ');
}

/**
 * Rank a night's events. `interested` first, then a title that is not just a venue name, so a night of
 * zero-interest listings still puts something legible at the top rather than whatever sorted first.
 */
function rank(events: FeedEvent[]): FeedEvent[] {
  return [...events].sort((a, b) => b.interested - a.interested || a.head.localeCompare(b.head));
}

/**
 * Pick the events that get a slide of their own, at most one per venue.
 *
 * Without the venue rule a big room with four rooms of programming takes the whole deck, and the deck stops
 * being a guide to the weekend. The cap is per venue family, so two rooms of Avant Gardner count as one.
 */
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
 * The supporting names worth adding after a headline: the ones the headline does not already carry. A title
 * like "DAY+NIGHT: D.Dan/ Mos/ Elle Dee" names the whole bill, and repeating it as "with Mos, Elle Dee" is
 * the caption saying the same thing twice.
 */
export function namesNotIn(headline: string, names: string[]): string[] {
  const key = (s: string): string => s.replace(/\([^)]*\)/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const said = key(headline);
  return names.filter((n) => key(n) && !said.includes(key(n)));
}

export function pickHeroes(events: FeedEvent[], limit = HERO_SLIDES): FeedEvent[] {
  const seen = new Set<string>();
  const out: FeedEvent[] = [];
  const nights = events.filter(isNightOut);
  for (const ev of rank(nights)) {
    if (out.length >= limit) break;
    const key = ev.venue.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  // If venue de-duplication left the deck short, fill it rather than ship a four-slide weekend.
  if (out.length < limit) {
    for (const ev of rank(nights)) {
      if (out.length >= limit) break;
      if (!out.includes(ev)) out.push(ev);
    }
  }
  return out;
}

const dayOf = (days: FeedDay[], ev: FeedEvent): FeedDay | undefined => days[ev.d];

/** "Friday", from the feed's own day labels, so a post and the app never disagree about which night it is. */
function positionOf(days: FeedDay[], ev: FeedEvent): string {
  const day = dayOf(days, ev);
  if (!day) return '';
  return day.hint === 'Tonight' || day.hint === 'Tomorrow' ? day.hint : WEEKDAY_FULL[day.dow] ?? day.label;
}

const WEEKDAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Sep 18 to 20" when it is one month, "Sep 30 to Oct 2" when it straddles. */
export function spanLabel(days: FeedDay[]): string {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return '';
  if (first === last) return first.sub;
  const sameMonth = first.sub.split(' ')[0] === last.sub.split(' ')[0];
  return sameMonth ? `${first.sub} to ${last.sub.split(' ')[1]}` : `${first.sub} to ${last.sub}`;
}

/** The tone a slide falls back to when it has no flyer. Already deterministic per event in the feed. */
const toneOf = (ev: FeedEvent): Tone => (ev.tex as Tone) ?? 'x1';

export function heroSlide(days: FeedDay[], ev: FeedEvent): Slide {
  return {
    template: 'event',
    data: {
      position: positionOf(days, ev),
      name: headlineOf(ev),
      venue: venueOf(ev),
      time: ev.door,
      genre: genreOf(ev),
      tex: toneOf(ev),
      image: ev.image ? { src: ev.image, fit: 'cover' } : null,
    },
  };
}

/**
 * Table slides for the rest of the weekend, seven rows each.
 *
 * Rows are ordered by night and then by rank, so the tables read as a chronological guide rather than a
 * popularity list. Events that already have a hero slide are left out: a deck that shows the same party
 * twice wastes one of ten slides.
 */
function tableSlides(days: FeedDay[], events: FeedEvent[], used: Set<string>): Slide[] {
  const rows = days.flatMap((day, index) =>
    rank(events.filter((e) => e.d === index && !used.has(e.id))).map((ev) => ({
      day: day.label,
      time: ev.door,
      event: headlineOf(ev),
      venue: venueOf(ev),
    })),
  ).slice(0, TABLE_ROWS_TOTAL);

  const slides: Slide[] = [];
  for (let i = 0; i < rows.length; i += TABLE_ROWS_MAX) {
    const chunk = rows.slice(i, i + TABLE_ROWS_MAX);
    const span = uniqueDays(chunk, days);
    slides.push({
      template: 'table',
      data: {
        kicker: slides.length === 0 ? 'The rest of the weekend' : 'And also',
        when: span,
        rows: chunk,
      },
    });
  }
  return slides;
}

/** "Friday" for a chunk from one night, "Saturday to Sunday" when it spans. */
function uniqueDays(rows: { day: string }[], days: FeedDay[]): string {
  const labels = [...new Set(rows.map((r) => r.day))];
  const full = labels.map((l) => WEEKDAY_FULL[days.find((d) => d.label === l)?.dow ?? -1] ?? l);
  if (full.length === 0) return '';
  if (full.length === 1) return full[0]!;
  return `${full[0]} to ${full[full.length - 1]}`;
}

export interface WeekendDraft {
  /** The Friday, as the slot the post occupies. */
  slot: string;
  slides: Slide[];
  caption: string;
}

/** The closing slide. Copy as written for it; the link is SITE so it can never drift from the cover. */
export const CTA_SLIDE: Slide = {
  template: 'cta',
  data: {
    question: 'sick of checking 10 places for one night out?',
    answer: 'NYC nightlife, all in one place',
    link: SITE,
    note: 'link in bio',
  },
};

/** What a themed deck changes about the weekend deck: what the cover and the caption say the post is. */
export interface DeckOptions {
  /** Cover lede; a newline marks where it breaks. */
  lede?: string;
  /** The caption's first sentence, before the dates. */
  captionLead?: string;
}

/**
 * Build the deck. Pure: it takes a feed response and returns slides, so the whole shape of a weekend post
 * is unit-testable against a canned feed with no database, no network and no image work.
 */
export function draftWeekend(feed: FeedResponse, opts: DeckOptions = {}): WeekendDraft | null {
  const { days, events } = feed;
  if (days.length === 0 || events.length === 0) return null;

  const heroes = pickHeroes(events);
  const used = new Set(heroes.map((e) => e.id));
  const when = spanLabel(days);

  const cover: Slide = {
    template: 'cover',
    data: {
      lede: opts.lede ?? 'Where to rave and dance\nin New York',
      date: `${when} weekend`,
      foot: SITE,
      image: null,
    },
  };

  // The CTA always closes the deck, so the content is trimmed to leave its slot rather than the CTA being
  // the thing a long weekend pushes past Instagram's ten.
  const slides = [
    ...[cover, ...heroes.map((ev) => heroSlide(days, ev)), ...tableSlides(days, events, used)].slice(0, CAROUSEL_MAX - 1),
    CTA_SLIDE,
  ];

  const caption = draftWeekendCaption({
    lead: opts.captionLead,
    when,
    headlines: heroes.map((ev) => {
      const headline = headlineOf(ev);
      const cast = namesNotIn(headline, supportingCast(ev));
      const tail = cast.length ? ` with ${cast.slice(0, 3).join(', ')}` : '';
      return `${headline}${tail}, ${venueOf(ev)}`;
    }),
    genres: events.flatMap((e) => (e.primary ? [e.primary] : e.genre.slice(0, 1))),
  });

  return { slot: days[0]!.date, slides, caption };
}
