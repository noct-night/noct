# Ticketmaster Discovery API v2 (source key `ticketmaster`)

Official, key-gated, self-serve. Covers Ticketmaster / Live Nation / Universe / Front Gate inventory in the New
York DMA — Brooklyn Steel, Terminal 5, Irving Plaza, Gramercy Theatre, Brooklyn Paramount, Kings Theatre,
arena-scale EDM. Underground clubs are not on Ticketmaster; whether TicketWeb-sold rooms (Knockdown Center) are
included is **unverified** (`source` enum in the docs lists ticketmaster, universe, frontgate, tmr — not ticketweb).

| | |
|---|---|
| Adapter | `src/sources/ticketmaster.ts` |
| Kind / priority | `api` / 50 |
| Key | `TICKETMASTER_API_KEY` (consumer key) |
| Fixture | `tests/fixtures/ticketmaster_events_sample.json` — hand-written to the official schema (no key was available to capture live) |
| Tests | `tests/unit/ticketmaster.test.ts` (offline), `tests/live/keyed.live.test.ts` (opt-in) |

## Getting a key

1. Create an account at https://developer.ticketmaster.com and register an app ("My Apps"). The **Consumer Key**
   is the API key; docs: "Upon registration and obtaining your API key, you will be able to access our Discovery
   and Commerce APIs instantly."
2. Put it in `TICKETMASTER_API_KEY`. The adapter is skipped (reason `TICKETMASTER_API_KEY is not set`) without it.
3. Without a key every call is `HTTP 401 {"fault":{"faultstring":"Failed to resolve API Key variable
   request.queryparam.apikey", ...}}` (verified live 2026-09-13).

## Endpoint

```
GET https://app.ticketmaster.com/discovery/v2/events.json
    ?apikey=<TICKETMASTER_API_KEY>
    &dmaId=345                              # New York DMA (NY + NJ + slices of CT/PA)
    &classificationName=Dance%2FElectronic  # Music > Dance/Electronic (genre id KnvZfZ7vAvF)
    &startDateTime=2026-09-13T10:00:00Z     # 06:00 New York on fromDate
    &endDateTime=2026-10-14T09:59:59Z       # 05:59:59 New York the morning after toDate
    &size=200                               # documented max
    &page=0                                 # zero-based
    &sort=date,asc
```

- Date bounds are computed DST-correctly by `tmDateRange()` and enumerate exactly the New York **nights**
  `fromDate..toDate` (a 1 am show the morning after `toDate` belongs to `toDate`). TM rejects fractional seconds,
  so the instants are emitted as `YYYY-MM-DDTHH:mm:ssZ`.
- **Deep paging**: "we only support retrieving the 1000th item, i.e. (size * page < 1000)". With `size=200` that is
  pages 0–4. Page 0 of the full range doubles as a count probe; when `page.totalElements > 1000`, `planWindows()`
  re-queries the range in 7-night windows (`splitDateRange()`, unit-tested). A 7-night window that still exceeds
  1000 is truncated with a warning (never observed for NYC dance listings — a month is a few hundred events).
- `classificationName` is a name match across the taxonomy; the adapter re-checks that the primary segment is
  `Music` and drops anything else (Arts & Theatre > Dance can leak in). `segmentId=KZFzniwnSyZfZ7v7nJ&genreId=KnvZfZ7vAvF`
  is the stricter alternative if leakage is ever observed live.
- `includeTBA`/`includeTBD` are left at their defaults (excluded when a date filter is present).

### Response (fields used)

`_embedded.events[]`: `id`, `name`, `url`, `test`, `info`, `pleaseNote`, `images[]{ratio,url,width,height,fallback}`,
`dates{start{localDate,localTime,dateTime,dateTBD,dateTBA,timeTBA,noSpecificTime}, end{...approximate}, timezone,
status{code}}`, `classifications[]{primary,segment,genre,subGenre}`, `priceRanges[]{type,currency,min,max}`,
`ageRestrictions{legalAgeEnforced,ageRuleDescription}`, `promoter{name}`, `promoters[]`,
`_embedded.venues[]{id,name,city.name,state.stateCode,postalCode,address.line1,location{latitude,longitude},timezone}`,
`_embedded.attractions[]{id,name}`; `page{size,totalElements,totalPages,number}`.

Quirks the adapter relies on:

- `dates.status.code` enum is `onsale | offsale | canceled | postponed | rescheduled` — American spelling; both
  `canceled` and `cancelled` are accepted.
- `dates.start.dateTime` (UTC) is omitted when `timeTBA` / `noSpecificTime`; only `localDate` remains.
- `dates.end` is usually `approximate: true`, so `endsAt` is always null.
- `location.latitude` / `longitude` are strings.
- `priceRanges[].type` is `standard` (face value) or `standard including fees`; there is **no sold-out flag**
  (`offsale` only says sales have ended).
