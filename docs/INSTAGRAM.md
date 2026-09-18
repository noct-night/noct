# Instagram: the weekend post, from feed to account

The goal is one sentence: **the weekend post goes out every week without anyone touching images.** One page
is opened, the deck is reviewed, a button is pressed. That is the whole product.

```
                  /api/posts?draft=weekend
  event_feed  ──────────────────────────────▶  ig_post (slides jsonb, caption, status)
                     src/post/draft.ts                    │
                                                          │  /studio  (studio session)
                                                          ▼
                                                  review, edit, approve
                                                          │
                                                          │  /api/publish
                                                          ▼
                       /api/render ◀────── Meta fetches each image_url ──── graph.instagram.com
```

## The pieces

| Path | What it is |
|---|---|
| `/studio` | The review page. Served by `api/studio.ts`, never as a static file, so it is gated. |
| `api/session.ts` | Exchanges the studio password for a session cookie. |
| `api/posts.ts` | The studio's data API: list, draft a weekend, patch caption/status/slides/look. |
| `api/img.ts` | One flyer, treated, as JPEG. Public, CORS, cached hard. |
| `api/render.ts` | `GET` composes one slide (signed URL); `POST` signs a deck (session). |
| `api/publish.ts` | `POST` puts one approved deck on the account; `GET` is a preflight that posts nothing. |
| `src/post/token.ts` | Keeps the 60-day Instagram token alive so a weekly post needs no attention. |
| `src/post/` | Templates, layers, treatments, drafting, the store, the Graph API client. |
| `studio/page.{html,css,js}` | The studio's source, inlined into one gated response. |
| `studio/gate.js` | The sign-in door's script, and the only one a stranger receives. |
| `supabase/migrations/0026_ig_posts.sql` | `ig_post` and `ig_publish_run`. |
| `supabase/migrations/0027_ig_token.sql` | `ig_token`, the one row holding the live credential. |
| `src/video/` | The reel pipeline: spec, ffmpeg, the title layer, storage, the studio client, `clip`. |
| `api/reels.ts` | `?sign=1` mints one-object upload URLs; a plain POST queues the uploaded reel. |
| `supabase/migrations/0032_ig_reels.sql` | `kind`, `video_url`, `cover_url`, `video_meta` on `ig_post`. |
| `supabase/migrations/0033_ig_reel_pending.sql` | `ig_publish_run.status = 'pending'`, the resumable state. |

## Why the studio lives here

The prototype review queue was a claude.ai artifact, which blocks images from external domains. RA and DICE flyers
cannot render there, so every image had to be uploaded by hand, every week — the one thing this is supposed
to remove. Two workarounds were tested and both failed: a proxy on Vercel does not help, because the block
is on the artifact loading *any* outside host; and Claude fetching the flyers itself is blocked too. So the
studio runs on noct's own domain. That is a constraint, not a preference.

## How a slide is drawn

The repo carries no browser, and a lambda that boots Chromium to draw a rectangle is its own problem. So:

- **satori** lays the type out and returns SVG with the glyphs already converted to **outlines**. That is
  why no font has to exist on the machine doing the rasterising.
- **sharp** stacks everything else underneath and encodes the result.

```
event   photo (treated, framed) or tone -> grain -> veil -> type
venue   ground -> photo band at the foot -> type
rest    ground -> type
```

Satori does not support CSS `filter`, which is why the flyer treatment happens in `api/img` / `treatImage`
and never in the type layer. It also has no CSS grid and no `transform: translateY(-50%)`, so a table row is
a flex row with a fixed first column and a centred block is a full-height flex box — see the note at the top
of `src/post/templates.ts`.

**JPEG, not PNG.** Instagram rejects PNG on the media endpoints.

**Wrapping columns need explicit widths.** Satori will let a long headliner run off the canvas rather than
wrap it. `CONTENT_W - TABLE_GUTTER - TABLE_GAP` is not decoration; without it the table slide clips names.

## The design system

Every value is transcribed from the review prototype, which is authored at true 1080x1350. Type is roughly
2.45x the app's 440px scale because a feed post is judged at thumbnail size. It has been pushed up twice.
**Do not shrink it.** Ask for the reference image before changing any of it.

