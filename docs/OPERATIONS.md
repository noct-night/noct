# NOCT operations

How ingestion is scheduled, how to run it by hand, what to look at when something is off, and the
knobs that exist. Everything below assumes the schema in `supabase/migrations/` is applied.

## Cities

`NOCT_CITIES` (default `nyc`) lists the cities each ingest run covers; the RA adapter walks one RA area per
city (`src/lib/cities.ts` has the ids, verified live 2026-09-14). Every listing/event/venue carries `city` and
`tz`; nights are computed in the event's own zone (`night_date(ts, tz)`), venue resolution is city-scoped
(LA's "Basement" never merges with Queens' BASEMENT), and `/api/feed?city=la` returns that city's nights with
local clocks. Adding a city: add a row to `src/lib/cities.ts` and to `0011_cities.sql`, put the key in
`NOCT_CITIES`, run `/api/ingest/ra`. Volume guide (RA, 30 nights): NYC ≈ 600, LA ≈ 340, SF ≈ 260, London ≈ 1,900,
Berlin ≈ 1,400 — London + Berlin together roughly triple the ingest time and storage.

## Moving parts

| Piece | Where | What it does |
| --- | --- | --- |
| `runIngest()` | `src/ingest/run.ts` | For each adapter: open an `ingest_run` row, `fetch()`, `upsert_listing()` in batches of 50, `resolve_pending()`, close the row, `tombstone_sweep()` when the fetch enumerated a full date window. |
| `/api/ingest/<source>` and `/api/ingest/all` | `api/ingest/` | Vercel functions (300 s) that call `runIngest()`. Bearer `CRON_SECRET`. |
| `/api/health` | `api/_lib/routes/health.ts` via `api/read/[fn].ts` | Public read-only status: last run per source, live listing counts, events for the next 7 nights, review queue. |
| `noct_call(path)` + `noct-*` jobs | `supabase/migrations/0008_cron.sql` | pg_cron on Supabase POSTs to the Vercel routes through pg_net every few hours. |
| Vercel Cron | `vercel.json` | Daily fallback (`/api/ingest/all` 09:17 UTC, `/api/enrich` 09:47 UTC). Hobby plan allows once a day. |

Every invocation, scheduled or manual, leaves one `ingest_run` row per adapter with one of:

- `ok` — fetched, stored, resolved.
- `partial` — some listings were refused by Postgres (their ids are in `warnings`); nothing was tombstoned.
- `failed` — the adapter threw. `error` starts with `BLOCKED:<vendor>` when a bot-management challenge was
  returned (NOCT records the block and stops; it never tries to get around one), `TIMEOUT:` when the
  source exceeded its budget, `abandoned:` when the process died mid-run (Vercel timeout, Ctrl-C).
- `skipped` — not attempted; `error` says why: a missing key, `time budget`, or
  `already running (run N)` when another process holds the source (pg_cron and Vercel Cron both firing).

## First deploy: wire pg_cron to Vercel

`0008_cron.sql` installs the jobs on Supabase but they call nothing until two rows exist in `app_setting`.
After the first `vercel deploy --prod`, in the Supabase SQL editor (as `postgres`):

```sql
insert into app_setting (key, value) values
  ('vercel_base_url', 'https://<your-project>.vercel.app'),   -- no trailing slash, no path
  ('cron_secret',     '<the CRON_SECRET you set in Vercel>')
on conflict (key) do update set value = excluded.value, updated_at = now();

-- smoke test: fires one POST and returns the pg_net request id
select noct_call('/api/ingest/ra?limit=5');
-- a few seconds later
select id, status_code, error_msg, left(content::text, 200) from net._http_response order by created desc limit 5;
```

`app_setting` has RLS enabled and no policies, so only the service role / `postgres` can read the secret.
pg_net waits at most 8 s for a response; the ingest keeps running on Vercel after that, so a
`timeout` in `net._http_response` is normal for a full RA run — check `ingest_run` instead.

Schedules installed (UTC):

| job | schedule | calls |
| --- | --- | --- |
| `noct-ingest-ra` | `17 */3 * * *` | `/api/ingest/ra` |
| `noct-ingest-dice` | `29 */6 * * *` | `/api/ingest/dice` |
| `noct-ingest-venues-elsewhere` / `-goodroom` / `-publicrecords` | `5 9`, `12 9`, `19 9 * * *` | one venue feed each |
| `noct-ingest-keyed-ticketmaster` / `-edmtrain` | `33 10`, `41 10 * * *` | keyed APIs (skipped when the key is unset) |
| `noct-enrich` | `40 * * * *` | `POST /api/enrich?limit=60` |

Re-applying the migration replaces every `noct-*` job. To pause everything:
`select cron.unschedule(jobid) from cron.job where jobname like 'noct-%';`

Vercel Cron stays configured as the safety net: if pg_cron is off or unconfigured, `/api/ingest/all`
still runs once a day. When both fire at 09:17 UTC the runner's per-source lock lets one proceed and
records the other as `skipped: already running`.

## Running by hand

```bash
# local Postgres with every migration
bash scripts/db-local.sh noct
export DATABASE_URL=postgresql://localhost:5432/noct

npm run fetch -- ra --limit 5              # adapter only, no database
npm run ingest -- ra                       # one source, next 30 nights
npm run ingest -- ra --days 2 --limit 30   # smoke run (a --limit run never tombstones)
npm run ingest -- all                      # every enabled adapter
npm run enrich -- --limit 20
```

