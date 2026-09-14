# Resident Advisor (`ra`)

Adapter: `src/sources/ra.ts` · kind `api` · priority 90 · fees included by default · no key.

## Access method

RA has no public API, feed or iCal (verified 2026-09-13: `/rss`, `/feed`, `/xml/events.ics` are 404/301,
`/api` and `/developers` are 404). Its web app loads city listings by POSTing the `GET_EVENT_LISTINGS`
GraphQL operation to `https://ra.co/graphql`, and that endpoint answers unauthenticated requests as long as:

- the `User-Agent` looks like a browser (curl/python UAs get a Cloudflare 403 page) — `src/lib/env.ts`
  sends a plain desktop Chrome string, overridable with `NOCT_USER_AGENT`;
- `Content-Type: application/json` is set (otherwise HTTP 400 `BAD_REQUEST`).

No cookie, Referer or Origin is needed. The HTML routes (`/events/...`, `/clubs/...`, `/dj/...`) are behind
DataDome and are never requested. `access-control-allow-origin` is locked to `https://ra.co`, so calls must be
server-side. NOCT uses `postJson` from `src/lib/http.ts` with `minIntervalMs: 1500`, 30 s timeout and the
shared retry/block detection; a challenge page surfaces as `BlockedError` and the run records it. No
circumvention of any kind is attempted.

## Request

```json
{
  "operationName": "GET_EVENT_LISTINGS",
  "variables": {
    "filters": {
      "areas": { "eq": 8 },
      "listingDate": { "gte": "2026-09-13T00:00:00.000Z", "lte": "2026-09-20T23:59:59.999Z" }
    },
    "filterOptions": { "genre": true, "eventType": true },
    "pageSize": 100,
    "page": 1,
    "sort": { "listingDate": { "order": "ASCENDING" }, "score": { "order": "DESCENDING" }, "titleKeyword": { "order": "ASCENDING" } }
  },
  "query": "query GET_EVENT_LISTINGS(...) { eventListings(...) { data { id listingDate event { ... } } totalResults } }"
}
```

- `areas.eq` comes from `NOCT_RA_AREA_ID` (default `8` = New York City, `ianaTimeZone` America/New_York).
- `listingDate` bounds are the inclusive `fromDate`/`toDate` nights from the `FetchContext`.
- `pageSize` is 100 (the server rejects more with `Limit must not be greater than 100`), or `ctx.limit` when
  that is smaller so smoke tests stay cheap. Pages are walked while a page comes back full and fewer rows than
  `totalResults` have been seen; the walk also stops once `ctx.limit` listings are collected, and at a hard
  cap of 100 pages.
- The event selection is: `id title date startTime endTime cost minimumAge isTicketed isFestival
  hasSecretVenue interestedCount contentUrl dateUpdated venue{id name address contentUrl location{latitude
  longitude} area{id name ianaTimeZone}} artists{id name} genres{id name slug} images{filename type}
  promoters{id name} pick{blurb} setTimes{status lineup} tickets(queryType:AVAILABLE){id title priceRetail
  validType onSaleFrom onSaleUntil currency{code}}`.

A 200 response can still carry `errors`. If `data.eventListings` is missing the page is treated as a failure
(the fetch throws with the GraphQL message); if data is present alongside errors the rows are kept and each
message becomes a run warning.

## Field mapping

