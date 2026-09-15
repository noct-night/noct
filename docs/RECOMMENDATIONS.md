# Recommendations

"For you" in the Saved view: upcoming nights scored against the account's own `going` / `saved` history, each
one carrying the reason it was picked.

Code: `supabase/migrations/0015_recommendations.sql` (`recommend_events()`), `src/feed/recommend.ts`,
`api/recommend.ts`, the `#recList` block in `index.html`.

## Why content-based

NOCT has one account's worth of history, not thousands, so collaborative filtering ("people like you also
went to…") has nothing to work with. A taste profile built from the events someone already marked works from
the **first mark**, needs nobody else, and explains itself. Collaborative signals can be blended into the same
score later without changing the interface.

## The profile

Built per request from the caller's own marks — `going` weighted **1.0**, `saved` **0.4** (a bookmark is not a
decision). For each mark: its genre codes, genre families, vibe codes, artists (via `event_artist`), venue
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

Excluded: anything already marked, past nights, other cities, `is_electronic = false`, and non-`scheduled`
status. The city defaults to the one the most recent mark was in.

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

- **Workshops and classes rank as nights out.** "Intro to Ableton Lab" at Nowadays scores on the venue and a
  house genre prior. `is_electronic` answers "is this electronic music", not "is this a night out"; the
  classifier needs an event-kind flag, or the rules need a class/workshop detector.
- **Rules-only events carry no `energy`/`darkness`**, so the scalar term is weaker than designed until the
  Gemini backlog finishes.
- **No diversity control.** Three Lot Radio nights can fill the list; a per-venue or per-artist cap would
  spread it out.
- **No feedback loop.** Nothing learns from a recommendation being ignored. `tag_vote` is the existing model
  for that if it is wanted.
- **`saved` and `going` are both "interest"** — neither means attendance. A post-night "did you go?" prompt
  would make the strongest signal much cleaner.
