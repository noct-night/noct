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

## One night, one card (0028)

The cross-platform layer is the merge: nine adapters, scored entity resolution (`score_listing_event()`), a
priority-based canonical record (`refresh_event()`). Three seams still showed one night as two cards on
2026-09-15 and were closed in `0028_cross_source_dedup.sql`:

- **A placeholder venue kept an identical night apart.** RA files a night at "TBA" while 19hz or DICE name the
  room; the venue term for a placeholder is 0.4, so an exact title on the same night stalled at 0.73, under the
  0.78 auto threshold. Now exact title + same night + one side a placeholder clears it (`features.placeholder`
  on the candidate row says so).
- **A short venue name never found the long one.** `resolve_venue()`'s trigram branch only measured how well the
  existing name's words appear in the incoming one, so "El Rey" spawned a provisional row beside "El Rey
  Theatre". Both directions count now (the reverse only for names of six characters or more).
- **Nothing ever moved a listing after the fact.** `rematch_listing(listing_id)` re-resolves one live listing
  against every event but its own and moves it when a better match clears the threshold; an event left with no
  live listing is marked `merged_into` the survivor — the first honest use of the column — and its `going`,
  `saved` and `rec_feedback` rows travel with it. `merge_venue(from, into)` folds a venue **under** another as a
  room of its family (the row stays, so its unmerged nights read "Radius · Cermak Hall"), repoints its names and
  external ids, moves and rematches its listings. Two merges were seeded from the data's own evidence: Cermak
  Hall → Radius (RA files "Indo Warehouse at Cermak Hall" under Radius, 640 W Cermak Rd) and El Rey → El Rey
  Theatre. Undo: clear the room's `parent_venue_id`, drop the alias, rematch its listings.

**Counting the layer honestly.** `platform_host(source_key, url)` names the ticketing platform behind a listing
by URL host — DICE's listing and SILO's dice.fm link are one platform, a 19hz row is whatever it links to (RA,
Ticketmaster, Posh, Flite…). `/api/health` reports `coverage[]` per city: upcoming nights (30) and how many are
listed on two or more hosts. Baseline 2026-09-16 by host: Chicago 19%, Los Angeles 12%, New York 14% (by
adapter it read 34 / 27 / 14, which double-counted 19hz's RA links). The event sheet's "N ways in" collapses
ticket offers the same way (`collapseOffersByHost()`), so it counts places to buy, not places NOCT read. No
card names a platform — commit 859a524 stands.

What the layer does *not* include yet, and why: Shotgun's only API is organizer-scoped (a token per promoter);
Posh and Partiful forbid scraping and publish no API; Instagram's Graph API reads only accounts that authorise
the app. Those are partnership conversations, not adapters. Eventbrite (organizer/venue-scoped reads with an
owner token) and a newsletter inbox (a NOCT address subscribed to venue mailing lists, parsed by the enrich
chain) are the two buildable next sources.

## Open items for the owner

- **Ask RA in writing.** Terms §4.4(a) explicitly contemplates “a written agreement with us”. RA has done
  bespoke syndication before (Spotify, 2020). Route: pro.ra.co “ticketing partnership” form / ra.co/contact.
- **DICE runs on the frontend key since 2026-09-14** — the owner's decision, recorded in `docs/sources/dice.md`,
  taken knowing §8.4 does not permit a scheduled aggregator to use it. Two follow-ups: **ask help@dice.fm for an
  issued key** (drop it in `DICE_API_KEY` and it takes precedence automatically), and expect the frontend key to
  rotate with dice.fm deploys — a run failing with `DICE rejected the key (HTTP 401)` means refresh it. Reversible
  at any time by clearing `DICE_FRONTEND_KEY`.
- **DICE previews are played in-page since 2026-09-15** — the owner's decision. The partner payload carries
  Spotify / Apple Music tracks attached to the listing (by the promoter or by DICE; the payload does not say
  which) with the platforms' own 30-second `preview_url`; `event_feed.track` surfaces one per event (DICE's
  listing before SILO's copy of the same payload, Spotify before Apple Music) and the event sheet plays it
  through a plain `<audio>`, never autoplaying, with the track title and the platform named and linked back
  (`open.spotify.com` / `music.apple.com`). That text-only credit is the conservative reading of what the
  platforms ask of their own integrations (Spotify's developer policy wants its marks plus a link; Apple its
  badge and "provided courtesy of Apple Music"); whether those terms bind a clip that reaches NOCT through
  DICE's partner payload (DICE's client id is on the URL) is **unconfirmed** — a question for the DICE key
  conversation. NOCT hosts nothing, cuts nothing, and picks no timestamp. Spotify stopped issuing preview URLs
  to new apps on 2024-11-27, so these exist only because DICE holds them; if DICE stops sending them, the row
  disappears on the next ingest. Only the platforms' own hosts are allowed through, and the URLs are emitted in
  normalised form (`shapeTrack()` in `src/feed/shape.ts`, `cleanTrack()` in `app.js`). Reversible by dropping
  the two fields from `raw` again in `src/sources/dice.ts`.