- `ageRestrictions.legalAgeEnforced` is a boolean meaning "21+ enforced"; some events add an `ageRuleDescription`.

### Mapping

| NormalizedListing | from |
|---|---|
| `sourceId` / `sourceUrl` / `title` | `id` / `url` / `name` |
| `startsAt`, `hasTime`, `night` | `dates.start.dateTime` → `hasTime=true`, `night=nightDate(startsAt)`; if absent or `timeTBA` → `startsAt=null`, `hasTime=false`, `night=localDate` |
| `endsAt` | `null` (approximate end times) |
| venue | `venues[0]`: name, id, `line1, city, ST postal`, lat/lng |
| `lineup` | distinct `attractions[].name` |
| `prices` | one tier per `priceRanges` entry: `{tier: type ?? 'standard', price: min, feesIncluded: /including fees/, available: status !== 'offsale', note: 'up to $max'}`; tier names de-duplicated (`listing_price` is unique per tier) |
| `priceMin` / `priceMax` / `currency` | min of tier prices / max of `max ?? min` / first range's currency |
| `feesIncluded` | the tiers' verdict when they agree, else `null` |
| `soldOut` | `null` (not exposed) |
| `status` | `canceled`→`cancelled`, `postponed`, `rescheduled`; `onsale`/`offsale`/missing→`scheduled` |
| `ageMin` | `parseAge(ageRuleDescription)` ?? (`legalAgeEnforced` ? 21 : null) |
| `genres` | distinct `[genre.name, subGenre.name]` of the primary classification, minus `Undefined` |
| `imageUrl` | largest genuine `16_9` image, else largest of any ratio, else fallback art |
| `promoters` | `promoter.name` + `promoters[].name`, distinct |
| `description` | `info` + `pleaseNote` |
| `sourceTags` | `tm_segment, tm_genre, tm_subgenre, tm_status, tm_attraction_ids, tm_local_date, tm_local_time, tm_timezone` |
| `window` | `{start: fromDate, end: toDate}` when every window was fully paged; shrinks to the last fully enumerated window when the request budget runs out; `null` when `--limit` truncated the result |

Dropped (counted in `warnings`): `test: true`, missing id/name, venues whose `stateCode` is not NY/NJ, primary
segment other than Music, events with no `dateTime` and no `localDate` (`dateTBD`/`dateTBA`).

## Quotas and rate limits

"All API keys are issued with a default quota of 5000 API calls per day and rate limitation of 5 requests per
second." Response headers: `Rate-Limit`, `Rate-Limit-Available`, `Rate-Limit-Over`, `Rate-Limit-Reset`.
Over quota → HTTP 429 (`politeFetch` retries twice honouring `Retry-After`, then throws `HttpError`; the run records it).

NOCT: `minIntervalMs = 250` (4 req/s) and a hard cap of **40 requests per run** (`TM_MAX_REQUESTS_PER_RUN`). A
30-night NYC run is normally 1–3 requests; 24 daily runs would be well under 100 calls/day.

## Terms (developer.ticketmaster.com/support/terms-of-use, read 2026-09-13)

Summary of the constraints that matter to NOCT — read the full text before shipping. The 5000/day, 5 req/s quota
is stated on the API docs page, not in the terms.

- **Caching** — you may not "cache or store any Event Content other than for reasonable periods in order to
  provide the service you are providing". NOCT keeps listings only while the event is upcoming and refreshes them
  on every run.
- **Revenue** — you may not "sell, lease, or sublicense the Ticketmaster API or access thereto or derive revenues
  from the use or provision of the Ticketmaster API" without a separate arrangement with Ticketmaster.
- **Rate limiting** — Ticketmaster may "rate limit or block applications that make a large number of calls to the
  API that are not primarily in response to direct user actions". Scheduled ingest is exactly that kind of call,
  so the per-run cap and 250 ms spacing keep the volume trivial.
- **No replica** — the API may not be used to "replicate or attempt to replace the unique essential user
  experience of Ticketmaster.com or the Ticketmaster apps".
- Ticketmaster "may terminate the license at any time for any reason" and may restrict access without notice.
- The terms page itself does not spell out link/attribution or branding rules; check the developer portal's
  brand guidelines before showing the Ticketmaster name or logo. NOCT links to the event `url` as returned.

## NOCT's stance

Enabled whenever `TICKETMASTER_API_KEY` is set — the terms are compatible with a free, non-commercial listings
prototype. Revisit the revenue clause before any monetisation. Prices are face value (`feesIncludedDefault=false`),
so cross-source price comparisons must account for that.

## Running it

```
TICKETMASTER_API_KEY=... npm run fetch -- ticketmaster --days 14
NOCT_LIVE=1 TICKETMASTER_API_KEY=... npx vitest run tests/live/keyed.live.test.ts
```
