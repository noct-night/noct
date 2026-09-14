# DICE

Adapter: `src/sources/dice.ts` (`key: 'dice'`, kind `api`, priority 80, prices all-in).
Research: `dice_research.md` in the session scratchpad (not in the repo; verified live 2026-09-13). Fixture: `tests/fixtures/dice_events_v2.json`.

## Access and governance

DICE has no public developer programme. Three things exist:

| Path | What it is | NOCT's position |
| --- | --- | --- |
| `partners-endpoint.dice.fm/api/v2/events` + `x-api-key` | The Events API behind DICE's embeddable widgets. Per-partner keys. | **The only endpoint this adapter calls.** |
| The frontend key embedded in every dice.fm page (`EVENTS_API_KEY`) | DICE's own web key. Undocumented, rotates with deploys. | **In use as of 2026-09-14** via `DICE_FRONTEND_KEY`, an owner decision (below). The owner copies it from the page; NOCT never scrapes dice.fm to harvest it and never hardcodes it. |
| `partners-endpoint.dice.fm/graphql` (MIO token) | Partner "Ticket Holders" API, scoped to that partner's own events, exposes fan PII. | Not useful for an aggregator; not called. |
| dice.fm HTML / `events-api.dice.fm` | Cloudflare Bot Management; `links.next` in API responses points here. | **Never requested.** The adapter builds every page URL itself against the partner host. |

Terms: DICE US Terms of Use (10 March 2026). §4.2 grants a personal, non-commercial licence; §4.3(c) forbids
circumventing access controls; §8.4 forbids automated crawling of "our website, App or Services" and commercial
exploitation of their content. A scheduled fetcher is only defensible with DICE's consent, which is what an
issued key represents. Nothing here is legal advice — `docs/DATA_SOURCES.md` has the owner decision.

### Owner decision, 2026-09-14

The owner chose to run this adapter on the **frontend key** while a DICE-issued key is pursued, having been
told that §8.4 does not permit a scheduled aggregator to use it. What that means in practice, and the limits
kept anyway:

- The key goes in `DICE_FRONTEND_KEY`, read by the owner from the page (below) — the code never fetches
  dice.fm HTML to harvest it, never stores it in the repo, and prefers `DICE_API_KEY` whenever one exists.
- Only `partners-endpoint.dice.fm` is called: the host DICE's own widget is configured to use, a plain AWS
  ELB. `links.next` (→ the Cloudflare-fronted `events-api.dice.fm`) is never followed, dice.fm HTML is never
  requested, and a challenge response ends the run via `BlockedError` rather than being worked around.
- Every listing keeps its `dice.fm/event/...` link, so purchase always happens on DICE.
- This is reversible: clear `DICE_FRONTEND_KEY` and the adapter reports disabled again.

### Getting the key

**Issued key (the durable path — still worth doing):**

1. Email **help@dice.fm** (the contact named in the Terms, §8.6) describing NOCT: a New York club-night
   aggregator that links every listing back to dice.fm for purchase, wants read access to the public NYC
   events feed via the widget/partner Events API, and will honour any rate or attribution conditions.