```
Ground      #0B0B0B          Text        #FFFFFF
Grey 1      rgba(255,255,255,.70)
Grey 2      rgba(255,255,255,.44)
Grey 3      rgba(255,255,255,.26)
Hairline    rgba(255,255,255,.22)
Accent      NONE. An earlier orange read as Resident Advisor.
Dividers    Almost none. Alignment and whitespace separate things.
Wordmark    NO left, CT right, split to the edges.
```

Both series are near-black; a white or inverted variant was explicitly rejected. What separates them is
composition alone: an **event** slide is a full-bleed photo with type at the bottom, a **venue** slide is
type at the top with a photo band at the foot plus a running `VENUES 01 / 04` index.

### One divergence worth knowing about

**Posts are set in two faces** (`src/post/font.ts`), decided in review of the first real decks:

- `BODY_FONT` — **Google Sans**, the app's own face (`--f` in `app.css`), for covers, tables, venue copy and
  the CTA, so a post reads like the site it points to.
- `DISPLAY_FONT` — **Archivo**, for the DJ lineup and the NO / CT wordmark. It is the face the logo in
  `brand/noct-logo.png` is set in, so the wordmark on every slide matches the mark itself.

Red Hat Display was the post face in between. Changing either face is one constant; it is a brand decision,
not a cleanup.

The greys also differ slightly: the app's `--d1`/`--d2` are `.66`/`.40` against the post system's `.70`/`.44`.
The post values are used for posts, as specified.

### Flyer treatments

One treatment across every flyer is what makes an inconsistent set of promoter artwork read as one feed, so
the **post** carries a default. After review, each photo slide can override it (`image.treatment`,
`image.grain`) from the controls under the slide in the studio: sometimes a raw photo next to mono flyers
is the right call, and only a person looking at the deck can make it.

```
none    raw
mono    grayscale(1) contrast(1.08) brightness(.94)      <- the default
crush   grayscale(1) contrast(1.5)  brightness(.68)
warm    grayscale(1) sepia(.4) contrast(1.16) brightness(.86) saturate(1.3)
grain   feTurbulence, composited with an overlay blend, only over a real photo
```

CSS `contrast(c)` then `brightness(b)` becomes sharp's `linear(b*c, 255*b*(0.5 - 0.5c))`. Folding the `255`
into the multiplier instead of the offset turns a flyer into a smooth grey gradient; there is a test for it.

## Framing a flyer: read this before changing the default

The handoff says RA flyers arrive at exactly 1080x1350. **They do not, reliably.** Of the flyer URLs listed
as verified, checked while building this:

| Flyer | Actual | |
|---|---|---|
| SACRO by MESTIZA | 1080x1350 PNG | 4:5 exactly |
| Teksupport: Four Tet | 1200x1200 JPEG | square, needs cropping |
| DAY+NIGHT (BASEMENT) | 1080x1520 JPEG | tall, needs cropping |
| Mister Sunday | — | **HTTP 404** |

So cropping is the normal case, not the exception, and it matters: promoter flyers carry their own type near
the edges, and a square flyer centred into 4:5 loses 10% off each side, which can be the first letter of the
headliner. Worse, the flyer's own type then competes with NOCT's type over it.

`cover` stays the default because it is the design. Each slide with a photo also has a **fit** control in the
studio (`Fill` / `Fit whole flyer`) that switches it to `contain`, letterboxed onto the ground. Only a person
looking at the result can tell which is right for a given flyer, and a person is already looking.

## Reels: the other kind of post

A reel is a **post, not a slide**. It shares the review state machine, the caption rules, the publish claim
and the audit trail in `ig_publish_run`, and differs only in what Meta is handed at the end: one
`video_url` with `media_type=REELS` instead of ten `image_url` children. So `0030` adds a `kind`
discriminator to `ig_post` rather than a second table — the duplicated half would have been the publish
transaction, which is the part that is actually hard to get right.

```
  night.mov ──▶ npm run clip ──┬──▶ /api/reels?sign=1 ──▶ a URL for one object
                     │        │                                  │
              ffmpeg, on a    └──── the bytes, straight to ───────┴──▶ Supabase Storage
              laptop                Storage (never through                   │
                                     the function)                           │
                                          │                                  │
                                          ▼  POST /api/reels                 │
                                  ig_post (kind='reel', queued)              │
                                          │                                  │
                                          │  /studio: review, approve        │
                                          ▼  /api/publish                    │
                                  graph.instagram.com ◀── Meta fetches ──────┘
```

