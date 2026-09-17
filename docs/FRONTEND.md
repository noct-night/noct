# Frontend: how index.html talks to the backend

`index.html` is the prototype UI, unchanged in look and behaviour. What changed is where its data comes from:
the constants at the top of the script (`DAYS`, `EV`, `VENUES`, `GENRES`, `PLATS`, `AREAS`, `PRESETS`,
`SOURCES`) are now **fallback sample data**; `loadFeed()` at the bottom of the script fetches `/api/feed` and
replaces them, then calls `buildAll(); setView(S.view)` so every existing render path keeps working.

## Loading rules

| Situation | What happens |
|---|---|
| Served by Vercel (`npx vercel dev` or production) | `GET /api/feed?from=<NY today>&to=<NY today+2>` on the same origin; the response replaces the constants. |
| Opened from `file://`, `localhost` or `127.0.0.1` (UI work) | Same fetch against the production API (`LIVE_API` = https://noct-navy.vercel.app, which sends `Access-Control-Allow-Origin: *` on `/api/feed`). No backend, keys or database needed to work on the UI with real data. |
| `?api=https://other-host` | Overrides the API origin (e.g. a preview deployment). |
| `?demo=1` in the URL | No fetch; the embedded sample weekend renders exactly as before. |
| `?from=YYYY-MM-DD&to=YYYY-MM-DD` in the URL | Passed through to the API on the first load only (max 31 nights). |
| A **When** pick (preset or calendar night) | Re-requests the feed for that window; the loaded window *is* the selection (`S.from = 0`, `S.to = DAYS.length - 1`). |
| Fetch fails (network, 4xx/5xx, malformed JSON) | Sample weekend stays; a small note under the controls reads *Live data unavailable — showing sample weekend*. |
| Fetch succeeds with zero events | Live (empty) data is shown — the UI says "Nothing here". The sample is never mixed with live data. |

`from`/`to` default to the New York calendar date computed in the browser with `Intl.DateTimeFormat('en-CA', {timeZone: 'America/New_York'})`;
the server applies the same default when the parameters are missing.

## The When tab

Two controls, both in `#dateSheet`:

- **Presets** — Tonight / Tomorrow / This weekend. `rangeOf(key)` computes the window in New York's
  calendar (Mon–Thu "this weekend" jumps to the coming Friday; on a Sunday it collapses to tonight) and
  `pickRange()` reloads the feed for it. The default load follows the active preset, so a city switch re-asks
  for the same window in the new city's own calendar.
- **Month calendar** — `renderCal()` draws a 7-column grid for `S.calMonth`: past nights and nights with no
  events are disabled, today carries `aria-current="date"`, the selected night is underlined, and each cell
  shows its event count. ‹ › move months; the back arrow stops at the current month.
  Tapping a night calls `pickDate()`, which **keeps the sheet open** and renders that night's cards under the
  grid (`renderCalList()`, the same `.row` markup as the list view). Tapping one of those cards runs
  `openFromCal(i)` — closes the sheet and opens that event in the image view at index `i`. The sheet has no
  "Show results" button: the calendar itself is the result.

Counts come from `GET /api/feed?counts=1&from&to&city`, which returns one integer per night (~3 KB for a
month) instead of the ~320 KB a month of full event records costs. They are cached per month+city in
`S.counts`, so reopening the sheet is free. `MAX_COUNTS_DAYS` (62) lets a six-week grid through where full
feeds stop at `MAX_RANGE_DAYS` (31).

## The API

`GET /api/feed` — public, read-only. `api/feed.ts` → `src/feed/query.ts` (`buildFeed`) → `src/feed/shape.ts`.

Query parameters: `from`, `to` (YYYY-MM-DD, inclusive New York nights; default today..today+2; at most 31 nights),
`area` (borough name or `All`), `city` (only New York; anything else is a 400), `all=1` (include events the
classifier marked `is_electronic = false`, hidden by default). Bad parameters return `400 {error}`; a database
failure returns `500 {error: "feed unavailable"}`; both with `cache-control: no-store`.

Successful responses carry `cache-control: public, s-maxage=300, stale-while-revalidate=900` and
`vercel-cdn-cache-control: s-maxage=300`, so the edge answers most requests and Postgres sees at most one query
per five minutes per distinct URL.

Response shape (see `FeedResponse` in `src/feed/shape.ts` for the full typing):

```
{
  generated_at, range: {from, to},
  days:    [{date, dow, label:'Fri', sub:'Sep 26', hint:'Tonight'|'Tomorrow'|'Sunday'}],
  venues:  { "<family name>": {addr, hood, boro, ig, site, ra, dice, verified, lat, lng} },
  events:  [{
    id (event uuid), n (1-based position), d (index into days),
    head, lineup[], venue (family name, e.g. "Avant Gardner"), room ("The Great Hall" | null),
    door 'HH:mm' | '', close, age '21+' | 'All ages' | '',
    genre[] (taxonomy labels when enriched, else raw source labels), gsrc ('NOCT tags' | 'RA tags' | ...),
    primary, genre_codes[], tags [{code,label}], genre_confidence,
    vibes [{code,label,glyph,kind}], scalars {energy, darkness, crowd_size, start_lateness, end_lateness, price_tier, underground_index},
    sound, interested, srcs [[platform_name, price|null, note, url]] (available first, cheapest first),
    platforms[], ra, dice, eb, url, tex 'x1'..'x6', full, soldout, note, status, image, going_count, needs_review, is_electronic
  }],
  genres:  [distinct labels for the filter sheet],
  sources: [{key, name, last_run: {status, finished_at, seen, error} | null}]
}
```

`soldout` is the ticketers' own verdict: true only when every live ticketing listing that states `sold_out` says
so; when no listing has an opinion it falls back to "every offer is unavailable". RA marks expired tiers
`NOLONGERONSALE` while door sales may remain, so such tiers read *No longer on sale* in `srcs` (RA's raw
`VALID` / `SOLDOUT` / `NOLONGERONSALE` / `NOTYETONSALE` tokens are humanised there; other sources' notes pass
through verbatim) and do not by themselves make the event "Sold out".

`track` (0024) is the track on the live DICE (or SILO) listing — `{platform: 'spotify'|'apple', title, url,
preview}` — or null. `preview` is the platform's own 30-second clip; both URLs are admitted only from the
platforms' own hosts and emitted WHATWG-normalised with no userinfo (`shapeTrack()`).

`artist_tracks` (0029) is one representative track per artist on the bill — `[{artist, platform: 'apple', title,
url, preview}]` — from the iTunes Search API, joined in `EVENTS_COLUMNS_SQL` (no view change) and validated by
the same `shapeTrack()`; `artist` is the artist's name as `lineup` spells it.

The event sheet shows people in a **Line-up** section (`lineupSection()`), after the specs table: one row per
name, the whole row a tap to the artist sheet, the right edge reading *Set →* (what that sheet answers: the
searches for their sets, their other nights), the first row marked *Headliner* when there are several (billing
order is all any source gives). Under each artist, a track row when there is one: the night's own DICE track for
the artist it names (`trackWho()`: a line-up name inside the track title, else the only name on the bill), else
that artist's representative track; a night-track nobody can be named for closes the list. The song is one
line — the artist's name dropped from the front (*Me veo volar*, not *Coco Maria - Me veo volar*), the
catalogue's decorations dropped too (`tidyTitle()`: *(feat. …)*, *[… Remix]*, *(Radio Edit)*, *- Extended Mix*;
the full title stays as the tooltip), truncated before it wraps — and its two controls sit together on the next
line: *Play 30 s* (→ *Stop* / *Unavailable*) on one shared `<audio>` keyed per row (`SHEET_TRACKS`; starting one
stops another; never autoplay; a Stop before the clip starts is not a failure; stops when the sheet closes or
another night opens) and *Play full (Apple Music | Spotify)* to the whole track. The platform name in that link
is the only credit on the sheet: the *Previews courtesy of Apple Music* line was removed on 2026-09-16 by the
owner's decision (see docs/DATA_SOURCES.md). The platform is named on purpose —
the credit the platforms ask of their own integrations — and this is not the "no source names" decision,
which is about listings. See docs/DATA_SOURCES.md for what is and is not confirmed about the terms.

