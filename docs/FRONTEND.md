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

- **Presets** — Tonight / Tomorrow / This weekend / This week. `rangeOf(key)` computes the window in New York's
  calendar (Mon–Thu "this weekend" jumps to the coming Friday; on a Sunday it collapses to tonight) and
  `pickRange()` reloads the feed for it. The default load follows the active preset, so a city switch re-asks
  for the same window in the new city's own calendar.
- **Month calendar** — `renderCal()` draws a 7-column grid for `S.calMonth`: past nights and nights with no
  events are disabled, today carries `aria-current="date"`, the selected night is underlined, and each cell
  shows its event count. Tapping a night calls `pickDate()` → one-night feed. ‹ › move months; the back arrow
  stops at the current month.

Counts come from `GET /api/feed?counts=1&from&to&city`, which returns one integer per night (~3 KB for a
month) instead of the ~320 KB a month of full event records costs. They are cached per month+city in
`S.counts`, so reopening the sheet is free. `MAX_COUNTS_DAYS` (62) lets a six-week grid through where full
feeds stop at `MAX_RANGE_DAYS` (31).

Tapping a night keeps whatever view mode is active (Image or List) — the date filter applies to both.

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

## Sign-in, going, saved: the storage exists, the wiring does not

`supabase/migrations/0005_app.sql` creates `profile (user_id, ig_handle citext unique, visibility count|mutuals|public)`,
`going`, `saved` and `follow`, with RLS so a signed-in user reads and writes only their own rows (`auth.uid()`
policies, created only where the `auth` schema exists). `going_count(event_id, n)` is the one public aggregate and
is already joined into `event_feed.going_count`.

Why it is not wired: **Instagram is not a Supabase Auth provider.** Options, in order of least effort:

1. Supabase Auth with email magic link (or Apple/Google) plus the Instagram handle as a free-text profile field —
   the prototype's flow already asks for the handle first, so nothing in the UI changes.
2. Facebook Login for Business with the `instagram_basic` scope through a small Vercel function, exchanging the
   token for a Supabase session via `signInWithIdToken`-style custom claims. Meta app review required.
3. Handle-only pseudo-identity (no auth) — rejected: guest lists would be trivially spoofable.

Wiring steps when the time comes: add `@supabase/supabase-js` to the page with `SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY` (already in `.env.example`); on sign-in, upsert `profile`; `toggleGoing`/`toggleSave`
become inserts/deletes on `going`/`saved` keyed by `EV[i].uuid`; `goCount()` reads `going_count` from the feed
instead of the fake crowd; `visibleTo()` becomes a query joining `going`, `profile.visibility` and `follow`.
`tag_vote` (0004) is the same pattern for the "Suggest a genre" prompt.

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