### No credentials on the machine cutting video

`npm run clip` holds the **studio password** and nothing else -- the same one a person types into
`/studio`. The two privileged steps happen in `api/reels.ts`, behind that session:

| | Before | Now |
|---|---|---|
| Writes the `ig_post` row | `pg`, with `DATABASE_URL` on the laptop | `POST /api/reels` |
| Puts the file in storage | the service-role key, on the laptop | a signed URL from `?sign=1` |

The first version asked whoever was cutting a clip to keep `DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
in a file. The service-role key can read and write **every table in the project**; that is a large
credential to spread across laptops so that someone can trim thirty seconds of video. It now lives on the
deployment only, and `.env.example` says so.

**The bytes still never pass through the function.** A Vercel function cannot receive a body over 4.5 MB
and a reel is tens of megabytes, so `?sign=1` returns a URL scoped to one object path with a two-hour
expiry, and the file goes straight to Supabase Storage. The function signs and steps aside.

Two smaller decisions worth keeping:

- **The prefix is minted by the endpoint, not sent by the client.** A client-supplied path is a
  client-supplied place to write. The only paths that can be written are ones `/api/reels` chose, and the
  filenames inside are fixed (`reel.mp4`, `cover.jpg`).
- **The endpoint HEADs the upload before writing the row**, with no credentials -- the same request Meta
  will make. So a draft never points at a file that is missing or not public, and a private bucket is
  caught here instead of arriving later as an opaque Graph API error.

### Why the encode does not run on Vercel

This is the one place the carousel's shape does not carry over. A slide is redrawn on demand by
`/api/render` under an HMAC and never stored, which works because it is 200 KB of JPEG that takes
milliseconds. A reel is tens of megabytes that took minutes, so:

- **ffmpeg is not an npm dependency, and no function imports the encoder.** A job whose duration depends
  on how long the video is does not belong under a function ceiling; it fails on the longest clip, which is
  the one someone cared about. `npm run clip` runs on a laptop, where there is no ceiling. (`api/reels.ts`
  imports `src/video/storage.ts` for the signing, which touches no video.)
- **The MP4 is uploaded once, to a public bucket.** Meta arrives with no cookie — the same constraint that
  makes `/api/render` GET signed rather than session-gated. A signed URL would work and then expire,
  possibly between approval and publish.

### The title is drawn by satori, not by ffmpeg's `drawtext`

`drawtext` can put white letters on a video. It cannot put *these* letters there: it has no access to the
tracking table in `templates.ts`, it needs a font file on the machine where a slide needs none, and every
value it took would be a second copy of a number the design system already owns. `src/video/title.ts`
imports the same `DISPLAY_FONT` and the same `linearGradient`, and renders one transparent 1080x1920 PNG
that ffmpeg overlays. A reel that does not match the deck beside it is the failure worth designing against.

The scrim is in that PNG rather than a separate filter, because white type over unknown club footage is
illegible about half the time and the gradient that fixes it must never drift from the type it is under.

### Framing, and the vertical canvas

Reels are `1080x1920`, not the carousel's `1080x1350`. Type sizes are unchanged — 1080 wide is 1080 wide —
and only the vertical placement differs. `--position low` is the default because the top of a reel belongs
to Instagram's own chrome, and the type clears the bottom rail by 320 px for the same reason.

```
cover    scale so the short edge fills, centre-crop the long one     <- the default
contain  scale to fit, pad with the ground
blur     scale to fit over a blown-up, blurred copy of itself
```

`cover` is the default for the same reason it is for a flyer: it is the design. `blur` is the one the other
two do not cover — it keeps the whole frame *and* fills the screen, and reads as deliberate where a hard
letterbox reads as a mistake.

### What is checked, and when

The output is probed after encoding and checked before anything is uploaded, because nearly every Graph API
rejection of a reel is a spec violation arriving as an opaque error. **Errors stop it** (under 3 s, over 15
minutes, over 1 GB, over 60 fps, not H.264). **Warnings do not** — a letterboxed clip or one over the 90 s
house limit is a choice someone may have made on purpose.

Two smaller ones worth knowing:

- **A muted clip still gets an audio track.** Silence is not the same as no track, and some Instagram
  surfaces treat a trackless reel as broken. `anullsrc` supplies it.
- **`+faststart` is not optional.** Without it Meta must fetch the whole file before it can read the
  header, which surfaces as a container stuck `IN_PROGRESS` with no explanation.

### `npm run clip`

```bash
# encode only: no sign-in, no upload, no draft
npm run clip -- night.mov --start 1:12 --len 28 --title "SACRO" --sub "Basement / Friday" --local

