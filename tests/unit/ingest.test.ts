import type { VercelRequest } from '@vercel/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearerToken, isAuthorized } from '../../api/_lib/auth.js';
import { isCalendarDate, triggerOf } from '../../api/_lib/respond.js';
import { listingParams, rejectReason, UPSERT_PARAM_COUNT } from '../../src/ingest/persist.js';
import { describeError, runIngest } from '../../src/ingest/run.js';
import { closePool, query } from '../../src/lib/db.js';
import { BlockedError } from '../../src/lib/http.js';
import type { Logger } from '../../src/lib/log.js';
import { baseListing, type FetchWindow, type ListingStatus, type NormalizedListing, type SourceAdapter, type SourceKey } from '../../src/sources/types.js';

// 'fake' is not a real SourceKey; the tests register it in `source` themselves.
const FAKE = 'fake' as SourceKey;
// A Saturday far in the future so nothing collides with real listings; 02:00Z = 22:00 New York (EDT).
const NIGHT = '2031-03-15';
const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, child: () => silent };

function fakeAdapter(listings: NormalizedListing[], window: FetchWindow | null = null, overrides: Partial<SourceAdapter> = {}): SourceAdapter {
  return {
    key: FAKE,
    displayName: 'Fake',
    kind: 'api',
    priority: 10,
    feesIncludedDefault: false,
    tosNote: 'test double',
    enabled: () => ({ ok: true }),
    fetch: async () => ({ listings, window, warnings: [] }),
    ...overrides,
  };
}

function sample(): NormalizedListing[] {
  const msn = { source: FAKE, hasTime: true, night: NIGHT, venueName: 'Nowadays', venueAddress: '56-06 Cooper Ave, Ridgewood', lineup: ['Eamon Harkin', 'Justin Carter'] };
  return [
    baseListing({
      ...msn, sourceId: 'fake-a', title: 'Mister Saturday Night with Eamon Harkin', raw: { id: 'a' },
      startsAt: '2031-03-16T02:00:00.000Z', endsAt: '2031-03-16T09:00:00.000Z', priceMin: 25, priceMax: 35, genres: ['House'],
      prices: [
        { tier: 'GA', price: 25, feesIncluded: true, available: true, note: null },
        { tier: 'Door', price: 35, feesIncluded: null, available: null, note: 'cash' },
      ],
    }),
    // same room, same night, same lineup, differently worded title -> must resolve to the same event
    baseListing({ ...msn, sourceId: 'fake-b', title: 'Mister Saturday Night w/ Eamon Harkin & Justin Carter', raw: { id: 'b' }, startsAt: '2031-03-16T02:30:00.000Z', externalRefs: [{ source: 'ra', id: '999999999' }] }),
    baseListing({ source: FAKE, sourceId: 'fake-c', title: 'Basement: Blawan all night', raw: { id: 'c' }, hasTime: true, night: NIGHT, startsAt: '2031-03-16T03:00:00.000Z', venueName: 'Basement', lineup: ['Blawan'] }),
  ];
}

describe('listingParams (offline)', () => {
  it('maps a listing to the 31 upsert_listing() parameters in declaration order', () => {
    const [a] = sample();
    const p = listingParams(a!, 42);
    expect(p).toHaveLength(UPSERT_PARAM_COUNT);
    expect(p.slice(0, 6)).toEqual([FAKE, 'fake-a', null, '{"id":"a"}', 42, 'Mister Saturday Night with Eamon Harkin']);
    expect(p[6]).toBe('2031-03-16T02:00:00.000Z');
    expect(p[8]).toBe(true);
    expect(p[9]).toBe(NIGHT);
    expect(p[10]).toBe('Nowadays');
    expect(p[15]).toEqual(['Eamon Harkin', 'Justin Carter']); // text[] stays a JS array (pg serialises it)
    expect(p[16]).toBe(25);
    // jsonb parameters are pre-stringified so pg does not turn the JS array into a Postgres array literal
    expect(JSON.parse(p[20] as string)).toEqual([
      { tier: 'GA', price: 25, feesIncluded: true, available: true, note: null },
      { tier: 'Door', price: 35, feesIncluded: null, available: null, note: 'cash' },
    ]);
    expect(p[22]).toBe('scheduled');
    expect(p[24]).toEqual(['House']);
    expect(p[29]).toBe('{}');
    expect(p[30]).toBe('[]');
  });
  it('drops non-finite numbers and NUL bytes instead of sending them to Postgres', () => {
    const l = baseListing({ source: FAKE, sourceId: 'x', title: `Bad${String.fromCharCode(0)}Title`, raw: { t: `a${String.fromCharCode(0)}b` }, night: NIGHT, venueLat: Number.NaN, priceMin: Number.POSITIVE_INFINITY });
    const p = listingParams(l, 1);
    expect(p[5]).toBe('BadTitle');
    expect(p[3]).toBe('{"t":"ab"}');
    expect(p[13]).toBeNull();
    expect(p[16]).toBeNull();
  });
  it('rejectReason names rows the schema cannot hold', () => {
    expect(rejectReason(baseListing({ source: FAKE, sourceId: 'x', title: 'T', raw: null, night: NIGHT }))).toBeNull();
    expect(rejectReason(baseListing({ source: FAKE, sourceId: 'x', title: 'T', raw: null }))).toBe('neither night nor startsAt');
    expect(rejectReason(baseListing({ source: FAKE, sourceId: '', title: 'T', raw: null, night: NIGHT }))).toBe('missing sourceId');
    expect(rejectReason(baseListing({ source: FAKE, sourceId: 'x', title: '  ', raw: null, night: NIGHT }))).toBe('missing title');
  });
});

