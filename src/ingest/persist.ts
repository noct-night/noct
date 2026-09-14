/**
 * NormalizedListing -> upsert_listing() parameters, and batched persistence.
 *
 * The SQL function owns hashing, venue resolution, price-tier replacement and history; this file only maps
 * fields in the exact parameter order of supabase/migrations/0002_core.sql and keeps each transaction short
 * (Supavisor transaction pooling: no session state, no prepared statements, nothing held across statements).
 */
import type pg from 'pg';
import { withTx } from '../lib/db.js';
import type { Logger } from '../lib/log.js';
import type { NormalizedListing } from '../sources/types.js';

export const UPSERT_PARAM_COUNT = 31;
export const UPSERT_SQL = `select listing_id, is_new, changed, event_id from upsert_listing(${Array.from({ length: UPSERT_PARAM_COUNT }, (_, i) => `$${i + 1}`).join(', ')})`;

/** ingest_run.warnings is meant to be readable, not a full error log. */
const MAX_WARNINGS = 25;

/** Postgres refuses U+0000 in text and in jsonb ("unsupported Unicode escape sequence"); scraped HTML occasionally carries it. */
const NUL = String.fromCharCode(0);
const NUL_JSON = JSON.stringify(NUL).slice(1, -1); // the six-character escape JSON.stringify emits for it

export interface PersistResult {
  /** listings stored (inserted or updated) */
  seen: number;
  /** stored for the first time */
  created: number;
  /** already known and content_hash changed (new rows are not counted as changed) */
  changed: number;
  /** rejected up front or refused by Postgres */
  failed: number;
  warnings: string[];
}

interface UpsertRow {
  listing_id: string;
  is_new: boolean;
  changed: boolean;
  event_id: string | null;
}

function text(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  return s.includes(NUL) ? s.split(NUL).join('') : s;
}

/**
 * node-postgres serialises JS arrays as Postgres array literals ('{...}'), which is right for text[] parameters
 * but wrong for jsonb ones — so every jsonb parameter is stringified here, arrays included.
 */
function json(v: unknown): string {
  const s = JSON.stringify(v === undefined ? null : v);
  return s.includes(NUL_JSON) ? s.split(NUL_JSON).join('') : s;
}

/** numeric / double precision happily store 'NaN' and 'Infinity'; a listing must not. */
function num(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function strings(xs: string[] | null | undefined): string[] {
  return (xs ?? []).map((x) => text(x) ?? '').filter((x) => x.length > 0);
}

/** Why a listing cannot be stored at all (the insert would violate NOT NULL); null when it can. */
export function rejectReason(l: NormalizedListing): string | null {
  if (!l.sourceId) return 'missing sourceId';
  if (!l.title || !l.title.trim()) return 'missing title';
  if (!l.night && !l.startsAt) return 'neither night nor startsAt';
  return null;
}

/** The 31 positional parameters of upsert_listing(), in declaration order. */
export function listingParams(l: NormalizedListing, runId: number): unknown[] {
  return [
    // p_source_key, p_source_id, p_source_url, p_raw, p_run_id
    l.source, l.sourceId, text(l.sourceUrl), json(l.raw), runId,
    // p_title, p_starts_at, p_ends_at, p_has_time, p_night
    text(l.title), l.startsAt, l.endsAt, l.hasTime, l.night,
    // p_venue_name, p_venue_addr, p_venue_source_id, p_venue_lat, p_venue_lng
    text(l.venueName), text(l.venueAddress), text(l.venueSourceId), num(l.venueLat), num(l.venueLng),
    // p_lineup, p_price_min, p_price_max, p_fees_included, p_price_note, p_prices
    strings(l.lineup), num(l.priceMin), num(l.priceMax), l.feesIncluded, text(l.priceNote),
    json((l.prices ?? []).map((t) => ({ tier: t.tier, price: num(t.price), feesIncluded: t.feesIncluded, available: t.available, note: t.note }))),
    // p_sold_out, p_status, p_age_min, p_genres, p_promoters
    l.soldOut, l.status, num(l.ageMin), strings(l.genres), strings(l.promoters),
    // p_description, p_image_url, p_interested_count, p_source_tags, p_external_refs
    text(l.description), text(l.imageUrl), num(l.interestedCount), json(l.sourceTags ?? {}), json(l.externalRefs ?? []),
  ];
}

type Tally = Pick<PersistResult, 'seen' | 'created' | 'changed'>;

async function upsertMany(client: pg.PoolClient, batch: NormalizedListing[], runId: number): Promise<Tally> {
  const t: Tally = { seen: 0, created: 0, changed: 0 };
  for (const l of batch) {
    const { rows } = await client.query<UpsertRow>(UPSERT_SQL, listingParams(l, runId));
    const r = rows[0];
    t.seen++;
    if (r?.is_new) t.created++;
    else if (r?.changed) t.changed++;
  }
  return t;
}

function add(into: PersistResult, t: Tally): void {
  into.seen += t.seen;
  into.created += t.created;
  into.changed += t.changed;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Store listings in batches, one transaction per batch. A failing batch is rolled back by Postgres, so it is
 * replayed one listing per transaction: the poison row becomes a warning and its 49 neighbours still land.
 */
export async function persistListings(listings: NormalizedListing[], runId: number, log: Logger, batchSize = 50): Promise<PersistResult> {
  const out: PersistResult = { seen: 0, created: 0, changed: 0, failed: 0, warnings: [] };
  const storable: NormalizedListing[] = [];
  for (const l of listings) {
    const why = rejectReason(l);
    if (why) {
      out.failed++;
      out.warnings.push(`${l.source}:${l.sourceId || '?'} rejected: ${why}`);
    } else {
      storable.push(l);
    }
  }
  for (let i = 0; i < storable.length; i += batchSize) {
    const batch = storable.slice(i, i + batchSize);
    try {
      add(out, await withTx((c) => upsertMany(c, batch, runId)));
    } catch (err) {
      log.warn(`batch ${i / batchSize + 1} rolled back; replaying rows individually`, { error: message(err) });
      for (const l of batch) {
        try {
          add(out, await withTx((c) => upsertMany(c, [l], runId)));
        } catch (e) {
          out.failed++;
          out.warnings.push(`${l.source}:${l.sourceId} ${message(e)}`);
        }
      }
    }
  }
  if (out.warnings.length > MAX_WARNINGS) {
    const extra = out.warnings.length - MAX_WARNINGS;
    out.warnings = [...out.warnings.slice(0, MAX_WARNINGS), `… ${extra} more`];
  }
  return out;
}