Against a deployment (same routes pg_cron uses):

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" "https://<app>/api/ingest/ra?limit=20" | jq .
curl -s -H "Authorization: Bearer $CRON_SECRET" -X POST "https://<app>/api/ingest/all"
curl -s "https://<app>/api/health" | jq .attention
```

Query parameters: `from`, `to` (YYYY-MM-DD, New York nights; default today .. +30) and `limit`.
Per-source failures come back inside the 200 JSON (`runs[].status`, `runs[].error`); a 500 means the
runner itself could not start (usually `DATABASE_URL`). Locally (`vercel dev`, no `CRON_SECRET`) the
routes are open; with `NODE_ENV=production` and no secret they fail closed.

## Monitoring queries

Last run per source (what `/api/health` shows):

```sql
select distinct on (source_key) source_key, status, trigger, started_at, finished_at - started_at as took,
       listings_seen, listings_new, listings_changed, listings_resolved, cardinality(warnings) as warnings, error
from ingest_run order by source_key, started_at desc;
```

Blocked or failing sources in the last day:

```sql
select source_key, started_at, status, error from ingest_run
where started_at > now() - interval '1 day' and status = 'failed' order by started_at desc;
-- blocked only
select source_key, max(started_at) last_blocked, count(*) from ingest_run
where error like 'BLOCKED:%' and started_at > now() - interval '7 days' group by 1;
```

Listings that never resolved into an event (should be zero after each run; non-zero means
`resolve_pending` was paused by the time budget or is erroring):

```sql
select source_key, count(*) from listing where event_id is null and gone_at is null group by 1;
select listing_id, source_key, title, night, venue_name_raw from listing
where event_id is null and gone_at is null order by night limit 50;
```

Match review queue (grey-zone scores 0.55–0.78 that were not auto-merged):

```sql
select mc.listing_id, l.source_key, l.title as listing_title, e.title as event_title, l.night, mc.score,
       mc.features->>'venue' venue, mc.features->>'title' title_sim, mc.features->>'lineup' lineup_sim
from match_candidate mc join listing l using (listing_id) join event e using (event_id)
where mc.decision = 'pending' order by mc.score desc, mc.created_at limit 50;
-- accept one:
-- update listing set event_id = '<event_id>', match_method = 'manual', match_score = 1, matched_at = now() where listing_id = <id>;
-- update match_candidate set decision = 'human_merged', decided_at = now() where listing_id = <id> and event_id = '<event_id>';
-- select refresh_event('<event_id>');
```

Tombstones and resurrections (a burst of `gone_at` right after a site redesign means the adapter broke,
not that the events vanished):

```sql
select source_key, date_trunc('hour', gone_at) hour, count(*) from listing
where gone_at > now() - interval '2 days' group by 1, 2 order by 2 desc;
```

pg_cron / pg_net on Supabase:

```sql
select jobid, jobname, schedule, active from cron.job where jobname like 'noct-%';
select jobname, status, start_time, return_message from cron.job_run_details d join cron.job using (jobid)
where jobname like 'noct-%' order by start_time desc limit 20;
select id, created, status_code, error_msg from net._http_response order by created desc limit 20;
```

## Environment variables

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | everything | On Vercel: the Supavisor *transaction* pooler (port 6543). The runner never relies on session state or prepared statements. |
| `CRON_SECRET` | `/api/ingest/*` | Vercel Cron sends it automatically; `noct_call()` reads the copy in `app_setting`. Rotate both together. |
| `NOCT_SOURCES` | runner | Comma list of adapters for `all`; default is every adapter, disabled ones are recorded as `skipped`. |
| `NOCT_RUN_BUDGET_MS` | runner | Whole-invocation budget, default `270000` (Vercel's 300 s minus headroom). Adapters that would start with < 30 s left are `skipped: time budget`. |
| `NOCT_SOURCE_TIMEOUT_MS` | runner | Per-adapter fetch abort, default `240000`, passed as `ctx.signal`. |
| `NOCT_USER_AGENT` | http | Outbound UA. A header only — no challenge solving, proxies or rotation. |
| `NOCT_RA_AREA_ID`, `DICE_API_KEY`, `TICKETMASTER_API_KEY`, `EDMTRAIN_CLIENT_KEY` | adapters | See `.env.example`; a missing key makes that adapter `skipped`. |
| `ANTHROPIC_API_KEY`, `NOCT_ENRICH_MODEL` | enrichment | Not used by ingestion. |

## Time budgets, in order

1. Vercel kills the function at 300 s (`vercel.json`, `maxDuration`).
2. `NOCT_RUN_BUDGET_MS` (270 s) is the runner's own deadline: no adapter starts with < 30 s left, and
   `resolve_pending()` runs in chunks of 200 so it can stop between chunks (the run records a warning and the
   rest resolves next time).
3. `NOCT_SOURCE_TIMEOUT_MS` (240 s) or the remaining budget minus 20 s, whichever is smaller, aborts one
   adapter's fetch through `ctx.signal`.
4. `politeFetch` applies 20 s per request, bounded retries, and one request per second per host.
5. pg_net waits 8 s for the HTTP response and moves on; the function keeps running.

`ingest_run` rows still `running` after 15 minutes are marked `failed: abandoned` at the start of the next
run, and a `running` row younger than that blocks a second run of the same source.

## What the runner deliberately does not do

- It does not tombstone from a capped (`limit`) or empty fetch, even if the adapter reported a window: an
  empty page from a redesigned site must not remove a whole source. Two consecutive complete runs without a
  listing are required before `gone_at` is set (`tombstone_sweep`, `miss_count >= 2`).
- It does not retry a blocked host or change how it identifies itself. A `BLOCKED:` run is information for
  a human (`docs/DATA_SOURCES.md`), not a signal to try harder.
- It does not run adapters in parallel: one connection pool of four, short transactions, one source at a
  time keeps the pooler and the source hosts calm.
