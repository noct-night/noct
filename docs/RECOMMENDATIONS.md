# Recommendations

"For you" in the Saved view: upcoming nights scored against the account's own `going` / `saved` history, each
one carrying the reason it was picked.

Code: `supabase/migrations/0015_recommendations.sql` (`recommend_events()`) and
`supabase/migrations/0016_rec_quality.sql` (class filter, venue cap, feedback), `src/feed/recommend.ts`,
`api/recommend.ts`, the `#recList` block in `index.html`.

## Why content-based

NOCT has one account's worth of history, not thousands, so collaborative filtering ("people like you also
went to…") has nothing to work with. A taste profile built from the events someone already marked works from
the **first mark**, needs nobody else, and explains itself. Collaborative signals can be blended into the same
score later without changing the interface.

## Onboarding: the profile before there is a profile

Recommendations used to need a history, so a new account saw nothing until it had marked something. Onboarding
asks two questions instead, both skippable, neither of them typing:

1. **Genres** — chips drawn from `/api/taste`, which only offers codes with **8 or more** upcoming nights in
   that city, capped at 24. Every option therefore leads somewhere, and the whole set fits one screen.
2. **Nights** — eight real flyers from `/api/taste?picks=1`, narrowed to the genres just picked, one per venue.
   A tap writes an ordinary `saved` row, so nothing downstream needs a special case.

Step 2 is the stronger half: a tap on a night carries its artists, venue, vibes, price and timing all at once.
An artist picker was considered and rejected on the data — **1,015 of NYC's 1,194 upcoming artists play exactly
one date**, and only 40 play three or more, so the list would be long, unrecognisable, and worth almost nothing.

The genres are stored on `profile.taste_genres` and weighted **0.7** in the scorer, against a going's 1.0 and a
saved's 0.4: a stated preference is real signal, but weaker than turning up, and it must never outrank what
somebody actually did. `history_size` counts a declared taste as one mark, so the cold-start copy does not
appear to someone who has just answered.

The same codes sort the feed client-side — **within** each night, never across one, because people read the
calendar chronologically and Saturday's headliner must not jump above Friday. Nothing is hidden, only
reordered, and the list view says so with a one-tap way back to time order.

## The profile

Built per request from the caller's own marks — `going` weighted **1.0**, `saved` **0.4** (a bookmark is not a
decision), and a recommendation the person *opened* **0.25** (interest, not a decision). For each mark: its genre codes, genre families, vibe codes, artists (via `event_artist`), venue
family, and scalars. Every component is expressed as *the share of the history it accounts for*, so someone
with fifty marks does not get larger scores than someone with three.

## Scoring

| signal | weight | why |
| --- | --- | --- |
| artist overlap | **3.0** | "a DJ you have seen is playing" is the most predictive thing NOCT knows, and the reason a person actually goes |
| genre code | 1.5 | exact subgenre, e.g. `house.deep` |
| vibe overlap | 0.8 | warehouse / day party / all-nighter / phone-free |
| venue family | 0.7 | rooms roll up, so Elsewhere Rooftop matches Elsewhere |
| genre family | 0.6 | partial credit: `techno.dub` for a `techno.peak` history |
| scalar closeness | 1.0 | timing, price and underground-ness, only on the dimensions both sides have and only when at least two are shared |
| popularity | 0.15 | a tiebreak, never a reason |

**Admission rule:** an event must overlap on artist, genre, vibe or venue to be recommended at all. The
scalars only *rank* what is already relevant — almost every club night starts late, ends late and costs about
$20, so letting them admit an event on their own would recommend the entire calendar. (That was a real bug the
tests caught.)

Seeded from `profile.taste_genres` (0.7 per declared genre) when onboarding has been answered. Excluded:
anything already marked or dismissed, past nights, other cities, `is_electronic = false`,
non-`scheduled` status, and anything `event_is_class()` calls a class. The city defaults to the one the most
recent mark was in.

## Not a night out

`is_electronic` answers "is this electronic music" — an Ableton production class at Nowadays passes it.
`event_is_class()` is the separate question, and its patterns are **anchored**, never substrings, because the
live calendar is full of titles that read like classes and are not:

| spared | why a substring match would have killed it |
| --- | --- |
| `Ivy Lab: A Farewell Tour` | a drum & bass act, matched by `lab` |
| `Elsewhere Presents: Jam City @ Market Hotel` | Market Hotel is a venue |
| `Italo Horror Disco … & Dark Karaoke` | a club night that happens to end in karaoke |
| `Banda Brunch - Sunset Mexican Independence Party` | a party, matched by `brunch` |
| `mezza 2 in collab with Le Frique Sonique` | "collab" ends in "lab" |
| `Working Class` | why `class` only counts in the plural or after a teaching noun |

