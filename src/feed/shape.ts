/**
 * event_feed / event_offer rows -> the JSON shape index.html was prototyped against. Pure functions, no I/O, so
 * the conversion is unit-tested offline with canned rows. Everything here is null-safe for events the enrichment
 * pass has not touched yet (no primary_genre, no vibes, no scalars): the UI then falls back to raw source genres.
 */
import { NY_TZ, localDatePlus, toLocalParts } from '../lib/time.js';

/** One row of event_offer, as node-postgres returns it (numeric comes back as a string). */
export interface OfferRow {
  platform: string;
  platform_name: string;
  platform_priority?: number | null;
  source_url: string | null;
  tier: string | null;
  price: number | string | null;
  fees_included: boolean | null;
  available: boolean | null;
  note: string | null;
  sold_out: boolean | null;
}

export interface FeedSourceLink {
  source: string;
  name: string;
  url: string | null;
}

export interface FeedVibe {
  code: string;
  label: string;
  glyph: string | null;
  kind?: string;
}

/** One row of event_feed plus the aggregated `offers` the feed query attaches. */
export interface FeedRow {
  event_id: string;
  title: string;
  /** YYYY-MM-DD (cast to text in SQL so pg does not turn it into a local-midnight Date) */
  night: string;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  has_time: boolean;
  status: string;
  venue_id: string | null;
  venue_name: string | null;
  venue_kind: string | null;
  family_id: string | null;
  family_name: string | null;
  borough: string | null;
  neighborhood: string | null;
  lat: number | null;
  lng: number | null;
  age_min: number | null;
  lineup: string[] | null;
  description: string | null;
  image_url: string | null;
  interested_count: number | null;
  genres: string[] | null;
  genre_source: string | null;
  primary_genre: string | null;
  primary_genre_label: string | null;
  genre_codes: string[] | null;
  genre_labels: string[] | null;
  /** [{code, label}] in genre_codes order; label null when the taxonomy no longer knows the code */
  genre_tags: { code: string; label: string | null }[] | null;
  genre_confidence: number | string | null;
  vibe_codes: string[] | null;
  vibes: FeedVibe[] | null;
  energy: number | null;
  darkness: number | null;
  crowd_size: number | null;
  start_lateness: number | null;
  end_lateness: number | null;
  price_tier: number | null;
  underground_index: number | null;
  sound_summary: string | null;
  is_electronic: boolean | null;
  needs_review: boolean | null;
  listing_count: number | null;
  platforms: string[] | null;
  cheapest_price: number | string | null;
  sold_out: boolean | null;
  sources: FeedSourceLink[] | null;
  going_count: number | null;
  offers: OfferRow[] | null;
}

export interface VenueRow {
  venue_id: string;
  name: string;
  kind: string;
  address: string | null;
  neighborhood: string | null;
  borough: string | null;
  instagram: string | null;
  website: string | null;
  ra_url: string | null;
  dice_url: string | null;
  verified: boolean;
  lat: number | null;
  lng: number | null;
}

export interface SourceRunRow {
  source_key: string;
  display_name: string;
  enabled: boolean;
  status: string | null;
  finished_at: Date | string | null;
  listings_seen: number | null;
  error: string | null;
}

export interface FeedDay {
  date: string;
  /** 0 = Sunday … 6 = Saturday */
  dow: number;
  /** 'Fri' */
  label: string;
  /** 'Sep 26' */
  sub: string;
  /** 'Tonight' | 'Tomorrow' | 'Sunday' */
  hint: string;
}

/** A ticket offer as the prototype renders it: [platform label, price or null, note, url]. */
export type FeedSrc = [string, number | null, string, string | null];

