/**
 * The contract every source adapter implements. Adapters are pure "fetch + normalise" units:
 * they never touch the database. The ingest runner (src/ingest/run.ts) persists NormalizedListing
 * rows through the upsert_listing() SQL function and runs entity resolution.
 */
import type { Env } from '../lib/env.js';
import type { Logger } from '../lib/log.js';

export type SourceKey = 'ra' | 'dice' | 'edmtrain' | 'ticketmaster' | 'elsewhere' | 'goodroom' | 'publicrecords' | 'silo' | '19hz';

export type ListingStatus = 'scheduled' | 'cancelled' | 'postponed' | 'rescheduled' | 'unknown';

export interface PriceTier {
  /** "GA", "Early bird", "Door", "RSVP", "Entry before midnight" */
  tier: string;
  /** dollars, null when unknown */
  price: number | null;
  feesIncluded: boolean | null;
  /** false = sold out / no longer on sale; null = unknown */
  available: boolean | null;
  note: string | null;
}

export interface ExternalRef {
  /** another source's key ('dice', 'ra', 'eventbrite', 'ticketmaster', ...) */
  source: string;
  id: string;
}

export interface NormalizedListing {
  source: SourceKey;
  /** stable per-source id (RA event id, DICE hash, EDMTrain id, TM id, or sha1(url|date|title) for HTML sources) */
  sourceId: string;
  sourceUrl: string | null;
  /** payload exactly as fetched (or the parsed HTML fragment as JSON) — stored in listing.raw */
  raw: unknown;
  /** city key from src/lib/cities.ts ('nyc', 'la', ...) — venue-direct adapters pin theirs */
  city: string;
  /** IANA time zone the listing's local times are read in (night_date, day-party rules, UI clocks) */
  tz: string;

  title: string;
  /** ISO-8601 UTC instants; null when the source only has a date */
  startsAt: string | null;
  endsAt: string | null;
  /** false when the source has a date but no time (EDMTrain, TM timeTBA) */
  hasTime: boolean;
  /** YYYY-MM-DD nightlife date in New York when hasTime is false (else derived from startsAt) */
  night: string | null;

  venueName: string | null;
  venueAddress: string | null;
  /** the source's own venue id (RA club id, DICE venue id, ...) for venue_external_id */
  venueSourceId: string | null;
  venueLat: number | null;
  venueLng: number | null;

  /** billing lines as printed by the source ("A b2b B", "C (live)"); the DB splits them */
  lineup: string[];

  priceMin: number | null;
  priceMax: number | null;
  currency: string;
  feesIncluded: boolean | null;
  priceNote: string | null;
  prices: PriceTier[];
  soldOut: boolean | null;

  status: ListingStatus;
  /** minimum age; 0 = all ages; null unknown */
  ageMin: number | null;
  /** raw genre labels in the SOURCE's vocabulary (RA names, DICE genre_tags suffixes, ...) */
  genres: string[];
  promoters: string[];
  externalRefs: ExternalRef[];

  description: string | null;
  imageUrl: string | null;
  interestedCount: number | null;
  /** anything else worth keeping for enrichment, keyed by source-specific names (e.g. dice_type_tags) */
  sourceTags: Record<string, unknown>;
}

export interface FetchWindow {
  /** inclusive YYYY-MM-DD (New York) — the range this fetch fully enumerated, for tombstoning */
  start: string;
  end: string;
}

export interface FetchContext {
  env: Env;
  log: Logger;
  /** first night to include (YYYY-MM-DD, New York); adapters default to today */
  fromDate: string;
  /** last night to include (YYYY-MM-DD, New York); adapters default to fromDate + 30 */
  toDate: string;
  /** cap on listings for smoke tests; undefined = no cap */
  limit?: number;
  signal?: AbortSignal;
}

export interface FetchResult {
  listings: NormalizedListing[];
  /** null when the adapter cannot promise full enumeration (e.g. a capped RSS feed) */
  window: FetchWindow | null;
  /** non-fatal problems worth surfacing in the run record */
  warnings: string[];
}

export interface SourceAdapter {
  key: SourceKey;
  displayName: string;
  kind: 'api' | 'scrape' | 'feed';
  /** higher wins when choosing canonical title/time/venue across sources */
  priority: number;
  /** whether the source's prices are all-in by default (DICE totals yes, RA priceRetail yes, EB face value no) */
  feesIncludedDefault: boolean;
  /** one-paragraph note on access method + terms, surfaced in docs and the sources screen */
  tosNote: string;
  /** false when a required key is missing — the runner skips it and records why */
  enabled(env: Env): { ok: true } | { ok: false; reason: string };
  fetch(ctx: FetchContext): Promise<FetchResult>;
}

/** Convenience for adapters: a listing with every optional field defaulted. */
export function baseListing(partial: Pick<NormalizedListing, 'source' | 'sourceId' | 'title' | 'raw'> & Partial<NormalizedListing>): NormalizedListing {
  return {
    sourceUrl: null,
    city: 'nyc',
    tz: 'America/New_York',
    startsAt: null,
    endsAt: null,
    hasTime: false,
    night: null,
    venueName: null,
    venueAddress: null,
    venueSourceId: null,
    venueLat: null,
    venueLng: null,
    lineup: [],
    priceMin: null,
    priceMax: null,
    currency: 'USD',
    feesIncluded: null,
    priceNote: null,
    prices: [],
    soldOut: null,
    status: 'scheduled',
    ageMin: null,
    genres: [],
    promoters: [],
    externalRefs: [],
    description: null,
    imageUrl: null,
    interestedCount: null,
    sourceTags: {},
    ...partial,
  };
}