# the real thing: encode, sign in, upload, queue a draft for review
npm run clip -- night.mov --len 30 --title "Four Tet" --caption "Teksupport at Knockdown Center."
```

It talks to `https://noct.pro` unless `NOCT_STUDIO_URL` says otherwise, and reads the password from
`NOCT_STUDIO_PASSWORD` or asks for it once, without echoing it.

It stops at a **queued** draft. There is no `--publish` flag, on purpose: publishing goes through
`/api/publish` behind the studio session, so there is one gated door to the account and not two.

## Copy rules

Encoded in `src/post/caption.ts`, checked as she types and again before publishing. `checkCaption()`
**reports and never rewrites**: the studio shows what it says and she decides, because silently editing her
words would be worse than leaving a mistake.

- At most **five hashtags**, the ones closest to the specific event.
- **No em dashes**, anywhere.
- **No middle dot** (`·`) as a separator. Slashes or hyphens.
- Avoid the **"it's A, not B"** construction.
- **Headliner-first titles.** RA hands over the whole bill in one string; the headliner leads and the rest
  folds into the caption. `headlineOf()` in `src/post/draft.ts`.
- **Keep volatile numbers off the post face.** Interested counts and prices go stale between drafting and
  posting. They rank the deck and are never printed on it. A caption is reviewed in the minute before
  publishing, so it is the only place they belong.

### Publishing, and the third outcome

Every publish has three endings, and the extra one is not a failure.

Meta fetches the media itself and will not publish a container until it has. A reel container is
**transcoded asynchronously**, and how long that takes is Meta's business: for a 90-second clip it can
outlast the 120 s cap on `api/publish.ts`. A deck is quicker but not instant — a carousel built from
children Instagram is still fetching is refused with **`Media ID is not available` (9007 / 2207027)**,
which is what publishing a deck used to fail with. So both kinds wait: every carousel item, then the
carousel itself (45 s budget), then `media_publish`, which is itself retried three times on 9007 because
FINISHED and publishable can be a second or two apart.

Before any of that, the publish fetches every render URL itself. `/api/render` renders on demand, so the
first fetch of a slide is the slow one and Meta's fetcher is less patient than a browser; fetching them
first warms the edge cache and turns a render that fails into a failure that names the slide. And when
`media_publish` still refuses, the error reports what each container said about itself, which is what
separates "Meta never fetched the images" from "Meta has them and refused anyway".

For a reel, waiting can outlast the function, which leaves two bad options and one good one:

- hold the lambda until it is killed — and being killed between `media_publish` and the row update is the
  single worst outcome available, because Instagram has the post and the database does not know;
- record a `failed` run for something going perfectly well, whose container is still valid for 24 hours;
- or stop early and say so. That is `'pending'` (`0031`), and it means exactly one thing: **the container
  exists and the work can be resumed.**

```
POST /api/publish  ──▶  container created  ──▶  poll (75 s budget)  ──▶  FINISHED  ──▶  media_publish
                             │                        │
                    recorded immediately        budget spent
                     (run.container_id)               │
                                                      ▼
                                          202, run status = 'pending'
                                                      │
                          next POST finds it and polls that container, uploading nothing
```

Three details carry the weight:

- **The container id is recorded before the poll starts.** The poll is the step that can end without a
  result, so persisting the id afterwards would lose the only thing that makes a timeout recoverable.
- **The budget is checked before sleeping, not after.** Waiting out the last interval and *then* reporting
  a timeout spends the wait for nothing.
- **`'pending'` does not block a new claim.** `claimForPublish` only refuses on `'running'`. Being told "a
  publish is already in flight" when nothing is in flight is the state this replaces.

`PUBLISHED` is treated as ready rather than as an error. It means an earlier attempt got further than its
row did, and refusing there would leave a reel on the account that the store can never record.

On a rejection, Meta's `status` sentence is passed through verbatim. It is the only thing that says which
spec was violated, and that is the whole of what makes the failure fixable.