`GET /api/night?e=<uuid>[&radius_km=4][&limit=3]` → `{generated_at, radius_km, main, next[]}`: the event and up to
three other rooms nearby that stay open later (`src/feed/night.ts`: different venue family, same city, this night
or the next, scheduled, electronic non-class, timed, located, not sold out, close ≥ 2 h after this one's close,
start ≤ 3 h after it, listed ≤ 12 h, within the radius; one row per room, nearest first). `next` is empty when
the main is not scheduled, has no close time or coordinate, or is listed for more than 24 h (a weekend pass has
no close to anchor on). `next[]` rows are ordinary event shapes plus `night`, `lat`, `lng`, `km` (straight-line,
one decimal — for consumers; the UI does not print it that way) and `walk` (≤ 1.5 km). 404 when the event is not
listed; cacheable (max-age 120, s-maxage 300). The event sheet shows the answer as **After this, nearby** —
venue · title · door–close · *walkable* or whole km · Directions (origin = this venue, walking or transit by
`walk`) — remembers the answer across Save / I'm going re-renders, and shows nothing at all when `next` is empty.
No routing, no minutes, no "afters", no plan wording.

**Group Mode** (0025, `GRP` in app.js). *Swipe with friends* lives in the menu (its sub-line names the night it
would deal, or the group's state once one exists) and opens a small sheet with **one order and one button**:
"*7 cards for Fri Sep 18.* You swipe them first, then send the link — friends swipe the same 7 cards, and the
count decides." and *Start swiping →*. (It used to offer *Send the link* and *Start swiping* side by side, and
nobody could tell which came first; and when the chips left too few cards, "widen a chip" was a footnote under
a paragraph about a Send button that was not there. Now too few cards is the loud line — "*Only 1 night on Fri
matches these chips.* Pick another genre or area, or All, to get at least 3 cards" — and nothing else.) The
link goes out from the plan sheet that opens after the last card: while nobody else has voted its sub-line
reads "Now send the link — friends swipe the same 7 cards, and the count decides" with *Send the link* directly
under it (the phone's own share sheet via `navigator.share`, the clipboard where there is none). The sheet is
a small deck builder:
**Night** (Tonight, Tomorrow and the coming Fri/Sat/Sun on one line; a night with fewer than three events is
greyed out, from the same counts the calendar uses; picking a night that is not loaded loads it, so the feed
moves to the night the group is about), **Genre** (All, *Your taste* when a taste is set, then every genre the
night's cards carry — not only the lead one, since UK Garage or Jungle is usually a card's second genre — counted
over enriched cards so raw source tags stay out, most common first, two cards the floor while there are enough
such genres, sixteen the ceiling; a chip matches a card carrying that genre anywhere; several may be on),
**Area** (All, then the boroughs the night's rooms are in). The deck
is dealt from what passes the chips, **neutral on purpose** — flyers first, then how many people are
interested, one card per venue, at most seven (`deckFor()`, `DECK_SIZE`); the owner's own ranking is only a
tiebreak, because friends have different tastes and the owner's order would just reproduce "she hates techno"; the `group_session` row is inserted through PostgREST only when a step is taken
(`ensureGroup()`; `Prefer: return=representation` gives back the id), and the link is `?g=<session>&city&from&to`.
Once a group exists the menu entry opens the votes; *Start another* on the result sheet drops this device's
group and deals the night on screen. The event sheet's action row is *Save · Directions · Add to calendar ·
Share* — one line; *Open listing* went, since every ticket row already opens the listing, and *Venues* left the
menu, since the map does that.
The deck is the image view: `results()` returns the deck's cards in dealt order, the seg hides, the swipe pill
reads *← Pass · Like →* and **its arrows do exactly that** (`arrow()`; they used to page through the deck like
the feed's arrows, so a tap on "→" showed card 2, 3 … 7, 1, 2 — the "repeating cards" report), a swipe or the
two text buttons write one `group_vote` row (upsert), and the last vote opens the plan sheet `#group`. The
picture's edge zones still move — back to change a vote, forward — but a deck is finite: nothing wraps, and
past the last card, once everything is voted, is the plan. A link holder lands on the night (the link carries the range), `openGroupLink()`
reads `group_result(p_session)` and starts them at their first unvoted card, or straight at the plan when they
are done or the night has passed. The plan sheet says it in words only — heading *`m` of `m` liked* when the
top card was liked by everyone who voted, else *Most liked: `n` of `m`*; sub-line *`k` of `m` finished*; one
`.frow` per card with *`likes` of `m`* — polls `group_result` every 4 s while open and visible (ten minutes at
most; nothing says "live"), keeps *Send the link* under its heading, and offers *Keep swiping* or *Back to the
night* at the foot. Its sub-line says what happens next in each state: alone and not sent — *Now send the link
— friends swipe the same 7 cards, and the count decides*; alone and sent (`GRP.sent`, set when the share sheet
completes or the copy succeeds) — *Link sent. Counts fill in here as friends swipe — this page stays under
Menu → Swipe with friends whenever you come back*; others in — *k of m finished · Fri Sep 18. Updates while
open; find it again under Menu → Swipe with friends*. **The plan outlives the tab** (`noct.plan` in
localStorage: id, city, night, sent, owner; written by `ensureGroup()` and `openGroupLink()`, so a friend's
device remembers it too; dropped by *Start another* or once the night has passed): `planRestore()` runs on the
first feed, the menu line reads *3 voted · Fri Sep 18* and opens the counts, loading the plan's night first if
the feed is elsewhere. While a plan is live and its sheet is closed, `watchPlan()` looks once a minute (tab
visible) and toasts *2 people have voted on your plan — Menu → Swipe with friends* when the count grows; the
counts themselves stay on the sheet. `m` counts people
who voted on at least one card, never people who merely opened the link; a person's own votes never leave the
database except to them (RLS + a SECURITY DEFINER aggregate). No percentages, no "match", no group-taste deck,
no push. Identity is the anonymous account, so a link opened in an in-app browser and again in Safari counts as
two people until accounts can be linked.

`srcs` (the ticket rows, "N ways in") are collapsed by ticketing host before they are shaped (0028,
`collapseOffersByHost()` in shape.ts): when DICE's API and SILO's page both sell a night on dice.fm, only the
higher-priority adapter's tiers are listed, every tier of it. `platforms` still names every adapter that read
the night. `/api/health` carries `coverage[]` — per city, upcoming nights on two or more ticketing hosts — the
cross-platform KPI counted by host, not by adapter. Since 0036 a row is an offer **whoever carried it**, as
long as its link is a known ticketing platform, and it is **named after the platform**: a 19hz row that links
to axs.com with a price reads *AXS · $18*, a Tixr link *Tixr*, a Posh link *Posh* (`ticket_platform_name()`
over `platform_host()`). Before that, 19hz was "not a ticketer", so its AXS / Tixr / Ticketmaster / Eventbrite
links were dropped from the sheet whenever RA also listed the night, and read *19hz · See listing* otherwise.
A link to Facebook, Instagram, Partiful or a short link is still a source, not an offer.

`on_sale` is the positive claim `soldout` cannot make: true only when a ticketer's live offer says `available`
(event_offer is ticketers only, 0019). `soldout = false` means nobody said sold out, which is also true of a
door-price night on a community board — so the **Availability → On sale** filter uses `on_sale`, and a night with
neither verdict matches neither filter. The picks line prints *On sale* from the same field, never from its absence.

Every enrichment field is null-safe: before `npm run enrich` has touched an event, `primary` is null,
`genre_codes`/`tags`/`vibes` are empty, the scalars are null, `sound` is `''`, and `genre` falls back to the raw
source labels with `gsrc` naming the sources that tagged ("DICE + RA tags").

## How the UI maps the response

- `EV[i].id` is the numeric `n` (the prototype's `onclick="openDet(3)"` handlers need a number); the uuid is kept
  in `EV[i].uuid` for the day the going/saved actions are wired to the database.
- `DAYS` becomes `[label, sub, hint, date]`; `PRESETS` becomes `[[0,'Sunday'],[1,'Monday'],[2,'Tuesday'],['all','All 3 nights']]`
  (index-based, so any run of nights works, not only Fri/Sat/Sun; `All weekend` when the run starts on a Friday).
- `srcs` platform names are shortened to the prototype's labels (`Resident Advisor` → `RA`, `DICE` → `Dice`) so the
  platform filter and `platformOf()` keep working; `PLATS` and `AREAS` are rebuilt from the loaded events.
- `VENUES` keys are the family names the events carry; each gets deterministic `tones` (the placeholder art) from
  a hash of the name.
- `All` / `Picks` (`S.sel`, the `.seg` under city and date) switch all three views through `results()`. There is no
  taste *filter*: All is already sorted by taste and marks the cards it has a reason for with *Your taste* (the
  marker was called *For you* until 2026-09-16; a third mode between All and Picks read as a second taste
  feature and was removed the same day).
  `Picks` is up to three for the first night loaded — Best match, Safer choice, Wildcard — from
  `/api/recommend?night=` and `assignSlots()`; a pick is also marked with its slot name in `All`. See
  docs/RECOMMENDATIONS.md § Picks. The app opens on `Picks` the first time a session has two or more; a tap on
  the control holds for the session (`sessionStorage`). "Tonight" for the When presets is computed in the
  **city's** zone (`cityDate()`, zones from `cities[].tz`), not New York's.
- Genre words on cards come from `genreWords(e, n)`: the primary first, then the other tag labels in feed
  (classifier) order — three in the image caption, two plus up to two vibes on list rows. Words, not bars: the
  only per-genre number is classifier confidence, identical across genres on half the multi-genre events, so a
  bar would draw a share of the night nobody measured.
- Where present, the image caption and list rows show the **primary genre + up to two vibe chips**
  (`tagLine()`); untagged events show the raw genres exactly as before. The event page adds a **Sound** row
  (`sound_summary`), a **Vibe** row, and a **Why these tags?** block listing genre codes/labels (with the
  confidence on the primary) and vibe codes. Per-tag provenance (`event_tag.sources`) is not in the feed yet, so
  the block says so instead of guessing.
- Flyers (`image`) are set as the background of the visible slide and the event hero; the CSS texture stays
  underneath, so a blocked or slow image degrades to the prototype look.
- Source text is neutralised once in `applyFeed()` (`<` `>` `"` `\` are replaced, URLs must be http(s)) because the
  prototype's templates write straight into `innerHTML`. The sample data path is untouched.

Still client-side only (unchanged from the prototype): sign-in, the going/saved sets, the fake "crowd" handles
and reciprocity rule, venue photos and Instagram tiles.

## Sign-in, going, saved

**Going and saved are wired (2026-09-15).** Every visitor gets an **anonymous Supabase session** on first
load — no login screen, no personal data — so marks survive a reload and a taste history starts accumulating
immediately. The same account is upgraded in place later (`linkIdentity()` / `updateUser()`), so nothing
collected now is lost when a real identity arrives.

How it works, all in `index.html` (no third-party runtime dependency — the page still loads nothing external):

- `sbSession()` restores a session from `localStorage`, refreshes it, or registers a new anonymous user
  (`POST /auth/v1/signup` with `{}`). `sbRest()` talks to PostgREST and retries once on a 401.
- `S.going` / `S.saved` hold **event UUIDs**, not the numeric render ids — the feed renumbers on every load,
  so only the uuid is stable enough to persist. `evById` / `isGoing` / `isSaved` keep the call sites in
  numeric ids.
- Toggles are optimistic: the UI updates, then `persist()` writes (`POST`/`DELETE` on `going`/`saved`); a
  failure reverts and shows a note. `user_id` is never sent — it defaults to `auth.uid()` (0014) and RLS
  rejects a row claiming another user.
- `goCount()` corrects the edge-cached feed precisely: `/api/feed` is cached five minutes, so a row whose
  `created_at` is newer than the response's `generated_at` is not in `going_count` yet (+1), and a row removed
  that the feed *had* counted is the −1 case. No guessing, no drift.
- The publishable key sits in the page by design; RLS is the protection. A session reads and writes only its
  own `going`/`saved` rows, and `going_count` is the one public aggregate (owner-privilege view — see 0013,
  and do not put `security_invoker` on it).
- On the sample weekend (`?demo=1`, `file://` without a feed) `LIVE` is false: nothing is read or written and
  the old simulated handles still render, so the offline demo is unchanged.

Still simulated: the **guest list**. Live events show counts only, because no profile rows exist behind them
yet — `crowdOf()` returns `[]` when `LIVE`. The Instagram-handle sheet still only sets local state; it becomes
`profile.ig_handle` when the social layer is built, and the visibility rule in 0005 is already modelled.

Operational notes for anonymous auth: Supabase rate-limits anonymous sign-ups to **30/hour per IP**, an
invisible CAPTCHA (Turnstile) is recommended before any real traffic, and **old anonymous users have to be
pruned by hand** — they accumulate in `auth.users` forever otherwise.

Identity options when a durable, cross-device account is wanted, in order of least effort:

1. Email magic link (or Apple/Google) plus the Instagram handle as a profile field — `linkIdentity()` upgrades
   the existing anonymous account, so going/saved carry over untouched.
2. Facebook Login for Business with `instagram_basic` through a small Vercel function. Meta app review required.
3. Handle-only pseudo-identity — rejected: guest lists would be trivially spoofable.

## Measurement, first-party (2026-09-16)

Traffic is counted in NOCT's own tables, not by a script from somewhere else — the page still loads nothing
third-party. Two insert-only tables (0030):

- **`visit`** — one row when a session starts, written by `logVisit()` after the first feed lands (a visit is a
  session that saw the calendar; the sample weekend writes nothing). A session is this tab with less than
  thirty minutes of quiet (`sessionStorage`, refreshed by every counted tap), so a reload is not a second
  visit. The row carries the **referrer host** (`app.instagram` / `app.facebook` when the in-app browser sent
  no referrer but the user agent says so; nothing when the referrer is NOCT itself), **utm_source / medium /
  campaign** if the link had them, **entry** — `home`, `event` for a shared `?e=` link, `group` for a `?g=`
  plan link — **phone or desktop**, whether it runs from the **home screen**, the **time zone** and
  **language**. No IP, no user agent string, no page-by-page trail.
- **`action`** — one row per tap no other table records, through `act(kind, uuid)`: `event_open` (not on
  back/forward replay), `track_play`, `share`, `directions`, `calendar`, `map`, `search`, `picks`,
  `night_next`, `group_link`. Saves, going, the taste profile, plans and votes are already in `saved`,
  `going`, `profile`, `group_session`, `group_vote`; together they make the funnel.

Both are written with the anonymous session through `sbRest()` (`Prefer: return=minimal`) and are readable by
nobody from the browser: `authenticated` holds `INSERT` and no policy grants `SELECT`. The owner reads
aggregates only — `/api/health` carries a `traffic` block and `npm run noct -- traffic` prints the same report
(`src/ops/traffic.ts`): visits and distinct devices for 30 days with a 7-day slice, new devices, the share
seen on two or more days, a 14-day series in New York days, sources (utm_source as written, otherwise the
referrer folded — `instagram`, `direct`, `google`, an unknown host as itself), entry, city, device, language,
campaigns, action counts, and the funnel visited → opened a night → saved or going → set a taste → made or
joined a plan, in distinct devices. "Devices" is the honest word for distinct anonymous accounts: one per
browser, not one per person.

## Security model of the read models

- Every table has RLS on (0004/0005/0007). `anon`/`authenticated` are revoked from everything, then granted
  `SELECT` on `event_feed`, `event_offer`, `going_count`, `venue`, `genre`, `vibe`, `event_tag`, `event`
  (rows with `merged_into is null and status <> 'removed'`), the display columns of `source`, and the columns of
  `listing`/`listing_price` the views need (never `raw`).
- `event_feed` and `event_offer` are created `WITH (security_invoker = true)` so those policies apply to whoever
  queries the view. **On Supabase (Postgres 15+) they must stay security_invoker.** Local Postgres 14 does not
  know the option; 0007 falls back to plain views there and says so in a NOTICE.
- `going_count` is deliberately an owner-privilege view: it exposes a count over rows nobody may read.
- `anon`/`authenticated` also lose `EXECUTE` on every function in `public` (0007 section 5), so PostgREST exposes
  no `/rpc/` surface: the write path (`upsert_listing`, `resolve_pending`, ...) is reachable only by the runner
  connecting as `postgres`. Functions added by later migrations must revoke for themselves (0008 does).
- `/api/feed` itself connects with `DATABASE_URL` (the pooler, i.e. the `postgres` role) and only ever reads the
  same views, so PostgREST clients and the API see identical data.

## Working on the UI (designers / front-end teammates)

Everything visual lives in one file, `index.html` (CSS in the `<style>` block, markup, then the script). Nothing
else needs to be installed:

```bash
git clone <repo> && cd noct
open index.html            # or: npx serve .   → http://localhost:3000
```

The page loads **real events from production** (see Loading rules); add `?demo=1` to see the fixed sample
weekend instead, `?from=2026-10-02&to=2026-10-04` to look at another range. Rules of the road:

- Keep the render functions reading the same event fields (`docs/FRONTEND.md` → *How the UI maps the response*).
  New data needs come as a request on the API, not by reaching into other tables.
- Do not put secrets in the page; the API is public read-only and that is by design.
- Branch → pull request; once the Vercel project is connected to GitHub every PR gets a preview URL (`noct-<hash>-…vercel.app`)
  whose API works because `/api/feed` is same-origin there too (preview needs the same env vars as production).
- Sample-data fallback must keep working (`?demo=1`) — it is also what the unit tests and offline demos rely on.

## Local development (backend)

```bash
dropdb --if-exists noct_feed && bash scripts/db-local.sh noct_feed          # 0001..0008, idempotent
export DATABASE_URL=postgresql://localhost:5432/noct_feed
npm run ingest -- ra elsewhere publicrecords goodroom --days 3               # real listings for the next nights
npm run enrich -- --limit 80                                                 # rules-only without ANTHROPIC_API_KEY
npx vitest run tests/unit/feed.test.ts tests/unit/seed_venues.test.ts         # DB-backed (skip without DATABASE_URL)
npx vercel dev                                                               # http://localhost:3000 serves index.html + /api/feed
```

Open `http://localhost:3000/?demo=1` to compare against the sample weekend. To test the page without Vercel,
serve the repo root with any static server and stub `/api/feed` with the JSON that
`npx tsx -e "..."` calling `buildFeed()` prints (that is what the runtime smoke test in the unit report did).

## Known gaps

- Per-tag evidence (`event_tag.sources`) and set times are not in the feed.
- Venue seed (0006) is applied by `db-local.sh` before any ingest. If ingest ran first on a database, the
  provisional rows it created keep winning by learned alias; see the header of 0006 for the one-time merge.
- The date strip is whatever range was requested; the sheet's "Nights loaded" note reflects it, the calendar
  picker of the prototype is still the three presets.
- Images are hot-linked from the source CDNs (RA `images.ra.co`, DICE `dice-media.imgix.net`).

## Search

Menu → Search. One box over events, artists and venues; the ranking is SQL's (`search_noct`, 0020) because
that is where the trigram indexes already are — `event.title`, `artist.name`, `venue.name` and `venue_alias`.

- **A prefix match scores 1.0**, so an exact start always beats a trigram guess: "nowaday" is Nowadays, not
  something that merely shares letters with it.
- **Only things with an upcoming night are returned**, and the count is part of the answer. An artist with no
  dates is a dead end in a listings app.
- **The current city first, then everywhere.** A DJ playing Chicago next week is the answer to "kobosil", not
  "nothing on" — so a miss retries unscoped and each result carries its city. Opening a night outside the
  loaded range reopens the app on it, the same route a shared link takes.

**Every such link must carry the date.** The first version did not: it passed only `?e=<uuid>&city=`, so the
app loaded its default range, the event was not in it, `openShared()` returned silently, and the reader was
left looking at a different night's first card — "tap a search result, get another event". Results now carry
`night`, `openNightAt()` sets `from`/`to` from it, and when the event still cannot be found the app says
"That night is no longer listed" rather than showing something else without comment.

Search also applies `event_is_class()`, like the feed and recommendations: offering a karaoke night that the
feed will then refuse to show is a link to nowhere.

## Artist sheet

A DJ's name is only useful if it leads somewhere, so every line-up entry and set time is a button now.

**Where to tap** was the first thing to get wrong. The line-up started as its own section at the bottom of the
event sheet — 1,060px down an 812px screen, below Going and Tickets, and a bare name with an arrow that looked
exactly like the venue link above it. Nobody found it. The line-up is now a row in the specs block beside
Genre and Vibe, at ~620px, visible without scrolling, with "Tap a name to hear their sets" under it. Set times
keep their own section, because they need the time column.

- **Listen** — YouTube and SoundCloud are searched for `"<name> dj set"`, which is the search a listener
  actually runs; Spotify and RA are searched for the name alone, since neither indexes sets.
- **Playing** — their upcoming nights, shaped as feed cards.

A line-up entry is a string, not an id, so the sheet opens immediately on the name (the links need nothing
else) and resolves the artist in the background for the dates. The match must be **exact**: a fuzzy one would
file someone else's tour under this name.

## Map view (New York)

A third way of looking at the same nights — `results()`, so filters and For you apply — placed on the venues
that hold them. One dot per venue, sized by how many nights it holds in the loaded range, drawn hollow when a
For-you night is there. Tapping a dot opens the venue sheet, which already lists that room's nights, so the map
added no list UI of its own.

**Tiles.** OpenStreetMap's own, inverted and desaturated in CSS into the app's palette. CARTO's dark basemap
would have matched out of the box but now requires an API key — the first render said so across every tile.

**What is not on the map, and why.** Three things had to be taken off before it could ship:

- **Placeholder venues.** "Location TBA – New York" had DICE-supplied coordinates for the middle of the borough,
  so 14 unlocated nights were the busiest dot on the map. `venue_is_placeholder()` keeps TBA / Secret location
  / Undisclosed off it; they count toward "N without a location yet" instead.
- **The centre of the United States.** RA geocoded a room called Ssshhh to 37.09, −95.71 — Kansas, what a
  geocoder returns for "USA" when it has nothing — which put a dot in the Midwest and zoomed the map out to
  the whole country.
- **Rooms that really are far away.** The Avalon Lounge is a real venue two hours upstate that RA files under
  New York. It stays on the map but does not drive the zoom: the initial fit uses only points within ~35 km of
  the city centre.

**Coverage.** Only 38% of a NYC night had coordinates before `backfill_venue_coords()` (0022), which copies
them up from listings by majority vote across sources. New York 82%, Chicago 76%, Los Angeles 69% now; the
rest is placeholders and rooms no source geocodes. All three cities have the map.

**The initial fit** uses the median of the placed nights and ~20 km around it, not a fixed city centre: a fixed
centre with a 35 km radius still let one room in Elk Grove Village drag Chicago's first frame out to the
suburbs. The median cannot be dragged by one dot.

**Tapping a dot** opens the venue sheet, which now leads with that room's nights — "4 nights in this weekend" —
because from the map that is the whole reason for the tap. It used to lead with a "Go there" block, a photo
strip whose caption read "Placeholder. Real venue photography goes here.", and a grid of fake Instagram posts,
with the nights at the very bottom. All three were scaffolding from the static prototype and are gone.
