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
| `supabase/migrations/0024_ig_posts.sql` | `ig_post` and `ig_publish_run`. |
| `supabase/migrations/0025_ig_token.sql` | `ig_token`, the one row holding the live credential. |

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

**The posts use Archivo. The app uses Instrument Sans** (`--f` in `app.css`). The handoff that specified the
post system said every value was "already in index.html or derived from it", which is true of the colours
and not of the typeface. Both the handoff and the working prototype say Archivo, so Archivo is what is
implemented, and it is one constant — `FONT_FAMILY` in `src/post/font.ts`. If the two surfaces are meant to
match, that is the line to change, but it is a brand decision and not a cleanup.

The greys also differ slightly: the app's `--d1`/`--d2` are `.66`/`.40` against the post system's `.70`/`.44`.
The post values are used for posts, as specified.

### Flyer treatments

One treatment across every flyer is what makes an inconsistent set of promoter artwork read as one feed, so
it is a property of the **post**, never of a slide.

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
- **Nothing auto-posts.** There is no cron that calls `/api/publish`.
- **The token is never in a URL.** `access_token` goes in the POST body, not the query string, so it stays
  out of access logs and error reports.

## Setting it up

1. `supabase db push` (or `npm run db:local`) to apply `0024_ig_posts.sql` and `0025_ig_token.sql`.
2. In the Meta app dashboard: **Use cases -> Customize -> Permissions and features**, add
   `instagram_business_basic` and `instagram_business_content_publish`. Both show *Ready for testing*,
   meaning they work in Development mode against an account holding the **Instagram Tester** role — so no
   App Review is needed to post to an account you own. Assign that role under **Roles**, then generate the
   token under **API setup with Instagram login -> Generate access tokens**.
3. Set on Vercel: `STUDIO_PASSWORD`, `IG_USER_ID`, `IG_ACCESS_TOKEN`, `NOCT_PUBLIC_ORIGIN`, and
   `NOCT_RENDER_SECRET` (or rely on `CRON_SECRET`). See `.env.example` for what each one does. **Redeploy**
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

That last row is the one with consequences, and it is why `src/post/token.ts` and `0025_ig_token.sql`
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
- JPEG only. No shopping tags, no branded content tags, no filters.

## Tests

```bash
npm test                                              # offline: layers, treatments, drafting, auth, signing
NOCT_LIVE=1 npx vitest run tests/live/render.live.test.ts   # the renderer, which needs the real font files
```

The renderer's tests are opt-in because satori needs the real Archivo files, and the alternative was
vendoring 440 KB of font binaries. Everything that does not need a font — tones, veil, grain, the treatment
chains, framing — is offline in `tests/unit`. Set `NOCT_FONT_DIR` to run the render tests without network.

## Still open

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