So karaoke counts only when karaoke *is* the event (title start, `Karaoke <weekday>`, or after a short label
like `DOWNSTAIRS:`), `intro to` only at the start, and `lab` not at all. On the live calendar the function
takes out 22 upcoming events — four Ableton labs, sixteen karaoke nights, a free workshop, a techno yoga
class — and nothing else.

## Diversity

`p_per_venue` (default **2**) caps how many nights one venue family can contribute, applied by score before
the final limit, so three Lot Radio nights cannot be the whole list. Events with no venue each get their own
partition: "venue unknown" is not a venue, and grouping them would cap that whole tail at two.

## The feedback loop

`rec_feedback(user_id, event_id, action)` holds one row per reaction, `dismissed` or `opened`, RLS-scoped to
its owner with `user_id default auth.uid()`. The client writes it straight to PostgREST, the same path
`going`/`saved` take.

A **dismissal** does two things: that event never comes back, and its artists, genres, vibes and venue join a
negative profile subtracted from every other score — artist **1.5**, genre **0.9**, vibe **0.5**, venue
**0.5**. Deliberately smaller than their positive counterparts: one "no" should tilt the ranking, not
blacklist a genre, so a strong artist match still survives a dismissal in the same genre.

**Opening** a recommendation adds it to the positive profile at 0.25. The ✕ is undoable — it sits a
thumb-width from the row, so a mis-tap must not permanently bury an event.

## Explanations

Every recommendation returns `why`, the same provenance habit as the genre chips: `You saw MikeQ`,
`You go to Deep House`, `You go to The Lot Radio`, `Your nights are 21+, Outdoors`. If NOCT cannot say why,
it does not recommend.

## Security

`recommend_events()` is `SECURITY DEFINER` with a pinned `search_path`, because it reads catalogue tables
(`event_artist`, `venue`, …) that `anon`/`authenticated` hold no grants on. It takes **no user argument** — the
profile is always `auth.uid()`'s own — so it cannot be pointed at another person's history, and it returns
event ids and reasons only, never a row belonging to someone else. `execute` is granted to `authenticated`
and revoked from `public`/`anon`.

`/api/recommend` forwards the caller's own Supabase access token to PostgREST rather than querying over the
pooled `postgres` connection. Supabase authenticates the user, `auth.uid()` is its verdict, and NOCT never
holds a JWT secret or decides who anybody is. The response is `private, no-store`.

The winning ids are then shaped through the same `event_feed` read model and `shapeEvent()` the feed uses, so
a recommendation renders as an ordinary card.

## Cold start and the empty states

- **no marks** — "Mark a few nights you're going to and NOCT will start suggesting others."
- **marks but no overlap** — says so, rather than padding with popular events.
- One mark is already enough: a single night with a line-up gives artists, a genre and a venue.

## Measured on 2026-09-15

Signal coverage over 1,334 upcoming events: artists **679**, vibes **648**, genres **609**, and of the scalars
`start_lateness` 650 / `end_lateness` 628 / `price_tier` 544 / `underground_index` 344. `energy` and
`darkness` come only from the LLM pass (29 events) and are scored when present. `promoter` is still empty, so
promoters are not a signal yet.

Live check with three marks (Nils Hoffmann @ Elsewhere, a Lot Radio deep-house bill, MikeQ @ 314 Scholes) →
12 recommendations, the top one *"You saw MikeQ · You go to Deep House"*.

## Known gaps

- **Rules-only events carry no `energy`/`darkness`**, so the scalar term is weaker than designed until the
  Gemini backlog finishes.
- **`saved` and `going` are both "interest"** — neither means attendance. A post-night "did you go?" prompt
  would make the strongest signal much cleaner.
- **No per-artist cap.** A resident playing three nights in one month can still appear three times; only
  venues and runs (`0017`, by normalised title) are capped.
- **The feed still shows classes.** `event_is_class()` keeps them out of recommendations, not out of the feed,
  so "Intro to Ableton Lab" can still rank in a taste-sorted night.
- **Dismissals are permanent** apart from the inline Undo, and there is no way to review them later.
- **`event_is_class()` reads titles only.** A class with a party-shaped name gets through until the
  enrichment pass gains a real event-kind field.