describe('endpoint helpers (offline)', () => {
  const req = (headers: Record<string, string>) => ({ headers }) as unknown as VercelRequest;
  it('isAuthorized: open only in non-production without a secret; otherwise exact bearer match', () => {
    expect(isAuthorized(req({}), {})).toBe(true);
    expect(isAuthorized(req({}), { NODE_ENV: 'production' })).toBe(false);
    expect(isAuthorized(req({ authorization: 'Bearer s3cret' }), { CRON_SECRET: 's3cret' })).toBe(true);
    expect(isAuthorized(req({ authorization: 'bearer s3cret' }), { CRON_SECRET: 's3cret' })).toBe(true);
    expect(isAuthorized(req({ authorization: 'Bearer nope' }), { CRON_SECRET: 's3cret' })).toBe(false);
    expect(isAuthorized(req({}), { CRON_SECRET: 's3cret', NODE_ENV: 'development' })).toBe(false);
    expect(bearerToken(req({ authorization: 'Basic abc' }))).toBeNull();
  });
  it('isCalendarDate rejects well-shaped nonsense', () => {
    expect(isCalendarDate('2026-09-13')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('9/13/2026')).toBe(false);
  });
  it('triggerOf distinguishes Vercel Cron, pg_cron and plain HTTP', () => {
    expect(triggerOf(req({ 'x-vercel-cron-schedule': '17 9 * * *' }))).toBe('vercel_cron');
    expect(triggerOf(req({ 'user-agent': 'vercel-cron/1.0' }))).toBe('vercel_cron');
    expect(triggerOf(req({ 'x-noct-trigger': 'pg_cron' }))).toBe('pg_cron');
    expect(triggerOf(req({ 'user-agent': 'curl/8.0' }))).toBe('http');
  });
  it('describeError prefixes blocks with the vendor', () => {
    const err = new BlockedError(403, 'https://ra.co/graphql', '<title>Just a moment', new Headers(), 'cloudflare');
    expect(describeError(err)).toMatch(/^BLOCKED:cloudflare Blocked by cloudflare \(HTTP 403\)/);
    expect(describeError(new Error('boom'))).toBe('boom');
  });
});

