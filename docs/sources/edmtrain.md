# EDMTrain (source key `edmtrain`)

Official Event Search API, client-key gated. **Off by default in NOCT** — see *Terms* below.

| | |
|---|---|
| Adapter | `src/sources/edmtrain.ts` |
| Kind / priority | `api` / 40 (lowest: date-only, no prices, no images) |
| Key | `EDMTRAIN_CLIENT_KEY` |
| Extra gate | `NOCT_EDMTRAIN_ACCEPT_TERMS=1` |
| Fixture | `tests/fixtures/edmtrain_docs_sample.json` (official docs response example) |
| Tests | `tests/unit/edmtrain.test.ts` (offline), `tests/live/keyed.live.test.ts` (opt-in) |

## Getting a key

1. Read https://edmtrain.com/api-terms-of-use (summarised below) and https://edmtrain.com/api-documentation.
2. Apply on https://edmtrain.com/developer-api. EDM Train LLC assigns a client key by hand; there is no self-serve
   signup and they are "under no obligation to enter into this Agreement".
3. Put the key in `EDMTRAIN_CLIENT_KEY`. Do **not** set `NOCT_EDMTRAIN_ACCEPT_TERMS` until the competition clause
   has been resolved in writing (see *NOCT's stance*).

## Endpoint

```
GET https://edmtrain.com/api/events
    ?locationIds=70            # 70 = New York City (38 = New York state)
    &startDate=YYYY-MM-DD      # inclusive local date; the API never returns past events
    &endDate=YYYY-MM-DD        # inclusive
    &livestreamInd=false       # livestreams have no NYC room
    &client=<EDMTRAIN_CLIENT_KEY>
```

One request per run — there is no pagination; the whole date range comes back in one `data[]`.

Other documented parameters (unused): `eventName`, `artistIds`, `venueIds`, `eventIds`, `createdStartDate`,
`createdEndDate`, `festivalInd`, `includeElectronicGenreInd` (default true), `includeOtherGenreInd` (default
false — "other genre" shows are excluded server-side; NOCT leaves this default and keeps whatever comes back,
enrichment decides). Sibling endpoints: `/api/locations` (ids), nearby search by lat/lng/state.

### Response

```json
{ "data": [ { "id": 50839, "link": "https://edmtrain.com/new-york/ill-gates-kj-sawka-50839", "name": null,
              "ages": "All Ages", "festivalInd": false, "livestreamInd": false, "electronicGenreInd": true,
              "otherGenreInd": false, "date": "2017-01-14", "startTime": null, "endTime": null,
              "createdDate": "2016-12-08T18:39:58Z",
              "venue": { "id": 543, "name": "Westcott Theater", "location": "Syracuse, NY",
                         "address": "524 Westcott St, Syracuse, NY 13210, USA", "state": "New York",
                         "country": "United States", "latitude": 43.041, "longitude": -76.12 },
              "artistList": [ { "id": 660, "name": "ill.Gates", "link": "...", "b2bInd": false }, ... ] } ],
  "success": true }
```

Quirks the adapter relies on:

- `name` is null unless the event has no artists (festivals, branded parties). Title = `name`, else the lineup.
- `b2bInd: true` = "back to back with the **next** artist in the list"; chains can be any length and the same
  artist may appear in several chains. `[A(b2b), B, C]` becomes billing lines `A b2b B`, `C`.
- `startTime` / `endTime` exist only for livestreams. Physical events are **date-only**: `hasTime=false`,
  `night = date`, `startsAt = null`.
- No prices, ticket links, images or genres. `electronicGenreInd` / `otherGenreInd` / `festivalInd` /
  `createdDate` / `ages` / artist ids are kept in `sourceTags`.
- `latitude` / `longitude` carry 2–3 decimals (hundreds of metres) — fine for a borough, not for a pin.
- Errors: HTTP 200 with `{"data":[],"message":"Invalid client","success":false}` for a bad key (verified live
  2026-09-13); the adapter throws `EDMTrain API error: Invalid client`. A request with no `client` at all is an
  HTTP 400 HTML page (surfaces as `HttpError`).

### Mapping

| NormalizedListing | from |
|---|---|
| `sourceId` | `String(id)` |
| `sourceUrl` | `link`, byte-for-byte (terms: Attribution) |
| `title` | `name` ?? billing lines joined with `, ` ?? `Event at <venue>` |
| `lineup` | billing lines with b2b grouping |
| `hasTime` / `night` / `startsAt` | `false` / `date` / `null` |
| `venueName/SourceId/Address/Lat/Lng` | `venue.name`, `String(venue.id)`, `venue.address ?? venue.location`, lat, lng |
| `ageMin` | `parseAge(ages)` → `21+`→21, `All Ages`→0, null→unknown |
| `genres`, `prices`, `soldOut` | `[]`, `[]`, `null` (not provided) |
| `status` | always `scheduled` (no status field) |
| `sourceTags` | `festivalInd, electronicGenreInd, otherGenreInd, createdDate, ages, artist_ids` |
| `window` | `{start: fromDate, end: toDate}`; `null` when `--limit` truncated the result |

Dropped (counted in `warnings`): livestreams, `venue.state !== 'New York'`, events without a `YYYY-MM-DD` date.

## Quotas

Not published. "We may limit the number of API requests your Application can make in a given period ... You may
not make any attempt to circumvent these limits." NOCT makes one request per run through `politeFetch`
(1 req/s per host, bounded retries, no circumvention of anything).

## Terms (API Terms of Use, fetched 2026-09-13)

- **Competition.** "You may not use our API in an application or service that competes with our Application,
  such as an event discovery service that combines our events with other event sources."
- **Attribution.** "For each event displayed, you must provide your users with the event link from our API's
  response, unmodified." Brand must be written "Edmtrain" / "edmtrain" / "EDMTRAIN" (not "EDMTrain", not
  "EDM Train") wherever it is shown to users.
