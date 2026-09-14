# Venue-direct sources: Elsewhere, Good Room, Public Records

Three Brooklyn venues that publish their own calendars. Each adapter is a plain HTTP read with the shared
`politeFetch` client (configured User-Agent, one request per 2 s per host, bounded retries) and a pure
`parse*` function that the unit tests exercise offline against payloads captured on 2026-09-13
(`tests/fixtures/elsewhere_events_page1.json`, `goodroom_home.html`, `goodroom_feed.xml`, `publicrecords_home.html`).
None needs a key; none is skipped by `enabled()`. Nothing here works around bot management: a block surfaces
as `BlockedError` and the run records it.

```
npm run fetch -- elsewhere --days 14 --limit 5
npm run fetch -- goodroom --days 14
npm run fetch -- publicrecords --days 14
NOCT_LIVE=1 npx vitest run tests/live/venues.live.test.ts   # opt-in network checks
```

| key | kind | priority | fees default | window | time resolution |
| --- | --- | --- | --- | --- | --- |
| `elsewhere` | feed | 70 | included (Eventbrite totals) | yes, when fully paginated | start + end instants |
| `publicrecords` | scrape | 65 | n/a (no prices) | yes, when the page is populated past `toDate` | start clock only |
| `goodroom` | feed | 60 | n/a (no prices) | never | date only (`hasTime=false`) |

## Elsewhere — `src/sources/elsewhere.ts`

**Access.** `https://www.elsewhere.club/events` is a Next.js page; its `<script id="__NEXT_DATA__">` carries the
`buildId` and page 1 of the calendar. Further pages come from
`https://www.elsewhere.club/_next/data/<buildId>/events.json?page=N` (36 events per page, date-ascending,
`pageProps.initialEventData.{events,pageNumber,hasNextPage}`). The buildId rotates on every deploy and a stale id
404s, so it is re-read every run; a 404 mid-run triggers one re-derivation. robots.txt has no Disallow; the JSON
is the site's own page data. Hosted on Vercel, no security checkpoint observed.

**Pagination.** Pages are walked while `hasNextPage` and no event on the page has a night after `toDate`
(the whole page is still scanned — ordering is trusted only for the stop decision). Hard cap of 25 pages.

**Mapping.**
- `sourceId` = `String(id)` (the Eventbrite event id); `externalRefs = [{source: provider ?? 'eventbrite', id}]`;
  `sourceUrl` = `ticket_url`.
- `startsAt` = `start_date`, `endsAt` = `end_date ?? curfew_time` (ISO with offset); `hasTime` true; `night`
  from `nightDate(start)`.
- Rooms → venue names the venue seed aliases into one family: The Hall → `Elsewhere Hall`, Zone One →
  `Elsewhere Zone One`, The Rooftop → `Elsewhere Rooftop`, The Loft → `Elsewhere Loft`, Full Venue / several rooms
  → `Elsewhere`. When `venues[]` names another venue (Good Room, Market Hotel, SILO, 99 Scott, Trans-Pecos,
  Circle Line boat parties) it is kept verbatim with the payload's `address`, so "Elsewhere Presents" shows land
  on the right venue.
- Prices from `tickets[]`: `total/100` per tier, `feesIncluded: true`, note `face value $30.00 + $9.94 fees`.
  Events not yet on sale list no tiers; then `representative_ticket_price/100` is used as face value with
  `feesIncluded: false` and a note. `soldOut` = `sold_out`.
- `ageMin` = `parseAge(age_restriction)` ("21+", "16+"); `genres` = `genres[]` lower-cased (`electronic`,
  `live electronic`, `indie`, `rock`, `pop`, `hip hop / r&b`, ...); `promoters` = `[presented_by]` when set;
  `lineup` = `artists[]`; `description`, `imageUrl` = `image_urls[0]`.
- `sourceTags`: `elsewhere_type` (`club` | `live` — both kept, enrichment decides `is_electronic`), `rooms`,
  `elsewhere_presents`, `highlight`, `presented_by`, `announcement_date`, `sale_start_date`, `provider`.
- `window` = `{fromDate, min(toDate, last night seen)}` when the walk completed (ran past `toDate` or out of
  pages) and no `limit` cut it short; otherwise `null`.