2. In parallel, use the partner pages: https://dice.fm/partners and https://dice.fm/partners/ticketing.
   Venues and promoters get their widget key from **MIO** (https://mio.dice.fm), so a friendly venue partner
   can also introduce NOCT to their DICE account manager.
3. Put it in `DICE_API_KEY`; it takes precedence automatically.

**Frontend key (what runs today):** open https://dice.fm, View Source, search `EVENTS_API_KEY = '…'` and copy
the quoted value into `DICE_FRONTEND_KEY`. (Equivalently: DevTools → Network → an events request → request
header `x-api-key`.) It rotates with dice.fm deploys, so refresh it when DICE starts returning 401/403.

With neither set, `dice.enabled()` returns `{ ok: false, reason: KEY_MISSING }`, the registry skips the
adapter, and `dice.fetch()` throws without touching the network. A rejected key is reported as
`DICE rejected the key (HTTP 401); refresh DICE_API_KEY / DICE_FRONTEND_KEY`. A bot-management challenge (not
expected on this host — it is a plain AWS ELB, not Cloudflare) surfaces as `BlockedError` and is recorded;
NOCT does not try to get past it.

## Request

```
GET https://partners-endpoint.dice.fm/api/v2/events
    ?page[size]=100
    &filter[cities][]=New York
    &filter[cities][]=Brooklyn
    &filter[flags][]=going_ahead
    &page[number]=N
x-api-key: $DICE_API_KEY
```

- Brackets are URL-encoded by `URLSearchParams` (`page%5Bsize%5D=100`, `filter%5Bcities%5D%5B%5D=New+York`).
- "New York" and "Brooklyn" are **separate** DICE cities; both are requested.
- Pagination: `page[number]` is incremented while a page returns exactly 100 events. `links.next` is ignored
  (wrong host). Two guards: a page whose event ids are identical to the previous page's means `page[number]` was
  ignored (stop, warn, no window); 30 pages is a hard cap (stop, warn, no window). Single repeated events across
  a page boundary are normal (new events shift pages mid-walk) and are deduped by `hash`.
- There is **no date-range filter**. Results are date-ascending and already exclude past events, so the
  adapter walks from page 1 and stops as soon as a page's last event starts after `toDate` — but only while
  every page so far has been non-decreasing in `date`; if ordering ever breaks it walks to the end instead.
- Politeness: `minIntervalMs: 1000` (one request per second to the host), default timeout and retries from
  `lib/http.ts`. No rate limit is advertised and none was observed.
- `filter[flags][]=going_ahead` means cancelled/postponed events simply disappear from the feed; the
  tombstone sweep handles that. The `status` mapping from flags is kept for the rare `rescheduled` event.

## Selection (all three must hold)

1. **New York**: `location.state === 'New York'` **or** `location.lat/lng` inside lat 40.49–40.92,
   lng -74.27 – -73.68. The city filter occasionally leaks (a Giza festival showed up under "New York");
   the box also keeps Jersey City / LIC-style venues whose state is not literally "New York".
2. **Window**: `date_end` (or `date`) ≥ `fromDate` 00:00 New York and `date` < `toDate` + 1 day 00:00 New
   York. A season pass that started months ago passes while it is running (`sourceTags.is_multi_days_event`).
3. **Club night**: `type_tags` contains `music:dj` or `music:party`, or any `genre_tags` entry starts with
   `dj:` / `party:`. Gigs, playback, comedy, theatre, talks, etc. are dropped and reported as
   `dropped N non-club events (gigs, culture)`. Out-of-New-York drops get their own warning.

Checks run in that order, so the non-club count only covers New York events inside the window.

## Field mapping

| NormalizedListing | DICE |
| --- | --- |
| `sourceId` | `hash` (6 chars, e.g. `dkm38e`), falling back to `id` (Mongo ObjectId) |
| `sourceUrl` | `https://dice.fm/event/{hash}-{perm_name}`; `https://dice.fm/event/{id}` when there is no hash |
| `raw` | the event minus `spotify_tracks`, `apple_music_tracks`, `images` (`event_images` kept) |
| `title` | `name` (whitespace collapsed) |
| `startsAt` / `endsAt` | `date` / `date_end` — already UTC ISO; `hasTime: true`; `night` = NY nightlife date of `date` |
| `venueName` | `venues[0].name`, else `venue` |
| `venueSourceId` | `String(venues[0].id)` |
| `venueAddress`, `venueLat`, `venueLng` | `address`, `location.lat`, `location.lng` |
| `lineup` | `detailed_artists` names, headliners first (stable), else `artists` strings |
| `prices[]` | one tier per `ticket_types[]`: `tier = name`, `price = price.total / 100`, `feesIncluded: true`, `available: !sold_out`, `note = 'face $X + $Y fees'` |
| `priceMin` / `priceMax` | over tiers still on sale; over all tiers when everything is sold out |
| `currency` | `currency` (USD) |
| `soldOut` | event-level `sold_out` |
| `status` | `flags`: `cancelled` → cancelled, `postponed` → postponed, `rescheduled` → rescheduled, else scheduled |
| `ageMin` | `parseAge(age_limit)` ("This is a 21+ event." → 21) |
| `genres` | distinct `genre_tags` suffixes, lower-cased, `_`/`-` → space, DICE's separator-less compounds split (`afrohouse` → `afro house`, `deephouse`, `melodictechno`, `progressivehouse`, `hiphop`); `dj:dj` dropped; then `tags` `genre:*` suffixes the same way |
| `promoters` | `promoters[].name` |
| `description` | `description` (cleaned); `raw_description` kept in `sourceTags` |
| `imageUrl` | `event_images.landscape`, else `.square` |
| `externalRefs` | `[]` |
| `sourceTags` | `dice_id`, `int_id`, `status` (on-sale/off-sale), `checksum`, `dice_type_tags`, `dice_genre_tags`, `dice_tags`, `dice_flags`, `presented_by`, `lineup_times` (`lineup[]` with door/set times), `bundles` (series names), `is_multi_days_event`, `raw_description` |

Genre notes for enrichment: `genres[]` carries the spaced form (`tech house`), while
`sourceTags.dice_genre_tags` keeps the raw `dj:tech-house` strings, so the crosswalk (`genre.dice_tags`)
can match on either. `type_tags` is a vibe signal (`music:dj` vs `music:party`), `lineup_times[0]` is
usually `{details: 'Doors open', time: '3:00 PM'}`, and `bundles` names series like `CLUB at PR` or
`Home by midnight`.

## Result

- `window = { start: fromDate, end: toDate }` when the walk reached the last page (or safely stopped past
  the window); `null` when `limit` truncated it, the page cap hit, or pagination stalled.
- Warnings: non-club drops, out-of-New-York drops, undated drops, pagination stall/cap.

## Tests

```
npx vitest run tests/unit/dice.test.ts                      # offline, on the captured fixture + mocked fetch
NOCT_LIVE=1 DICE_API_KEY=... npx vitest run tests/live/dice.live.test.ts
DICE_API_KEY=... npm run fetch -- dice --limit 5             # CLI dry run, no database
```

## Open questions

- Whether DICE will issue a key to an aggregator at all; the widget programme proves per-partner keys exist.
- Actual rate limits on the partner host (none advertised; 12 requests in 15 minutes were fine in research).
- Whether the authenticated call succeeds from Vercel / GitHub Actions egress (only an unauthenticated 401,
  not a block, was confirmed from a datacenter IP).
- Other NYC-area DICE cities (Queens, Jersey City) — none found; the bounding box is the safety net.