| NormalizedListing | RA |
| --- | --- |
| `sourceId` | `event.id` |
| `sourceUrl` | `https://ra.co` + `event.contentUrl` (falls back to `/events/{id}`) |
| `raw` | the `event` object as returned |
| `title` | `event.title`, whitespace-collapsed. Status prefixes (`CANCELLED - ...`) are left for `title_status_flag()` in SQL; `status` is always `scheduled` |
| `startsAt` / `endsAt` | `zonedToUtc(startTime / endTime, venue.area.ianaTimeZone ?? America/New_York)` — RA's `LocalDateTime` carries no offset |
| `hasTime` | `startTime` present and parsable |
| `night` | `nightDate(startsAt)` when timed, else `date.slice(0,10)` |
| `venueName` / `venueAddress` / `venueSourceId` | `venue.name` / `venue.address` / `venue.id` (RA club id, stored in `venue_external_id`) |
| `venueLat` / `venueLng` | `venue.location`, except the placeholders `(41,-74)` and `(0,0)` which become null |
| `lineup` | `artists[].name` in RA order (billing strings like `Lucho (1)` are split/cleaned in SQL) |
| `genres` | `genres[].name` (RA's 70-tag vocabulary); slugs go to `sourceTags.ra_genre_slugs` |
| `promoters` | `promoters[].name` |
| `imageUrl` | `images[]` entry of type `FLYERFRONT`, else the first image, else null (`flyerFront` itself is always null) |
| `description` | `pick.blurb` cleaned to plain text (RA Picks only; ~1% of events), else null |
| `interestedCount` | `interestedCount` |
| `ageMin` | `minimumAge` (21 / 18 / null) |
| `prices` | one tier per ticket: `{tier: title, price: priceRetail, feesIncluded: true, available: validType === 'VALID', note: validType}` |
| `priceMin` / `priceMax` | min/max `priceRetail` over VALID tiers; if none are VALID, over all tiers; if there are no tiers, `parseMoneyRange(cost)` |
| `priceNote` | the raw `cost` text (`"$70"`, `"$5-$30"`, `"10.00"`), null when empty |
| `feesIncluded` | `true` when tiers exist (`priceRetail` includes RA's booking fee), else null |
| `soldOut` | `tickets.length > 0 && every validType === 'SOLDOUT'`; null without tiers. `ticketing.isAnyTicketTierAvailable` is not used — it was false for every on-sale event sampled |
| `currency` | first ticket `currency.code`, else `USD` |
| `sourceTags` | `ra_genre_slugs`, `is_festival`, `is_pick`, `set_times_status`, `set_times_lineup` (only when status is `PUBLIC`), `ticketing` (= `isTicketed`), `date_updated`, `secret_venue: true` (only when `hasSecretVenue`) |
| `externalRefs` | none (RA is the source) |

`FetchResult.window` is `{start: fromDate, end: toDate}` when every page was walked, and `null` when
`ctx.limit` cut the walk short (tombstoning must not run on a partial enumeration).

## Quirks seen live

- `venue.location` is `(41,-74)` for several long-standing venues (Brooklyn Army Terminal, Xanadu, Moondog
  Hifi, Gabriela) and `(0,0)` for recently created ones (Green Room NYC, 314 Scholes, feedbk, Animal).
- `cost` is promoter free text and often disagrees with the tiers (`"80-100"` next to a $114.95 final
  release); tiers win.
- A multi-day event appears once per listing day; listings are de-duplicated by `event.id`, keeping the first.
- Boolean listing filters (`isTicketed`, `isSoldOut`) return 0 rows server-side; everything is filtered
  client-side.
- `date`, `startTime`, `endTime` are `LocalDateTime` strings ending in `.000` with no zone.
- The schema is undocumented (850 types, introspection currently open) and can change without notice.

## Terms and robots

RA's Terms of Use (3 April 2025) clause 4.4(a) prohibits using automated systems to extract content or data
for commercial purposes without a written agreement with RA, and 4.4(f) prohibits accessing the website by
means not authorised in writing, including scripts, bots, crawlers and scrapers. `robots.txt` disallows
`/api/`, `/pro/`, `/user/` and `/widget` (not `/graphql`) and names ClaudeBot, anthropic-ai and GPTBot among
disallowed agents. RA does bespoke syndication deals (e.g. the Spotify ticket integration) but has no
self-serve developer programme. Written permission from Resident Advisor Ltd should be sought before this
adapter runs on a schedule or its output is shown commercially; until then treat it as a prototype source.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `NOCT_RA_AREA_ID` | `8` | RA area id to list (8 = New York City) |
| `NOCT_USER_AGENT` | desktop Chrome string in `env.ts` | outbound User-Agent (Cloudflare rejects non-browser UAs) |

## Tests

- `tests/unit/ra.test.ts` — offline, against `tests/fixtures/ra_listings_page.json` (one real page captured
  2026-09-13, pageSize 20, 13–20 Sep, full selection) and `tests/fixtures/ra_listings_minimal.json`
  (degenerate shape). Covers EDT conversion, night assignment, placeholder coordinates, price selection,
  sold-out rule, secret venues, set times, GraphQL error handling and the pager/window logic.
- `tests/live/ra.live.test.ts` — `NOCT_LIVE=1 npx vitest run tests/live/ra.live.test.ts` makes one small
  request (pageSize 5, today..+2) and asserts at least one listing with a start time and venue.
- Smoke run without a database: `npm run fetch -- ra --limit 5 --days 3`.