export interface FeedEvent {
  /** canonical event uuid */
  id: string;
  /** 1-based position in the response; index.html uses it as the numeric id its onclick handlers expect */
  n: number;
  /** index into days[] */
  d: number;
  head: string;
  lineup: string[];
  /** venue family name ("Avant Gardner", never "The Great Hall"); key into venues{} */
  venue: string;
  /** room name when the event is in a room of a complex, else null */
  room: string | null;
  /** 'HH:mm' New York, '' when the source only had a date */
  door: string;
  close: string;
  /** display labels: taxonomy labels when enriched, else raw source labels */
  genre: string[];
  /** where the labels came from: 'NOCT tags' | 'RA tags' | '' */
  gsrc: string;
  /** taxonomy label of the primary genre, null until the enrichment pass has run */
  primary: string | null;
  genre_codes: string[];
  /** genre_codes with their labels, for the "Why these tags?" block (label falls back to the code) */
  tags: { code: string; label: string }[];
  genre_confidence: number | null;
  vibes: FeedVibe[];
  scalars: {
    energy: number | null;
    darkness: number | null;
    crowd_size: number | null;
    start_lateness: number | null;
    end_lateness: number | null;
    price_tier: number | null;
    underground_index: number | null;
  };
  sound: string;
  /** '21+' | 'All ages' | '' */
  age: string;
  interested: number;
  srcs: FeedSrc[];
  platforms: string[];
  ra: string;
  dice: string;
  eb: string;
  /** best link when none of the three above exists (venue page, Ticketmaster, ...) */
  url: string;
  /** deterministic CSS texture 'x1'..'x6' from the uuid; the prototype's placeholder art */
  tex: string;
  full: boolean;
  soldout: boolean;
  note: string;
  status: string;
  image: string;
  going_count: number;
  needs_review: boolean;
  is_electronic: boolean | null;
}

export interface FeedVenue {
  addr: string;
  hood: string;
  boro: string;
  ig: string;
  site: string;
  ra: string;
  dice: string;
  verified: boolean;
  lat: number | null;
  lng: number | null;
}

export interface FeedSourceStatus {
  key: string;
  name: string;
  last_run: { status: string; finished_at: string | null; seen: number; error: string | null } | null;
}