describe.skipIf(!process.env.DATABASE_URL)('runIngest against Postgres', () => {
  async function cleanup(): Promise<void> {
    const ev = await query<{ event_id: string }>('select distinct event_id from listing where source_key = $1 and event_id is not null', [FAKE]);
    await query('delete from listing where source_key = $1', [FAKE]);
    if (ev.rows.length) await query('delete from event where event_id = any($1::uuid[])', [ev.rows.map((r) => r.event_id)]);
    await query('delete from ingest_run where source_key = $1', [FAKE]);
    await query('delete from venue_alias where source_key = $1', [FAKE]);
    await query('delete from venue_external_id where source_key = $1', [FAKE]);
  }
  const run = (adapters: SourceAdapter[], extra: Record<string, unknown> = {}) => runIngest({ adapters, trigger: 'test', log: silent, ...extra });
  const runRow = (runId: number | null) => query('select * from ingest_run where run_id = $1', [runId]).then((r) => r.rows[0]!);

  beforeAll(async () => {
    await query(
      `insert into source (source_key, display_name, kind, priority, fees_included_default, is_ticketer, tos_notes)
       values ($1, 'Fake', 'manual', 10, false, false, 'test double') on conflict (source_key) do nothing`,
      [FAKE],
    );
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await query('delete from source where source_key = $1', [FAKE]);
    await closePool();
  });

  it('stores 3 listings, resolves them into 2 events and records the run', async () => {
    const summary = await run([fakeAdapter(sample())]);
    expect(summary.runs).toHaveLength(1);
    const r = summary.runs[0]!;
    expect(r).toMatchObject({ source: FAKE, status: 'ok', seen: 3, created: 3, changed: 0, resolved: 3, gone: 0 });
    expect(r.runId).toBeTypeOf('number');
    expect(summary.skipped).toEqual([]);

    const row = await runRow(r.runId);
    expect(row).toMatchObject({ status: 'ok', trigger: 'test', listings_seen: 3, listings_new: 3, listings_changed: 0, listings_resolved: 3, window_start: null, window_end: null, error: null });
    expect(row.finished_at).not.toBeNull();

    const listings = await query<{ source_id: string; event_id: string; seen_in_run_id: string; night: Date }>(
      'select source_id, event_id, seen_in_run_id, night from listing where source_key = $1 order by source_id', [FAKE]);
    expect(listings.rows.map((x) => x.source_id)).toEqual(['fake-a', 'fake-b', 'fake-c']);
    expect(listings.rows.every((x) => Number(x.seen_in_run_id) === r.runId)).toBe(true);
    const [a, b, c] = listings.rows;
    expect(a!.event_id).toBe(b!.event_id);
    expect(c!.event_id).not.toBe(a!.event_id);
    expect(new Set(listings.rows.map((x) => x.event_id)).size).toBe(2);

    const prices = await query('select tier, price from listing_price lp join listing l using (listing_id) where l.source_key = $1 and l.source_id = $2 order by tier', [FAKE, 'fake-a']);
    expect(prices.rows.map((p) => p.tier)).toEqual(['Door', 'GA']);
    const ev = await query<{ listing_count: number; lineup: string[] }>('select listing_count, lineup from event where event_id = $1', [a!.event_id]);
    expect(ev.rows[0]).toMatchObject({ listing_count: 2, lineup: ['Eamon Harkin', 'Justin Carter'] });
  });

  it('is idempotent: an identical second run changes nothing', async () => {
    const summary = await run([fakeAdapter(sample())]);
    expect(summary.runs[0]).toMatchObject({ status: 'ok', seen: 3, created: 0, changed: 0, resolved: 0 });
    const n = await query('select count(*)::int as n from listing where source_key = $1', [FAKE]);
    expect(n.rows[0]!.n).toBe(3);
  });

  it('counts a content change without creating a listing', async () => {
    const changed = sample().map((l) => (l.sourceId === 'fake-c' ? { ...l, priceMin: 40, priceMax: 40 } : l));
    const summary = await run([fakeAdapter(changed)]);
    expect(summary.runs[0]).toMatchObject({ status: 'ok', seen: 3, created: 0, changed: 1 });
  });

  it('tombstones a listing missing from two consecutive fully-enumerated runs', async () => {
    const window = { start: NIGHT, end: NIGHT };
    const twoOfThree = sample().filter((l) => l.sourceId !== 'fake-c');
    const first = await run([fakeAdapter(twoOfThree, window)]);
    expect(first.runs[0]).toMatchObject({ status: 'ok', gone: 0 });
    expect(await runRow(first.runs[0]!.runId)).toMatchObject({ window_start: new Date(`${NIGHT}T00:00:00Z`), window_end: new Date(`${NIGHT}T00:00:00Z`) });
    let c = await query('select miss_count, gone_at from listing where source_key = $1 and source_id = $2', [FAKE, 'fake-c']);
    expect(c.rows[0]).toMatchObject({ miss_count: 1, gone_at: null });

    const second = await run([fakeAdapter(twoOfThree, window)]);
    expect(second.runs[0]).toMatchObject({ status: 'ok', gone: 1 });
    c = await query('select miss_count, gone_at, event_id from listing where source_key = $1 and source_id = $2', [FAKE, 'fake-c']);
    expect(c.rows[0]!.gone_at).not.toBeNull();
    const ev = await query('select status, listing_count from event where event_id = $1', [c.rows[0]!.event_id]);
    expect(ev.rows[0]).toMatchObject({ status: 'removed', listing_count: 0 });

    // seen again -> the trigger resurrects it
    const third = await run([fakeAdapter(sample(), window)]);
    expect(third.runs[0]).toMatchObject({ status: 'ok', seen: 3, created: 0 });
    c = await query('select miss_count, gone_at from listing where source_key = $1 and source_id = $2', [FAKE, 'fake-c']);
    expect(c.rows[0]).toMatchObject({ miss_count: 0, gone_at: null });
  });

  it('never honours a window when the fetch was capped or came back empty', async () => {
    const window = { start: NIGHT, end: NIGHT };
    const capped = await run([fakeAdapter(sample().slice(0, 2), window)], { limit: 2 });
    expect(await runRow(capped.runs[0]!.runId)).toMatchObject({ status: 'ok', window_start: null });
    const empty = await run([fakeAdapter([], window)]);
    expect(empty.runs[0]).toMatchObject({ status: 'ok', seen: 0, warnings: 1 });
    expect(await runRow(empty.runs[0]!.runId)).toMatchObject({ window_start: null });
    const c = await query('select miss_count from listing where source_key = $1 and source_id = $2', [FAKE, 'fake-c']);
    expect(c.rows[0]!.miss_count).toBe(0);
  });

  it('records a BlockedError as failed with a BLOCKED: prefix and still runs the next adapter', async () => {
    const blocked = fakeAdapter([], null, {
      fetch: async () => {
        throw new BlockedError(403, 'https://example.test/graphql', '<title>Just a moment...</title>', new Headers(), 'cloudflare');
      },
    });
    const summary = await run([blocked, fakeAdapter(sample())]);
    expect(summary.runs).toHaveLength(2);
    expect(summary.runs[0]).toMatchObject({ status: 'failed', seen: 0 });
    expect(summary.runs[0]!.error).toMatch(/^BLOCKED:cloudflare /);
    expect(summary.runs[1]).toMatchObject({ status: 'ok', seen: 3 });
    const row = await runRow(summary.runs[0]!.runId);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/^BLOCKED:cloudflare /);
    expect(row.finished_at).not.toBeNull();
  });

  it('keeps the good rows of a batch and marks the run partial when one row is refused', async () => {
    const poison = { ...sample()[2]!, sourceId: 'fake-poison', status: 'bogus' as ListingStatus };
    const summary = await run([fakeAdapter([...sample().slice(0, 2), poison])]);
    expect(summary.runs[0]).toMatchObject({ status: 'partial', seen: 2, warnings: 1 });
    const row = await runRow(summary.runs[0]!.runId);
    expect(row.status).toBe('partial');
    expect(row.warnings).toHaveLength(1);
    expect(row.warnings[0]).toMatch(/fake-poison/);
    const n = await query('select count(*)::int as n from listing where source_key = $1 and source_id = $2', [FAKE, 'fake-poison']);
    expect(n.rows[0]!.n).toBe(0);
  });

  it('writes a skipped run row with the reason for disabled adapters and an exhausted budget', async () => {
    const disabled = fakeAdapter(sample(), null, { enabled: () => ({ ok: false, reason: 'FAKE_API_KEY not set' }) });
    const s1 = await run([disabled]);
    expect(s1.skipped).toEqual([{ key: FAKE, reason: 'FAKE_API_KEY not set' }]);
    expect(s1.runs[0]).toMatchObject({ status: 'skipped', error: 'FAKE_API_KEY not set' });
    expect(await runRow(s1.runs[0]!.runId)).toMatchObject({ status: 'skipped', error: 'FAKE_API_KEY not set' });

    const s2 = await run([fakeAdapter(sample())], { env: { ...process.env, NOCT_RUN_BUDGET_MS: '1' } });
    expect(s2.runs[0]).toMatchObject({ status: 'skipped', error: 'time budget' });
  });

  it('refuses to open a second concurrent run for the same source', async () => {
    const inflight = await query<{ run_id: string }>(`insert into ingest_run (source_key, status, trigger) values ($1, 'running', 'test') returning run_id`, [FAKE]);
    const summary = await run([fakeAdapter(sample())]);
    expect(summary.runs[0]).toMatchObject({ status: 'skipped', error: `already running (run ${Number(inflight.rows[0]!.run_id)})` });
    await query('delete from ingest_run where run_id = $1', [inflight.rows[0]!.run_id]);
  });
});