`share_to_feed=true`, so a reel lands in the grid as well as the Reels tab. A weekly clip that is invisible
to anyone looking at the account is the wrong default; it is one parameter in `publishReel` to change.

## Security, and why each piece is shaped that way

**The publish endpoint posts in public under NOCT's name.** That is the thing being protected.

- **`/studio` is gated server-side.** A `?studio=1` flag hides nothing — the markup ships to every visitor
  either way. Here the page is served by a function, and without a session the studio half is *cut out of the
  response*: no studio markup, and no `page.js`, which would otherwise name every endpoint and every action.
  A stranger gets the door and `gate.js`. Stripping the markup alone was not enough — the inlined script
  still described the whole studio, which is why the door has a script of its own, and why there is a test
  asserting that `/api/publish` never appears in a signed-out response.
- **Fails closed.** With no `STUDIO_PASSWORD`, production returns 503 rather than an open publish button.
  Locally it stays open so the page can be worked on. Same shape as `api/_lib/auth.ts`.
- **`/api/img` is an allowlist, not a proxy.** It fetches nine hostnames — the CDNs the adapters actually
  put in `image_url`. An image proxy that fetches anything is a server-side request forgery hole. The host
  is re-checked after redirects so a 302 cannot walk off the list. Extend with `NOCT_IMG_HOSTS`.
- **`/api/render` GET is signed, not session-gated.** It cannot be session-gated: the thing fetching it is
  Meta, which arrives with no cookie. So the slide spec travels in the URL under an HMAC and the endpoint
  renders only specs NOCT produced. Without that it is a free render farm for whoever finds it.
- **Publishing is claimed in a transaction.** Two clicks of Publish, or a click and a retry, cannot both
  reach the Graph API. Only an `approved` post can be claimed at all. A claim older than
  `PUBLISH_STALE_MS` (15 minutes, against a 120 s function cap) is abandoned rather than honoured, so a
  lambda killed mid-publish costs one row in the log instead of a post that can never go out.
- **Cutting video needs no credential but the studio password.** `/api/reels` holds the database and
  storage access and is gated like every other studio route; the CLI signs in the way the page does. The
  signed upload URL it hands back is scoped to one object path and expires in two hours, so the worst a
  leaked one can do is overwrite that object.
- **The reels bucket is public, and that is the whole of its access control.** Meta fetches `video_url`
  with no credentials, so it has to be. The URLs are unguessable (a post uuid as the prefix), not secret —
  nothing goes in that bucket that is not about to go on the account anyway.
- **`SUPABASE_SERVICE_ROLE_KEY` is a Vercel variable, and only that.** Uploading is a write, so the
  publishable key cannot do it; the key that can read and write every table in the project therefore lives
  on the one deployment and on no laptop. Same rule as `IG_ACCESS_TOKEN`.
- **Nothing auto-posts.** There is no cron that calls `/api/publish`.
- **The token is never in a URL.** `access_token` goes in the POST body, not the query string, so it stays
  out of access logs and error reports.

## Setting it up

1. `supabase db push` (or `npm run db:local`) to apply `0026_ig_posts.sql`, `0027_ig_token.sql`,
   `0032_ig_reels.sql` and `0033_ig_reel_pending.sql`.
2. In the Meta app dashboard: **Use cases -> Customize -> Permissions and features**, add
   `instagram_business_basic` and `instagram_business_content_publish`. Both show *Ready for testing*,
   meaning they work in Development mode against an account holding the **Instagram Tester** role — so no
   App Review is needed to post to an account you own. Assign that role under **Roles**, then generate the
   token under **API setup with Instagram login -> Generate access tokens**.
3. Set on Vercel: `STUDIO_PASSWORD`, `IG_USER_ID`, `IG_ACCESS_TOKEN`, `NOCT_PUBLIC_ORIGIN`,
   `NOCT_RENDER_SECRET` (or rely on `CRON_SECRET`), and -- for reels -- `SUPABASE_SERVICE_ROLE_KEY`
   alongside `SUPABASE_URL`, which is what `/api/reels` signs uploads with. See `.env.example` for what each one does. **Redeploy**
   afterwards: Vercel does not apply new environment variables to a running deployment.
4. Check the credential without posting anything: `GET /api/publish` (signed in) returns the account handle,
   the remaining daily quota, and how many days the token has left.