**Quirks.** `presented_by` was null for all 36 fixture events even when `elsewhere_presents` was true.
Titles sometimes carry "*Sold Out*" while `sold_out` is false — the flag is trusted, the title is kept as is.

## Good Room — `src/sources/goodroom.ts`

**Access.** `http://www.goodroombk.com/` (homepage) and `http://www.goodroombk.com/?post_type=events&feed=rss2`
(301 → `/feed/?post_type=events`, still http). **HTTPS is broken on this host** (self-signed, expired
certificate); the adapter uses `http://` as published and never upgrades. WordPress 4.9 on shared hosting: poll
once or twice a day. A feed failure is a warning (homepage-only run); a homepage failure fails the run.

**Homepage markup.** One `<article id="post-<id>" class="… type-events …">` per night:
`.event-day p[title="Friday, September 18, 2026"]` (full date; `.b_date` "9/18" is the fallback, with the year
inferred by `nextMonthDay()` in `src/lib/time.ts` — see Public Records), `.lineup-title` ("Good Room:" / "Bad Room:") followed
by `.lineup .c_lineup` (the room's billing line), `.event-ticket-link a[href]` (RA, DICE partner or Eventbrite
link — sometimes absent), `.post-thumbnail img[src]` (flyer — sometimes absent).

**Feed.** `<item>` gives `title` ("9.26 – Denham Audio"), `link` (permalink), `guid` (`?post_type=events&p=<id>`);
`description`/`content` are empty and `pubDate` is the publish date, not the event date. Only the 10 most
recently published posts appear, so it is joined to articles by post id (then by month/day) and used for
`sourceUrl` and `sourceTags.headliner` / `feed_title` only.

**Mapping.**
- `sourceId` = `sha1('goodroom|post|<post id>')`. The post id is the only key that survives the feed's 10-item
  horizon; `sha1('goodroom|<permalink>')` and `sha1('goodroom|<date>|<normText(title)>')` are fallbacks for
  markup without an id. (The brief suggested permalink-first; that id would change when a post ages out of the
  feed, creating a duplicate listing.)
- `title` = the Good Room line as printed ("FIXED with Mozhgan, JDH & Dave P", "Eli Escobar (all night)").
  The feed's "Headliner" is not used as the title for the same stability reason; it sits in `sourceTags.headliner`.
- `night` = the article date; `hasTime=false`, `startsAt=null`. `venueName` `Good Room`,
  `venueAddress` `98 Meserole Avenue, Brooklyn, NY 11222`.
- `lineup` = billing items from every room line, de-duplicated by `normText`, split on `,` / ` / ` / ` + ` / ` & `.
  Items keep "(all night)" and "A b2b B" — the DB's `parse_lineup_item` splits and strips those. A leading
  "Party: …", "Party with …", "Party ft …" label goes to `sourceTags.series`; "X Presents: …" / "X presents …"
  goes to `promoters`. Filler ("+ more", "NYC", "special guests") is dropped.
- `externalRefs` from the ticket link: `ra.co/events/<id>` → `{ra, id}`; `dice.fm/…/<hash>-<slug>` →
  `{dice, hash}` (the 6-char DICE hash the DICE adapter keys on); `eventbrite.com/e/…-<id>` → `{eventbrite, id}`.
  Organiser subdomains (`otha.eventbrite.com`) carry no event id and yield no ref.
- `sourceTags`: `rooms: [{room, lineup, artists}]`, `series`, `headliner`, `post_id`, `ticket_url`,
  `permalink`, `feed_title`, `date_label`. `imageUrl` = flyer.
- `window` = `null` always: the homepage is upcoming-only but nothing documents how far ahead it lists.

