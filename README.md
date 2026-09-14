# NOCT

One feed for New York nightlife. NOCT pulls club nights, raves and day parties from every platform that
lists them — Resident Advisor, DICE, venue calendars, Ticketmaster (and EDMTrain if licensed) — dedupes
them into one event per night per room, shows every ticket price side by side, and tags each night with a
genre and a vibe.

**NOCT is a working name.** Nothing is attached to it yet.

## What's in this repo

```
index.html                  the app (mobile-first, 440px). Loads /api/feed; falls back to the sample weekend
api/                        Vercel Functions
  feed.ts                   GET /api/feed?from&to → events/venues/days in the shape the UI expects
  ingest/[source].ts        GET|POST /api/ingest/ra|dice|elsewhere|…|all  (Bearer CRON_SECRET)
  enrich.ts                 POST /api/enrich  — genre/vibe pass over new/changed events
  health.ts                 GET /api/health — last run per source
src/
  sources/                  one adapter per source (RA, DICE, Elsewhere, Good Room, Public Records, SILO, Ticketmaster, EDMTrain): fetch + normalise, no DB
  ingest/                   runner: adapter → upsert_listing() → resolve_pending() → tombstone_sweep()
  enrich/                   taxonomy, crosswalk, rules engine, Claude reconciler
  feed/                     read model → UI shape
  lib/                      http (polite fetch, block detection), time (NY ⇄ UTC), normalize, db
supabase/migrations/        Postgres schema: listings, events, venues/aliases, resolution SQL, enrichment,
                            app tables, views + RLS, pg_cron schedules
tests/                      vitest — unit tests on real captured payloads; DB tests; opt-in live tests
docs/                       DATA_SOURCES.md (terms + decisions), OPERATIONS.md, GENRE_VIBE.md, sources/*.md
```

## How it works

1. **Ingest.** Each adapter fetches its source for the next 30 nights and emits `NormalizedListing`
   rows. The runner upserts them (`upsert_listing`, keyed by `(source, source_id)`), tracks first/last
   seen, content changes and disappearances (tombstones), and stores every price tier.
2. **Resolve.** `resolve_listing()` links each listing to a canonical `event`: hard cross-references
   first (a venue page linking a DICE id), then venue family + nightlife date + trigram title + lineup
   overlap. Grey-zone matches land in `match_candidate` for review; canonical fields are recomputed from
   the highest-priority live listing (`refresh_event`).
3. **Enrich.** Deterministic rules (time → day party / afters, price → free/RSVP, venue → warehouse /
   rooftop / phone-free) plus source genre tags feed a Claude call with a controlled taxonomy and
   structured output. Every tag keeps its provenance and confidence (`event_tag`).
4. **Serve.** `/api/feed` reads `event_feed` (RLS-guarded view) and returns the weekend in the UI's
   shape, cached at the edge for five minutes.

## Run it locally

```bash
npm install
cp .env.example .env            # fill DATABASE_URL (local Postgres is fine) and optional keys
bash scripts/db-local.sh noct   # creates the DB and applies every migration
npm run fetch -- ra --limit 5   # dry-run one adapter (no DB)
DATABASE_URL=postgresql://localhost:5432/noct npm run ingest -- ra elsewhere publicrecords goodroom
DATABASE_URL=postgresql://localhost:5432/noct npm run enrich -- --limit 20   # rules-only unless an LLM key is set (docs/GENRE_VIBE.md → Provider options)
npm test                        # unit + DB tests (DB tests skip without DATABASE_URL); NOCT_LIVE=1 adds live tests
npx vercel dev                  # serves index.html + /api/*
```

## Deploy

1. **Supabase**: create a project, `supabase link --project-ref <ref>`, `supabase db push`. Copy the
   Supavisor *transaction* pooler URL (IPv4, port 6543) into `DATABASE_URL`.
2. **Vercel**: `vercel link`, set env vars from `.env.example` (`DATABASE_URL`, `CRON_SECRET`, keys),
   `vercel deploy --prod`. `vercel.json` registers the daily fallback crons (Hobby limit).
3. **Schedules**: insert `vercel_base_url` and `cron_secret` into `app_setting` so `pg_cron` can call
   `/api/ingest/*` every few hours (`docs/OPERATIONS.md`).
4. Hit `/api/ingest/ra?limit=5` once and read `/api/health`. If a source shows `BLOCKED:`, that host
   rejects datacenter traffic — see `docs/DATA_SOURCES.md`; NOCT does not work around blocks.

## Sources, terms and what is deliberately not done

Read `docs/DATA_SOURCES.md`. Short version: RA's GraphQL endpoint is the canonical record (their terms
restrict automated commercial extraction — ask for written permission), DICE runs only with a key DICE
issues to you, EDMTrain is off unless licensed, venue feeds are on, Ticketmaster is on with a free key.
NOCT never solves bot challenges, proxies, or borrows credentials found on other sites.

## Status (2026-09-14)

Verified locally end to end on PostgreSQL 14: one fresh apply of all eight migrations, 250 tests
(`npm test`, DB-backed ones included), a real ingest of RA + Elsewhere + Public Records + Good Room for
the next 7 nights (≈230 listings → ≈210 events, 15 cross-source merges, 12 grey-zone matches queued for
review), a rules-only enrichment pass, and `/api/feed` JSON for a Friday–Sunday range. Not yet exercised:
a real Vercel deployment, `pg_cron` on Supabase, the live Claude call (needs `ANTHROPIC_API_KEY`), DICE /
Ticketmaster / EDMTrain with real keys.

## Known issues / not yet built

- Sign-in, going and saved are still client-side only; the tables and RLS exist (`0005_app.sql`) but the
  UI is not wired to Supabase Auth (Instagram is not a Supabase provider — see `docs/FRONTEND.md`).
- Rules-only genre labels are capped at 0.5 confidence and can be wrong for non-club shows (a noise band
  can inherit a venue's house prior); the Claude step and the `not_electronic` flag are what fix that.
- Images come from the source flyer where one exists; otherwise the CSS textures remain.
- Artist-level genre evidence (Discogs/MusicBrainz) is designed (`docs/GENRE_VIBE.md`) but not implemented.
- Provisional venues created from unknown labels need a periodic human pass (`venue.needs_review`).
- Cities: New York and Los Angeles ingested by default from RA (`NOCT_CITIES`); San Francisco, Chicago, Miami, DC, Detroit, Toronto, London, Berlin are registered (`src/lib/cities.ts`) and switch on by adding them to `NOCT_CITIES`. Venue-direct feeds and the venue seed are New York only, so other cities rely on RA (+ 19hz where it has a list).

## Feedback

Open an issue, or leave comments on the relevant line.