- **Timeliness.** Cached data "should not be older than 24 hours old when it is displayed", and "any of our Data
  for events that are no longer in the future should not be stored."
- **No crawling or scraping** outside the API; no selling or leasing access to the data; the key must not be
  shared; either party may terminate without notice, after which the data must be removed.
- Governed by New Jersey law.

## NOCT's stance

NOCT is, by its own description, an event discovery service that combines many sources. That is the exact
example the competition clause gives, so **the adapter is disabled by default** even when a key is present:
`enabled()` requires both `EDMTRAIN_CLIENT_KEY` and `NOCT_EDMTRAIN_ACCEPT_TERMS=1`, and its reason string names
whichever is missing. Setting the acknowledgement flag is a statement by the operator that a written arrangement
with EDM Train LLC exists.

If it is ever switched on, the remaining obligations fall outside the adapter and must be honoured elsewhere:

- **24-hour freshness** — the ingest schedule for this source must run at least daily and the UI must not show
  `edmtrain` listings whose `last_seen_at` is older than 24 h.
- **No past events** — `edmtrain` listings must be purged (not just tombstoned) once their night has passed.
- **Unmodified link** — `sourceUrl` is stored verbatim; the UI must link to it as-is (no UTM parameters, no
  redirector) and must not present the event page in an iframe.
- **Brand spelling** — the `source.display_name` row and adapter `displayName` currently read "EDMTrain"; if the
  source is shown to users, that label must change to "Edmtrain".

Both variables are documented in `.env.example`; the acknowledgement line there carries the same warning.

## Running it

```
EDMTRAIN_CLIENT_KEY=... NOCT_EDMTRAIN_ACCEPT_TERMS=1 npm run fetch -- edmtrain --days 14
NOCT_LIVE=1 EDMTRAIN_CLIENT_KEY=... NOCT_EDMTRAIN_ACCEPT_TERMS=1 npx vitest run tests/live/keyed.live.test.ts
```

`npm run fetch` runs the adapter even when `enabled()` says no (dry run) but still needs the key to make the call.
