# Data sources — access methods, legal posture, decisions

Everything below was verified live on 2026-09-13 (see per-source notes in `docs/sources/`). NOCT's core
feature — one deduplicated NYC feed across ticketing platforms — depends on sources whose terms range from
"official API, go ahead" to "automated access not permitted without a written agreement". This file records
what each source allows, how NOCT touches it, and the decisions taken. **Nothing here is legal advice.** The
open items at the bottom need a decision (and probably a lawyer) before public launch.

## Ground rules baked into the code

- Plain HTTP only (`src/lib/http.ts`): one configurable User-Agent, ≥1 s spacing per host, bounded retries.
- **No circumvention.** No CAPTCHA/JS-challenge solving, proxies, IP rotation, headless browsers, or
  origin-host hopping. When a host answers with a bot-management page the adapter throws `BlockedError`,
  the run is recorded as `BLOCKED:<vendor>` in `ingest_run`, and nothing else happens.
- **No borrowed credentials.** Keys come only from environment variables issued to NOCT. The research
  found DICE's own web key embedded in dice.fm pages; NOCT deliberately does not use it.
- Every listing keeps `source_url` and is rendered with a link back to the platform (“Open on RA/DICE/…”).
  Ticket purchase always happens on the platform.

## Source matrix

| Source | Method | Key | Coverage (NYC, verified) | Genre data | Terms — the short version | NOCT default |
|---|---|---|---|---|---|---|
| **Resident Advisor** | `POST https://ra.co/graphql` (the endpoint ra.co's own web app uses; undocumented) | none | ~600–900 upcoming NYC listings; the richest record (times, tiers, sold-out, artists, promoters, images, RA genres) | 70-tag RA taxonomy on ~70 % of events | Terms of Use §4.4(a): no automated extraction for commercial purposes without a written agreement; §4.4(f): no bots/scrapers unless authorised in writing. robots.txt disallows `/api/` (not `/graphql`). HTML pages sit behind DataDome — NOCT never touches them. | **ON** (owner accepted the risk in the prototype; written-permission request to RA recommended — see below) |
| **DICE** | `GET https://partners-endpoint.dice.fm/api/v2/events` with `x-api-key` | `DICE_API_KEY` (issued) **or** `DICE_FRONTEND_KEY` (DICE's public page key) | 342 listings on the first run; totals incl. fees, per-tier sold-out, `genre_tags`, `type_tags` (dj / party / gig) | good (`genre_tags`, `type_tags`) | US Terms §8.4: no automated crawling, personal non-commercial licence. Partner keys exist (widget program). | **ON since 2026-09-14 on the frontend key** — an owner decision taken against §8.4 (see below); an issued key is still being pursued |
| **EDMTrain** | `GET https://edmtrain.com/api/events?locationIds=70&client=KEY` (official API) | `EDMTRAIN_CLIENT_KEY` + `NOCT_EDMTRAIN_ACCEPT_TERMS=1` | 691 upcoming NYC events, 166 venues, but date-only, no prices/tickets/images | none in the API (binary electronic flag) | API Terms: “You may not use our API in … an event discovery service that combines our events with other event sources.” Also: show the `link` unmodified, cache < 24 h, don't store past events. | **OFF** — this clause describes NOCT. Apply honestly (`multipleEventSourcesInd = yes`) or leave it off |
| **Ticketmaster Discovery** | official REST API, `dmaId=345`, `classificationName=Dance/Electronic` | `TICKETMASTER_API_KEY` (self-serve, free) | Live Nation rooms (Brooklyn Steel, Terminal 5, Brooklyn Paramount, arenas); underground clubs are not on TM | segment/genre/subGenre classifications | 5 000 calls/day, 5 rps; no caching “other than for reasonable periods”; no revenue from the API without permission | **ON once a key is set** |
| **Elsewhere** (venue) | the venue site's own Next.js page data (`/_next/data/<buildId>/events.json`) | none | complete for Elsewhere's rooms + Elsewhere-presented shows at other venues | coarse (`Electronic`, `Live Electronic`…) | robots.txt permissive; no published API terms; first-party data | **ON** |
| **Good Room** (venue) | WordPress RSS + homepage HTML over plain HTTP (their TLS cert is self-signed/expired) | none | complete for Good Room + Bad Room; tickets mostly on RA | none | none published | **ON** |
| **Public Records** (venue) | homepage HTML (`a.event.table-row`) | none | complete (~85 rows: club + live), rooms, DICE short links | none (`Club`/`Live` type) | robots.txt allows; Wordfence installed — stay slow | **ON** |
| **19hz.info** (LA, SF, Chicago, Miami, DC, Detroit, Toronto…) | one regional HTML list per enabled city (`eventlisting_<Region>.php`), read once a day | none | LA: ~630 upcoming rows; in a 7-night test 64 of 131 LA events were 19hz-only (not on RA) | good (comma-separated genre tags per row) | volunteer-run community site; no API, feed or terms page; robots.txt absent — stay at one request per region per day | **ON for LA** (no New York list) |
| **SILO Brooklyn** (venue) | the venue site's own Next.js page data (`__NEXT_DATA__.pageProps.events`) — its DICE calendar server-rendered | none | complete for SILO (34 upcoming): all-in prices per tier, sold-out, genre/type tags, exact times | good (DICE `genre_tags`) | first-party page, one GET a day; ticket links to dice.fm | **ON** |
| Nowadays, Paragon, Bossa Nova, Knockdown Center | no first-party calendar (Nowadays/Paragon/Bossa link to RA; Knockdown's site is behind a Vercel challenge) | — | covered via RA (+DICE) | — | — | via RA |
| Eventbrite API v3 | public event search was removed in 2020; organizer/venue-scoped reads may still work | private token | Elsewhere (all on EB), Avant Gardner organizer, promoter parties at DROM/Monarch/… | category/subcategory + organizer tags | API terms: future events only, link back, no competing product; ToS §13.1 forbids scraping pages | not built yet — candidate #8 |
| Shotgun, Posh, Partiful, Tixr, Venuepilot, See Tickets, Bandsintown, Songkick, 19hz | blocked (Vercel/DataDome challenges), partner-only, artist-only, paid licence, or no NYC page | — | — | — | — | not viable now |
| Instagram | no legitimate bulk read of promoters' posts (Business Discovery is per-account, app-reviewed) | — | — | — | Meta terms | human-in-the-loop only |

## Deployment reality check

- `ra.co/graphql` answered a datacenter-origin GET with 200 during research; `partners-endpoint.dice.fm` is
  a plain AWS ELB; venue sites are ordinary hosts. **Verify from the real runtime**: the first thing to do
  after `vercel deploy` is hit `/api/ingest/ra?limit=5` and check `ingest_run.error` for `BLOCKED:`.
- Vercel Hobby crons run once a day; the hourly/3-hourly cadence comes from Supabase `pg_cron → pg_net →
  /api/ingest/<source>` (migration `0008_cron.sql`, see `docs/OPERATIONS.md`). Hobby is also
  non-commercial-only — a launched NOCT needs Vercel Pro (and Supabase Pro to avoid the 7-day pause).

## Decisions taken in this build

1. RA is the canonical record (priority 90) — it is the only source with times, tiers and genres for the
   underground rooms. Sold-out is derived from ticket tiers (`every validType == SOLDOUT`), never from
   `isAnyTicketTierAvailable` (verified broken).
2. DICE is an enrichment/price source keyed by a DICE-issued key; without the key the adapter is skipped
   and the sources screen says why.
3. EDMTrain is implemented but off by default because of the competition clause; it adds no genre or ticket
   data anyway.
4. Venue-direct feeds (Elsewhere, Good Room, Public Records) are on: first-party, cheap, and they cover
   residencies EDMTrain misses.
5. Genre never comes from EDMTrain/19hz/Spotify/Last.fm (unavailable, deprecated, or non-commercial). It
   comes from RA tags, DICE tags, venue/promoter priors and the LLM reconciliation step
   (`docs/GENRE_VIBE.md`), with Discogs (CC0) artist styles as the next addition.

## Cities (2026-09-14)

Resident Advisor is the only source that covers every city; the registry (`src/lib/cities.ts`) holds the RA
area ids verified live: New York 8, Los Angeles 23, San Francisco 218, Chicago 17, Miami 38, Washington DC 22,
Detroit 19, Toronto 28, London 13, Berlin 34. 19hz.info has community lists for LA, Bay Area, Chicago, Miami,
DC, Detroit, Toronto (and more) — a second source for those cities once an adapter exists. New York and Los
Angeles are ingested in production.

## Checked 2026-09-14 and not (yet) built

- **19hz.info for New York** — no list (`eventlisting_NYC.php` → 404); the adapter above runs for the other cities. Its per-region `pastEvents_*.csv` files are a free labelled genre corpus (title/lineup → tags) worth using as an eval set for the classifier.
- **Venue sites with structured events** (JSON-LD `MusicEvent`): Warsaw (24), Brooklyn Paramount (25) — Live Nation rooms selling on Ticketmaster; the Ticketmaster Discovery API covers them with genre classifications and prices once a key exists, so a JSON-LD scraper adds little.
- **Venues RA does not list (0 events in 30 nights):** House of Yes (DICE + Shotgun), Pacha New York (DICE), Nebula / Musica / Marquee / Lavo / Somewhere Nowhere (commercial EDM; ticketing behind Tixr/DataDome or bottle-service systems), Brooklyn Monarch / Purgatory / Sultan Room (Eventbrite), Baby's All Right / Union Pool / Our Wicked Lady (indie live rooms; Squarespace pages embed widgets, no collection JSON). The first two are the strongest argument for a DICE-issued key; the Eventbrite group needs an Eventbrite token (organizer/venue-scoped reads).
- **Posh (posh.vip)** — event pages carry inline state but no JSON-LD or documented API; RA already lists most promoter parties that also live on Posh. Revisit if a partnership appears.
- **Shotgun, Tixr, AXS, Knockdown Center's site** — bot challenges (Vercel checkpoint / DataDome / Cloudflare); NOCT does not work around them.

## Open items for the owner

- **Ask RA in writing.** Terms §4.4(a) explicitly contemplates “a written agreement with us”. RA has done
  bespoke syndication before (Spotify, 2020). Route: pro.ra.co “ticketing partnership” form / ra.co/contact.
- **DICE runs on the frontend key since 2026-09-14** — the owner's decision, recorded in `docs/sources/dice.md`,
  taken knowing §8.4 does not permit a scheduled aggregator to use it. Two follow-ups: **ask help@dice.fm for an
  issued key** (drop it in `DICE_API_KEY` and it takes precedence automatically), and expect the frontend key to
  rotate with dice.fm deploys — a run failing with `DICE rejected the key (HTTP 401)` means refresh it. Reversible
  at any time by clearing `DICE_FRONTEND_KEY`.
- **EDMTrain:** apply truthfully or drop. Do not scrape edmtrain.com.
- **Ticketmaster + Eventbrite keys** are self-serve; both need a NOCT account (owner action).
- **Plan upgrades before launch:** Vercel Pro (commercial use, per-minute crons, 800 s functions) and
  Supabase Pro (no inactivity pause). Estimated < $50/month at current volume.
