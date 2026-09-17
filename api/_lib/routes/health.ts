/**
 * GET /api/health — public. Last ingest_run per source, live listing counts, events for the next seven nights,
 * pending review queue, cross-platform coverage, and whether the database answered. Edge-cached for a minute so
 * a dashboard can poll it. The traffic report (0030) lives behind the studio session at /api/traffic.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../../../src/lib/db.js';
import { createLogger } from '../../../src/lib/log.js';
import { sendJson } from '../respond.js';

interface SourceRow {
  source_key: string;
  display_name: string;
  kind: string;
  enabled: boolean;
  run_id: string | null;
  status: string | null;
  trigger: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  listings_seen: number | null;
  listings_new: number | null;
  listings_changed: number | null;
  listings_resolved: number | null;
  error: string | null;
  warning_count: number | null;
}

interface ListingRow {
  source_key: string;
  live: string;
  total: string;
  unresolved: string;
  last_seen_at: Date | null;
}

interface CountRow {
  n: string;
}

const SOURCES_SQL = `
  select s.source_key, s.display_name, s.kind, s.enabled,
         r.run_id, r.status, r.trigger, r.started_at, r.finished_at,
         r.listings_seen, r.listings_new, r.listings_changed, r.listings_resolved, r.error,
         cardinality(r.warnings) as warning_count
  from source s
  left join lateral (select * from ingest_run i where i.source_key = s.source_key order by i.started_at desc limit 1) r on true
  order by s.priority desc`;

const LISTINGS_SQL = `
  select source_key,
         count(*) filter (where gone_at is null) as live,
         count(*) as total,
         count(*) filter (where gone_at is null and event_id is null) as unresolved,
         max(last_seen_at) as last_seen_at
  from listing group by source_key`;

// night_date(now()) is tonight in New York (a 1 am call still counts as the previous night)
const EVENTS_SQL = `
  select count(*) as n from event
  where merged_into is null and status <> 'removed' and night between night_date(now()) and night_date(now()) + 6`;

const REVIEW_SQL = `select count(*) as n from match_candidate where decision = 'pending'`;

interface CoverageRow { city: string; nights: string; multi: string; platforms: string[] }
/**
 * The cross-platform KPI, counted honestly: per city, upcoming nights (30) and how many are listed on two or
 * more ticketing HOSTS (platform_host(), 0028) -- DICE's listing and SILO's dice.fm link are one platform, a
 * 19hz row counts as whatever it links to. Baseline 2026-09-16 by host: chi 19%, la 12%, nyc 14%.
 */
const COVERAGE_SQL = `
  select e.city, count(*) as nights, count(*) filter (where h.n >= 2) as multi,
         (select array_agg(x.host order by x.k desc) from (
            select platform_host(l.source_key, l.source_url) as host, count(*) as k
            from listing l join event ee on ee.event_id = l.event_id
            where ee.city = e.city and ee.merged_into is null and ee.status = 'scheduled' and l.gone_at is null
              and ee.night between night_date(now()) and night_date(now()) + 29
            group by 1 order by 2 desc limit 8) x) as platforms
  from event e
  join lateral (
    select count(distinct platform_host(l.source_key, l.source_url)) as n
    from listing l where l.event_id = e.event_id and l.gone_at is null
  ) h on true
  where e.merged_into is null and e.status = 'scheduled'
    and e.night between night_date(now()) and night_date(now()) + 29
  group by e.city order by e.city`;

const CACHE = { 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
    return;
  }
  const log = createLogger('api:health');
  try {
    const [sources, listings, events, review, coverage] = await Promise.all([
      query<SourceRow>(SOURCES_SQL),
      query<ListingRow>(LISTINGS_SQL),
      query<CountRow>(EVENTS_SQL),
      query<CountRow>(REVIEW_SQL),
      query<CoverageRow>(COVERAGE_SQL),
    ]);
    const rows = sources.rows;
    sendJson(
      res,
      200,
      {
        ok: true,
        db: true,
        now: new Date().toISOString(),
        sources: rows.map((r) => ({
          source: r.source_key,
          displayName: r.display_name,
          kind: r.kind,
          enabled: r.enabled,
          lastRun: r.run_id
            ? {
                runId: Number(r.run_id),
                status: r.status,
                trigger: r.trigger,
                startedAt: r.started_at,
                finishedAt: r.finished_at,
                seen: r.listings_seen ?? 0,
                new: r.listings_new ?? 0,
                changed: r.listings_changed ?? 0,
                resolved: r.listings_resolved ?? 0,
                warnings: r.warning_count ?? 0,
                error: r.error,
              }
            : null,
        })),
        listings: Object.fromEntries(
          listings.rows.map((r) => [r.source_key, { live: Number(r.live), total: Number(r.total), unresolved: Number(r.unresolved), lastSeenAt: r.last_seen_at }]),
        ),
        events: { next7Nights: Number(events.rows[0]?.n ?? 0) },
        review: { pendingCandidates: Number(review.rows[0]?.n ?? 0) },
        // "the layer that includes RA", as a number: nights listed on two or more ticketing hosts, next 30 nights
        coverage: coverage.rows.map((r) => ({
          city: r.city,
          nights: Number(r.nights),
          onTwoOrMorePlatforms: Number(r.multi),
          share: Number(r.nights) ? Math.round((Number(r.multi) / Number(r.nights)) * 1000) / 10 : 0,
          platforms: r.platforms ?? [],
        })),
        attention: {
          blocked: rows.filter((r) => r.error?.startsWith('BLOCKED:')).map((r) => r.source_key),
          failed: rows.filter((r) => r.status === 'failed').map((r) => r.source_key),
        },
      },
      CACHE,
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error('health check failed', { error });
    sendJson(res, 503, { ok: false, db: false, error }, { 'cache-control': 'no-store' });
  }
}