**Quirks.** No prices, ages or times anywhere on the site. `&` almost always separates two DJs on this site's
lines, so it is a split character here (a duo named "A & B" would be split — acceptable at this venue's scale).

## Public Records — `src/sources/publicrecords.ts`

**Access.** `https://publicrecords.nyc/` renders the whole upcoming calendar server-side (WordPress behind nginx,
gzip). No JSON, no REST route for events, no year anywhere. robots.txt allows everything; Wordfence is
installed, so a few polls a day at most. Tickets are DICE short links (`https://link.dice.fm/<code>`), making the
DICE adapter the authority for price, age and lineup; this adapter carries the venue's own rooms, series and
Club/Live/Etc typing and keeps the venue covered when DICE is unavailable.

**Row markup.** `<a class="event table-row" href="https://link.dice.fm/<code>" data-id="<n>">` with
`.table-cell.date` = `Sun 9.13<br>Club, 3:00 pm,<br><span class="location">The Nursery</span>` (several
`span.location` for multi-room club nights; some rows have no room, some have two types "Club, Live", one is
"Festival") and `.table-cell.title` = `The Nursery: Benji B, Nabihah Iqbal [DJ]`.

**Mapping.**
- Year inference: `nextMonthDay(month, day, fromDate)` from `src/lib/time.ts` — the occurrence on/after
  `fromDate - 1 day` (yesterday still counts for a run after midnight), except that a date more than ~300 days
  out is really one that just passed ("12.31" scraped on Jan 2) and stays in the past, where the range filter
  drops it. An impossible `M.D` ("2.30") is rejected with a warning. The printed weekday is checked against the
  inferred date; a mismatch is a warning (`row 591 "…": printed Mon 9.13 but 2026-09-13 is a sun`) — the live
  test asserts there are none.
- `startsAt` = `zonedToUtc(date + clock)` when a clock parses (`hasTime=true`, `night` from `nightDate`);
  otherwise date-only. `endsAt` null.
- `sourceId` = `sha1('publicrecords|<data-id>')` (falls back to the href). `sourceUrl` = the DICE short link;
  `externalRefs = [{source: 'dice_short', id: <code>}]` for the DICE adapter to resolve.
- `title` as printed. `lineup` only for rows typed Club and/or Live (Etc/Festival rows are talks, listening
  sessions and umbrella entries): text after the **last** `": "` (nested "DURATIONS: Ballet: …"), or after
  "X presents" (X → `promoters`), with album/tour subtitles (" – BEAT MUSIC") stripped, `[Live]` → `(live)`,
  other bracketed descriptors (`[DJ]`, `[DJ Set]`, `[Avey Tare and …]`) removed, split on `,` / ` / ` / ` & ` /
  ` + ` / ` with ` / ` ft. `. Items stay as billing lines for the DB splitter.
- `venueName` `Public Records`, `venueAddress` `233 Butler St, Brooklyn, NY 11217`.
- `sourceTags`: `room` ("Sound Room / The Atrium / Upstairs"), `rooms[]`, `pr_type` ("Club", "Live", "Etc",
  "Festival", "Club/Live"), `pr_types[]`, `series`, `site_event_id`, `date_label`, `clock`.
- `window` = `{fromDate, toDate}` only when the page held ≥ 20 rows, its last date is ≥ `toDate`, and no `limit`
  cut listings; otherwise `null`.

**Quirks.** Rooms concatenate without separators in the raw text (`Sound RoomThe AtriumUpstairs`) — read from the
spans, not the text. One row printed "7:00 am" for an evening Live show (a pm typo): a Club/Live row whose clock
falls between 5:00 and 9:59 am is kept date-only (`hasTime=false`, `night` = printed date) with a warning, since
nothing at the venue starts then; Etc rows (an 11 am gong meditation) keep their clock. "Frank & Tony" (a duo) is
split like every other `&` pair.

**Verified against DICE.** The one "7:00 am" row in the fixture (Dent May, Wed 10.28) resolves through its
`link.dice.fm` short link to a DICE event starting `2026-10-28T19:00:00-04:00` — the site's clock is a pm typo,
so the date-only fallback is the right call.

## Open items

- The venue seed (`0006_seed_venues.sql`) already aliases `Elsewhere Hall` / `Elsewhere Zone One` /
  `Elsewhere Rooftop` / `Elsewhere Loft` under the `elsewhere` family and seeds `Good Room` and `Public Records`.
  In a local ingest every listing from the three adapters resolved to a seeded venue except one Elsewhere boat
  party at "Circle Line Sightseeing Cruises - Midtown", which `upsert_listing()` gave a provisional venue
  (`needs_review`) — the intended path for unseeded venues.
- The DICE adapter can resolve `dice_short` refs (`link.dice.fm/<code>`) to DICE hashes so Public Records
  listings merge with their DICE twins by id rather than by title/date similarity.