export interface FeedResponse {
  generated_at: string;
  range: { from: string; to: string };
  days: FeedDay[];
  venues: Record<string, FeedVenue>;
  events: FeedEvent[];
  genres: string[];
  sources: FeedSourceStatus[];
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Prototype labels for source keys; anything unknown falls back to the key upper-cased. */
const SOURCE_LABEL: Record<string, string> = {
  ra: 'RA',
  dice: 'DICE',
  elsewhere: 'Elsewhere',
  goodroom: 'Good Room',
  publicrecords: 'Public Records',
  ticketmaster: 'Ticketmaster',
  edmtrain: 'EDMTrain',
};

/** Edge cache: five minutes fresh, fifteen more served stale while Vercel revalidates. */
export function feedCacheHeaders(maxAgeS = 300, staleS = 900): Record<string, string> {
  return {
    'cache-control': `public, s-maxage=${maxAgeS}, stale-while-revalidate=${staleS}`,
    'vercel-cdn-cache-control': `s-maxage=${maxAgeS}`,
  };
}

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function asDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 'HH:mm' wall clock in New York, '' when absent. */
export function clock(v: Date | string | null | undefined, tz = NY_TZ): string {
  const d = asDate(v);
  return d ? toLocalParts(d, tz).time : '';
}

/** The days strip: one entry per calendar day in [from, to]; hints are relative to `now` in New York. */
export function buildDays(from: string, to: string, now: Date = new Date(), tz = NY_TZ): FeedDay[] {
  const today = localDatePlus(0, tz, now);
  const tomorrow = localDatePlus(1, tz, now);
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const days: FeedDay[] = [];
  if (!Number.isFinite(start) || !Number.isFinite(end)) return days;
  for (let t = start; t <= end; t += 86_400_000) {
    const d = new Date(t);
    const date = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    days.push({
      date,
      dow,
      label: WEEKDAY_SHORT[dow]!,
      sub: `${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`,
      hint: date === today ? 'Tonight' : date === tomorrow ? 'Tomorrow' : WEEKDAY_LONG[dow]!,
    });
  }
  return days;
}

/** 'x1'..'x6' from the first 8 hex digits of the uuid — stable per event so the placeholder art does not flicker. */
export function texOf(uuid: string): string {
  const n = Number.parseInt(uuid.replace(/-/g, '').slice(0, 8), 16);
  return `x${(Number.isFinite(n) ? n % 6 : 0) + 1}`;
}

/** Raw source labels are printed as-is by RA ('Deep House') but slugged by DICE ('tech-house'); tidy the latter. */
function prettyRaw(label: string): string {
  const s = label.replace(/[-_]+/g, ' ').trim();
  return s && s === s.toLowerCase() ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function dedupe(labels: string[]): string[] {
  const seen = new Set<string>();
  return labels.filter((l) => {
    const k = l.toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Genre display + provenance: taxonomy labels win; otherwise raw source labels credited to the sources that tagged. */
export function genreDisplay(row: Pick<FeedRow, 'genre_labels' | 'primary_genre_label' | 'genres' | 'genre_source'>): { genre: string[]; gsrc: string } {
  const taxonomy = dedupe([...(row.primary_genre_label ? [row.primary_genre_label] : []), ...(row.genre_labels ?? [])]);
  if (taxonomy.length) return { genre: taxonomy, gsrc: 'NOCT tags' };
  const raw = dedupe((row.genres ?? []).map(prettyRaw));
  if (!raw.length) return { genre: [], gsrc: '' };
  const who = (row.genre_source ?? '').split(',').map((k) => k.trim()).filter(Boolean).map((k) => SOURCE_LABEL[k] ?? k.toUpperCase());
  return { genre: raw, gsrc: who.length ? `${who.join(' + ')} tags` : 'source tags' };
}

export function ageLabel(ageMin: number | null | undefined): string {
  if (ageMin === null || ageMin === undefined) return '';
  return ageMin > 0 ? `${ageMin}+` : 'All ages';
}

/**
 * RA stores its per-tier validType verbatim as the tier note (VALID / SOLDOUT / NOLONGERONSALE / NOTYETONSALE).
 * `available` already carries the boolean, so the token becomes its human reading — or nothing when the
 * availability suffix says the same thing. NOLONGERONSALE is deliberately not "Sold out": the sale window closed,
 * door sales may remain (see src/sources/ra.ts). Notes from other sources pass through untouched.
 */
const STATUS_TOKENS = new Map<string, string | null>([
  ['VALID', null],
  ['SOLDOUT', null],
  ['NOLONGERONSALE', 'No longer on sale'],
  ['NOTYETONSALE', 'Not yet on sale'],
]);

/** Note text for one offer row: tier (unless the generic GA), the source's note, then availability. */
function offerNote(o: OfferRow): string {
  const parts: string[] = [];
  if (o.tier && o.tier !== 'GA') parts.push(o.tier);
  const isToken = o.note !== null && STATUS_TOKENS.has(o.note);
  if (o.note && !isToken) parts.push(o.note);
  const human = isToken ? STATUS_TOKENS.get(o.note as string) : null;
  if (human) parts.push(human);
  else if (o.available === false) parts.push('Sold out');
  else if (o.available === true) parts.push('On sale');
  return parts.length ? parts.join(' · ') : 'See listing';
}

/** available-first, cheapest-first, then source priority — the same order event_offer declares. */
export function sortOffers(offers: OfferRow[]): OfferRow[] {
  return [...offers].sort((a, b) => {
    const ua = a.available === false ? 1 : 0;
    const ub = b.available === false ? 1 : 0;
    if (ua !== ub) return ua - ub;
    const pa = num(a.price);
    const pb = num(b.price);
    if (pa !== pb) {
      if (pa === null) return 1;
      if (pb === null) return -1;
      return pa - pb;
    }
    return (b.platform_priority ?? 0) - (a.platform_priority ?? 0);
  });
}

const MAX_SRCS = 8;

function shapeSrcs(row: FeedRow): FeedSrc[] {
  const offers = sortOffers(row.offers ?? []).slice(0, MAX_SRCS);
  if (offers.length) return offers.map((o) => [o.platform_name, num(o.price), offerNote(o), o.source_url]);
  // no ticketing source yet (a venue page or aggregator only): still give the UI one "way in" per source
  return (row.sources ?? []).slice(0, MAX_SRCS).map((s) => [s.name, null, 'See listing', s.url]);
}

const urlOf = (sources: FeedSourceLink[], pick: (s: FeedSourceLink) => boolean): string => sources.find((s) => s.url && pick(s))?.url ?? '';

/** One event_feed row -> one prototype event. `n` is its 1-based position, `d` the index into days[]. */
export function shapeEvent(row: FeedRow, opts: { n?: number; d?: number; tz?: string } = {}): FeedEvent {
  const { n = 1, d = 0, tz = NY_TZ } = opts;
  const sources = row.sources ?? [];
  const { genre, gsrc } = genreDisplay(row);
  const lineup = row.lineup ?? [];
  const hasTime = row.has_time === true && row.starts_at !== null;
  const isRoom = !!row.family_id && row.family_id !== row.venue_id;
  return {
    id: row.event_id,
    n,
    d,
    head: row.title,
    lineup,
    venue: row.family_name ?? row.venue_name ?? 'Venue TBA',
    room: isRoom ? row.venue_name : null,
    door: hasTime ? clock(row.starts_at, tz) : '',
    close: hasTime ? clock(row.ends_at, tz) : '',
    genre,
    gsrc,
    primary: row.primary_genre_label ?? row.primary_genre ?? null,
    genre_codes: row.genre_codes ?? [],
    tags: (row.genre_tags ?? (row.genre_codes ?? []).map((code) => ({ code, label: null }))).map((t) => ({ code: t.code, label: t.label ?? t.code })),
    genre_confidence: num(row.genre_confidence),
    vibes: row.vibes ?? [],
    scalars: {
      energy: row.energy ?? null,
      darkness: row.darkness ?? null,
      crowd_size: row.crowd_size ?? null,
      start_lateness: row.start_lateness ?? null,
      end_lateness: row.end_lateness ?? null,
      price_tier: row.price_tier ?? null,
      underground_index: row.underground_index ?? null,
    },
    sound: row.sound_summary ?? '',
    age: ageLabel(row.age_min),
    interested: row.interested_count ?? 0,
    srcs: shapeSrcs(row),
    platforms: row.platforms ?? [],
    ra: urlOf(sources, (s) => s.source === 'ra'),
    // Public Records links out through link.dice.fm short links, which count as a DICE way in
    dice: urlOf(sources, (s) => s.source === 'dice') || urlOf(sources, (s) => /(^|\.)dice\.fm\//.test(s.url ?? '')),
    eb: urlOf(sources, (s) => /eventbrite\.(com|co\.uk)\//.test(s.url ?? '')),
    url: urlOf(sources, () => true),
    tex: texOf(row.event_id),
    full: hasTime && lineup.length > 0,
    soldout: row.sold_out === true,
    note: row.description ?? '',
    status: row.status,
    image: row.image_url ?? '',
    going_count: row.going_count ?? 0,
    needs_review: row.needs_review === true,
    is_electronic: row.is_electronic ?? null,
  };
}

export function shapeVenue(v: VenueRow): FeedVenue {
  return {
    addr: v.address ?? '',
    hood: v.neighborhood ?? '',
    boro: v.borough ?? '',
    ig: v.instagram ?? '',
    site: v.website ?? '',
    ra: v.ra_url ?? '',
    dice: v.dice_url ?? '',
    verified: v.verified === true,
    lat: v.lat ?? null,
    lng: v.lng ?? null,
  };
}

export function shapeSource(s: SourceRunRow): FeedSourceStatus {
  const finished = asDate(s.finished_at);
  return {
    key: s.source_key,
    name: s.display_name,
    last_run: s.status
      ? { status: s.status, finished_at: finished ? finished.toISOString() : null, seen: s.listings_seen ?? 0, error: s.error ?? null }
      : null,
  };
}

/** Distinct genre labels across the events, in first-seen order, for the filter sheet. */
export function genreFilterList(events: FeedEvent[]): string[] {
  return dedupe(events.flatMap((e) => e.genre));
}