5. Open `/studio`, sign in, press **Draft the coming weekend**.

`IG_ACCESS_TOKEN` can post as NOCT. Never in the repo, never in the client bundle, never pasted into a chat.

### Which Instagram API, and why it matters

This uses **Instagram API with Instagram Login** (`graph.instagram.com`), not the Facebook-login variant.
The app authenticates as the Instagram account itself: no Facebook Page has to exist, and no personal
Facebook profile sits in the middle owning the credential.

The carousel flow is identical between the two. What differs:

| | Instagram Login (this) | Facebook Login |
|---|---|---|
| Host | `graph.instagram.com` | `graph.facebook.com` |
| Permissions | `instagram_business_basic`, `instagram_business_content_publish` | `instagram_basic`, `instagram_content_publish`, plus Page perms |
| Needs a Facebook Page | no | yes |
| Token lifetime | **60 days, refreshable** | does not expire |

That last row is the one with consequences, and it is why `src/post/token.ts` and `0027_ig_token.sql`
exist. A weekly post reading a token from the environment would work beautifully for two months and then
fail on a Friday with nobody watching. So `IG_ACCESS_TOKEN` is a **seed**: the first publish copies it into
`ig_token`, and every later run refreshes it once it is within 14 days of lapsing. A post a week keeps it
alive indefinitely; only a two-month gap can break it, and there is a test pinning that.

A refresh failure is deliberately not fatal — the current token is still good for up to two more weeks, so
the post goes out and the problem is logged rather than blocking a deadline on a credential that still works.

### Graph API limits

- 100 API-published posts per rolling 24 hours. A carousel counts as one. `/api/publish` checks the
  remaining quota before it starts rather than failing opaquely.
- Up to 10 items per carousel. The weekend deck is seven.
- JPEG only on the image endpoints. No shopping tags, no branded content tags, no filters.
- Containers are processed **asynchronously**, reels and carousel items alike: each is polled for
  `status_code=FINISHED` before `media_publish` will take it, and 9007 / 2207027 from `media_publish`
  means "not yet", not "no".

## Tests

```bash
npm test                                              # offline: layers, treatments, drafting, auth, signing
NOCT_LIVE=1 npx vitest run tests/live/render.live.test.ts   # the renderer, which needs the real font files
NOCT_LIVE=1 npx vitest run tests/live/clip.live.test.ts     # the encoder, which needs ffmpeg on PATH
```

The renderer's tests are opt-in because satori needs the real Google Sans and Archivo files, and the alternative was
vendoring 440 KB of font binaries. Everything that does not need a font — tones, veil, grain, the treatment
chains, framing — is offline in `tests/unit`. Set `NOCT_FONT_DIR` to run the render tests without network.

The encoder's tests are opt-in for the same kind of reason, and vendoring ~78 MB of ffmpeg to assert a crop
was not worth it. The filtergraph, the argument order and the spec envelope are checked offline in
`tests/unit/video_clip.test.ts` — which is where the real failure lives, because a wrong filtergraph does
not crash: ffmpeg accepts it and writes out something squashed.

## Still open

- **Reels are unscheduled, so they sort last.** `listPosts` orders by `slot desc nulls last`, and a reel
  has no slot, so a clip cut today appears below every weekend deck. The evergreen `venues` series has
  always had this, which is why it is here rather than fixed in passing: changing the order changes where
  the decks appear too, and that is a call about the studio and not about reels.
- **A weekly cron that prepares the draft and sends a nudge**, so the loop becomes "get a nudge, open,
  approve". Deliberately not built yet: the draft step is already idempotent per weekend
  (`POST /api/posts?draft=weekend`), so this is a scheduler and a notification, nothing more.
- **Venue photography.** Flyers solve event slides for free; venue slides still need photographs shot or
  licensed. Until then a venue slide says "Photo of the venue" rather than showing an empty band.
- **Terms and rights.** Using promoter flyers to *display listings* is ordinary. Using them in NOCT's own
  *marketing posts* is a different use, and both RA and DICE restrict it in their terms. This needs a
  lawyer. Nothing in this code decides it.
- **`noct.nyc`** appears on the post covers and its ownership is unconfirmed. If it is not registered, the
  Instagram handle should replace it — one string, in `src/post/draft.ts`.