- **Representative tracks come from Apple's iTunes Search API since 2026-09-16** (`src/enrich/artist_tracks.ts`,
  `0029_artist_track.sql`). For every artist on an upcoming night NOCT searches the name once, keeps the top song
  only when Apple's artist name equals ours with accents folded and the genre is not one no DJ is filed under,
  and stores the URLs — never the audio. Apple's published terms (performance-partners.apple.com/search-api):
  no key; "approximately 20 calls per minute"; cache the search results (hits and misses are kept 60 days);
  previews "streamed only, and not downloaded, saved, cached"; shown as promotion next to a link to the track
  on Apple Music; credited "courtesy of" Apple. The event sheet streams from `audio-ssl.itunes.apple.com` and
  links *Play full (Apple Music)* to `music.apple.com` beside every clip. **The visible "Previews courtesy of
  Apple Music" line was removed on 2026-09-16 at the owner's request** — the platform name in the link beside
  each clip is what remains of the attribution; Apple's wording asks for the courtesy line, so this is an open
  item if Apple ever objects (one CSS/JS line to restore, `lineupSection()`). About half of the names match (probe 2026-09-16: 6 of 14; first 135 lookups: 69). The daily
  `/api/enrich` cron looks up what the classifier's time budget leaves (a few dozen a day); the backlog is
  `npm run noct -- tracks`. The night's own DICE track (0024) still takes precedence for the artist it names.
- **EDMTrain:** apply truthfully or drop. Do not scrape edmtrain.com.
- **Ticketmaster + Eventbrite keys** are self-serve; both need a NOCT account (owner action).
- **Plan upgrades before launch:** Vercel Pro (commercial use, per-minute crons, 800 s functions) and
  Supabase Pro (no inactivity pause). Estimated < $50/month at current volume.

## Chicago (live 2026-09-15)

Enabled by adding `chi` to `NOCT_CITIES` — no code change. Both adapters already knew the city from
`src/lib/cities.ts` (`raAreaId: 17`, `hzRegion: 'CHI'`).

| source | listings | note |
| --- | --- | --- |
| 19hz `CHI` | 197 | 320 rows on the page; the wide net, but a text table, so no artwork and thin genres |
| RA area 17 | 117 | genres and flyers |

**239 canonical events, 76 of them merged across both sources** — a clean test of entity resolution on a city
with no seeded venues, where every venue is provisional. smartbar, Radius, Podlasie Club, Spybar and Chop Shop
all resolved correctly, and each city keeps its own "TBA" venue rather than sharing one.

Genre coverage is **66%** against NYC's 92%: 19hz-only events arrive without labels, and RA's Chicago tags are
thinner than its New York ones. The LLM chain lifts these over time.

Artwork is **48%**, against 94% in New York — New York has DICE and four venue calendars supplying images,
and Chicago has neither. (RA's CDN 403s a bare `curl` on User-Agent, which looks alarming and is not: any
browser gets a 200. Check image problems in a browser, not with curl.) The fix for Chicago is a source that
carries flyers; DICE is the obvious one, and its adapter is still hardcoded to New York.

## A price from a source that cannot sell you one

`event_offer` is ticketing sources only (`source.is_ticketer`), which is right — 19hz is a community listing
board and a "buy here" link would be a lie. But `event_feed.cheapest_price` read **only** from `event_offer`,
so a 19hz price was thrown away along with the offer. Outside New York 19hz is the dominant source, and the
cost was blunt: **495 priced 19hz listings produced 0 offers**, and 96 of Chicago's 250 upcoming nights showed
no price at all while their own listing knew it.

`0019` makes `cheapest_price` fall back to the cheapest live listing price from any source. `event_offer` is
untouched, so the Tickets section still lists only places that can sell you a ticket; the shaped event gains
`from`, and the client's price label uses it when no offer carries a number.

| city | price coverage before | after |
| --- | --- | --- |
| Chicago | 41.2% | **79.6%** |
| Los Angeles | 45.8% | **94.5%** |
| New York | 86.3% | 89.1% |

Verified on the boundary: "Unreal Chicago" now reads **$18** in the list, while its Tickets section shows only
its two Resident Advisor ways in, with no price attached.
