# Genre & vibe enrichment

How NOCT turns a raw listing ("Vladimir Ivkovic All Night, Nowadays, 22:00, $10") into the chips a user sees
("Experimental / IDM · All night · One DJ all night · Phone-free · Cheaper early"), why it trusts each chip as
much as it does, and what it costs.

Code: `src/enrich/` (taxonomy, crosswalk, rules, evidence, classify, run) · storage: `0003_enrichment_contract.sql`
(shapes) + `0004_enrichment.sql` (seed + run/vote tables) · entry points: `npm run enrich -- [--limit N] [--force]`,
`GET|POST /api/enrich`, `select noct_call('/api/enrich?limit=60')` from pg_cron (0008).

## What users see

- **Feed card**: one filled primary-genre chip (family colour, subgenre label, e.g. *Deep House*), up to two outlined
  secondary genre chips, up to three vibe chips with glyphs (☀️ day party, 🌙 all night, 🏭 warehouse, 🌳 outdoors,
  🎟️ free/RSVP, 📵 phone-free), and a five-dot energy meter. Chips under 0.5 confidence render dotted with a “?”;
  `needs_review` events show the family chip only.
- **Event sheet**: `sound_summary` (≤ 20 words) under the title; every chip; scalar rows (Energy, Darkness, Crowd,
  Starts, Ends) as dots with plain-language labels; a **“Why these tags?”** panel that lists `event_tag.sources`
  grouped by source in plain sentences — “RA lists House, Deep House”, “Nowadays: no photos on the floor”,
  “Rule: 22:00–06:00, one artist for the whole session”, “Model: description mentions ‘coldwave and outsider dance
  music’”. Confidence is shown as High / Medium / Low, never as a number.
- **Votes**: long-press or “Not right?” on a chip → thumbs up/down plus “Suggest instead” over the taxonomy
  (`tag_vote`; one vote per user per tag; `suggested_code` carries the alternative). Net ≥ +3 promotes a tag to
  `status='community'` (✓ badge), net ≤ −3 rejects it and re-queues the event with the votes in its evidence.
  Curators set `status='confirmed'`. The runner never overwrites confirmed / community / rejected rows.
- **Filters** read `event.primary_genre`, `event.genre_codes`, `event.vibe_codes` and the scalar columns; family
  pills expand to subgenres; quick toggles for “Day parties”, “Starts after 11pm”, “Free & RSVP”, “Phone-free”.

## Taxonomy

`src/enrich/taxonomy.ts` is the single source of truth; `0004_enrichment.sql` seeds the same rows and
`tests/unit/taxonomy.test.ts` asserts the database equals the TypeScript lists. 18 families / 60 codes
(`house.deep`, `techno.dub`, `bass.club`, `afro.amapiano`, `open.eclectic`, …), each with a label, a one-line
definition (which is also the model's definition), the RA names that map to it (all 70 RA genres are covered),
DICE `genre_tags` suffixes, Discogs styles and free-text aliases. 42 vibes grouped by kind — space, time, format,
crowd, policy — each with a label and glyph. Codes are stable strings: never rename one, add a new one and migrate
`event_tag` rows.

## Pipeline

```
listing rows ──refresh_event()──▶ event ──┐
                                          ▼
S1 rules.ts     deterministic: time → start/end lateness + day-party / all-nighter / afters, price → tier + free /
                cheap-early / pricey, age bands, venue priors (warehouse, yard, rooftop, phone policy, capacity →
                crowd size), promoter priors (weekly residency, local crews, underground), billing cues (all night,
                b2b, live), title/description regexes, crosswalk of every source genre label.
S3 evidence.ts  one SQL statement selects candidates and joins venue + promoter priors, per-source raw genres,
                live prices / sold-out, artist_genre_profile rows (when the artist cron has filled them) and
                human tags; TS computes input_hash and renders a ≤ ~500-token bundle.
S4 classify.ts  Claude (NOCT_ENRICH_MODEL, default claude-opus-5) with a frozen, 1h-cached system prompt (taxonomy,
                vibe definitions, scalar rubrics, NYC venue glossary, rules) and structured outputs
                (zod schema → JSON schema): 1–3 genres with confidence bins and a cited “why”, 0–6 vibes, seven
                scalars, sound_summary, is_electronic, flags.
S5 run.ts       merge → one transaction: event.* denormalised columns, event_tag rows with provenance,
                classification_run with tokens + cost.
```

Candidates are canonical events (`merged_into is null`, not removed) from yesterday onward whose `classified_at`
is null, whose inputs changed (`input_hash` = sha256 of title, times, lineup, description, venue + priors,
promoter priors, price, age, sold-out, source genres, artist profiles, human tags) or whose
`classification_version` is from an older rules/prompt version. Counters such as `interested_count` are excluded
from the hash on purpose so a popular event is not re-billed every hour.

Without `ANTHROPIC_API_KEY` the pass is **rules-only**: crosswalk genres capped at 0.5, rule vibes, rule scalars,
`energy`/`darkness` left null, `classification_version = rules-v1/p1/rules`. The same happens for an event whose
model call failed or was refused — it is persisted with rules-only labels, `needs_review = true`, and the error
in `classification_run.error`, so one bad call never blocks the batch.

### Merge policy

- **Genres**: human tags (confirmed / community) first at ≥ 0.9; then the model's genres with its confidence; a
  code humans rejected is never re-assigned. Rules-only: crosswalk ranking capped at 0.5, then promoter / venue
  priors capped at 0.4 if nothing else exists. Best three, best first → `primary_genre`, `genre_codes`,
  `genre_confidence`.
- **Vibes**: union of human, rule and model vibes (rules never lose to the model — they read the clock).
- **Scalars**: the model's when available, except `start_lateness`, `end_lateness` and `price_tier`, which the
  rules compute from the listing itself; rules-only otherwise.
- **needs_review** = top genre confidence < 0.5, or any classifier flag (`needs_review`, `not_electronic`,
  `ambiguous_artist`, `conflicting_sources`, `sparse_input`), or a failed / refused call.
- `classification_version = <RULES_VERSION>/<PROMPT_VERSION>/<model>`; bumping either constant re-queues every
  upcoming event on the next run.

## Provenance

Every `event_tag` row carries `sources: [{source, evidence, weight}]`:

| source | meaning | weight |
| --- | --- | --- |
| `ra`, `dice`, `elsewhere`, `ticketmaster`, `goodroom`… | a source's own genre label (via the crosswalk) | 0.8 RA · 0.6 DICE · 0.45 coarse feeds; ×0.4 when the label only names a family ("House") |
| `text:title`, `text:description` | word-boundary alias match in the copy | 0.55 · 0.35 |
| `discogs` | artist profile style histogram (artist cron, phase 2) | 0.5 |
| `venue_prior`, `promoter_prior` | curated tables (0003 columns, seeded in 0006) | 0.3 · 0.45 |
| `rule:<id>` | deterministic rule, e.g. `rule:time.all_nighter`, `rule:venue.phone_policy` | 0.8 |
| `llm` | the model's cited reason | its confidence (genres) · 0.7 (vibes) |
| `curator`, `community` | human state | 1 |

The why-panel renders these verbatim; the model is instructed to name its source in every `why` and never to
assign a subgenre from an unknown artist's name alone.

## Confidence policy

Confidence bins are fixed strings in the output schema (structured outputs cannot express numeric ranges) and
mean: **0.9** several independent sources agree · **0.8** one strong source (RA subgenre tag, headliner
discography) plus consistent text · **0.65** one clear signal · **0.5** venue/promoter priors or a generic family
tag only (the model must also set `sparse_input`) · **0.35** weak inference · **0.2** a guess not worth showing.
Model knowledge of a well-known touring artist is allowed but capped at 0.65 and must say so. Anything under 0.5
is dotted in the UI and flips `needs_review`. Rules-only labels never exceed 0.5 because nobody reconciled the
evidence.

## Provider options

The classifier talks to one of two backends behind the same `ClassifierClient` shape (`src/enrich/classify.ts`,
`src/enrich/providers.ts`); the rules, evidence bundle, output schema, merge and persistence are identical.

| provider | env | notes |
| --- | --- | --- |
| rules-only | nothing set | $0. What runs until a key is configured. Genres capped at 0.5, no `sound_summary`, no `is_electronic` filtering. |
| `openai` (free tiers) | `NOCT_LLM_BASE_URL`, `NOCT_LLM_API_KEY`, `NOCT_LLM_MODEL` | Any OpenAI-compatible `/chat/completions`: Google AI Studio (Gemini), Groq, Mistral, OpenRouter `:free` models, Cerebras, Ollama. Structured output via `response_format: json_schema` built from the zod schema with real enums (`OUTPUT_JSON_SCHEMA`); if a provider rejects it the client falls back once to `json_object` with the schema in the prompt and stays there. Calls are spaced (`NOCT_LLM_MIN_INTERVAL_MS`, default 4 s ≈ 15/min) and a 429 is retried once after Retry-After; a second 429 or any other error makes that one event rules-only + `needs_review`. Free-tier caveats: per-minute and per-day quotas (the hourly cron's `?limit=60` and the `input_hash` skip keep volume at roughly the number of new/changed events, ~70/day), prompts may be used for product improvement under free terms, and models/quotas change without notice — read the provider's current limits page. Cost is recorded as 0 unless `NOCT_LLM_PRICE_INPUT/OUTPUT` are set. |
| `anthropic` | `ANTHROPIC_API_KEY`, `NOCT_ENRICH_MODEL` | The original design: prompt caching (1 h), adaptive thinking on Opus 5 with `effort: medium`, SDK structured outputs. `claude-haiku-4-5` is the cheapest (~$6/month at 500 events/week); it does not take `effort`, which the request builder omits automatically. |

Selection: explicit `NOCT_LLM_PROVIDER` wins; otherwise whichever key is present (Anthropic first). A provider that is
named but half-configured throws at startup — a cron silently running rules-only because of a typo would be worse
than a loud 500. Switching providers changes `classification_version` (it embeds the model), so every upcoming
event is re-classified on the next run.

Quality expectation: this is a constrained classification over a 60-code taxonomy with an evidence bundle, which
mid-size free models handle reasonably; expect more `sparse_input`/generic-family answers than with Opus and
check the 100-event golden set (below) before trusting subgenre chips from a new model.

## Cost

Per event with the default model (`claude-opus-5`: $5 / $25 per MTok, cache read $0.50, 1h cache write $10),
assuming the ~2,500-token system prompt is served from cache, ~600 uncached input tokens and ~400 output tokens:

| model | cached system | input | output | per event | 500 events / week | per month |
| --- | --- | --- | --- | --- | --- | --- |
| claude-opus-5 | 2,500 × $0.50/M = $0.00125 | 600 × $5/M = $0.0030 | 400 × $25/M = $0.0100 | **$0.01425** | **$7.13** | **≈ $31** |
| claude-sonnet-5 | 2,500 × $0.20/M = $0.0005 | 600 × $2/M = $0.0012 | 400 × $10/M = $0.0040 | **$0.0057** | **$2.85** | **≈ $12** |
| claude-haiku-4-5 | 2,500 × $0.10/M = $0.00025 | 600 × $1/M = $0.0006 | 400 × $5/M = $0.0020 | $0.00285 | $1.43 | ≈ $6 |

The 2,500-token figure is the planning assumption; the frozen `SYSTEM_PROMPT` as shipped is ~16.4k characters
(roughly 4.5–6k tokens on the Opus 4.7+ tokenizer, not yet measured with `count_tokens`), so expect the cached-read
line to be about twice the table above (≈ $0.0025 on Opus, ≈ $0.0155 per event, ≈ $34/month at 500 events/week).
`classification_run` records the real usage, so the first live batch replaces these estimates.

Plus one 1h cache write per cold hour (2,500 × $10/M = $0.025 on Opus; the hourly cron at :40 keeps the cache
warm in practice). Re-runs after a prompt bump cost the same per event; the hash check makes unchanged events free.
`classification_run.cost_usd` records the real number per call from the API's usage fields, so `select
date_trunc('day', created_at), sum(cost_usd) from classification_run group by 1` is the invoice. Switch models with
`NOCT_ENRICH_MODEL=claude-sonnet-5` (roughly 2.5× cheaper; measure on the golden set before making it the
default — the runner never downgrades on its own). Batch API (50% off, ≤ 24 h latency) is the next lever if volume
grows 4×.

## Evaluation plan

1. **Golden set**: 100 upcoming NYC events hand-labelled by the owner — ~40 with RA subgenre tags, ~25 with only a
   family tag or none, ~15 unknown local DJs with a description, ~10 non-electronic edge cases (live bands, comedy,
   hip-hop showcases on DICE / Ticketmaster), ~10 day parties / afters / boats for the vibe rules. Stored as a
   fixture keyed by `listing.source_key + source_id` so it survives re-ingestion.
2. **Metrics** per run of `tests/live/enrich.live.test.ts` style harness: family-level precision / recall of
   `primary_genre` (target ≥ 90% on headliner events), subgenre exact match (report only), vibe precision for
   time/price/venue-derived vibes (target ≥ 85%), `is_electronic` accuracy on the edge cases (target 100%), mean
   cost and tokens per event, share of `needs_review`.
3. **Cadence**: run the golden set before every `PROMPT_VERSION` / `RULES_VERSION` bump and whenever the model is
   changed; publish the table in the PR. Weekly, compare `tag_vote` outcomes against the model's confidence bins to
   check calibration (a 0.8 chip should be flipped by users far less often than a 0.5 chip).
4. **Live guard**: `NOCT_LIVE=1 ANTHROPIC_API_KEY=… npx vitest run tests/live/enrich.live.test.ts` classifies the
   Ivkovic example for real and asserts a house/techno/leftfield family, ≥ 1 vibe and a sane cost.

## Open decisions

- **is_electronic routing**: the classifier flags gigs / comedy / hip-hop showcases with `is_electronic = false`
  and `not_electronic`. Whether the feed hides them, shows them in a separate tab, or shows them with the family
  chip only is a product call; the column exists so the feed can do any of the three.
- **Guest-list default** (RSVP-only events, door lists) is out of scope for this unit; `free_rsvp` marks them.
- **Low-confidence display**: dotted “?” chips (current recommendation) vs. family-only. Decide after the first
  user test; the data supports both.
- **Artist profiles** (Discogs / MusicBrainz cron writing `artist_genre_profile`) are phase 2; the evidence
  bundle and the merge already read them when present.
- **Venue / promoter priors** drive most vibe chips and were seeded from public information; `phone_policy` and
  all-ages hours should be verified against venue sites before the chips ship.
- **API-side enum enforcement**: `@anthropic-ai/sdk` 0.125's `zodOutputFormat()` keeps only type / properties /
  required / `additionalProperties: false` / `minItems` 0|1 in the JSON schema it sends and folds `enum` and
  `maxItems` into property descriptions, so the API grammar does not itself restrict genre / vibe codes or the 1–5
  bins. The SDK's client-side zod parse plus `classifyEvent`'s `safeParse` reject anything off-taxonomy (the event
  falls back to rules-only with `needs_review`). If a stray code ever shows up in `classification_run.error`, the
  fix is to hand `output_config.format` a hand-built JSON schema with real `enum` arrays instead of `zodOutputFormat`.

## When the primary runs out

Free tiers have a daily wall, and NOCT hit Gemini's. `createClientChain()` builds the primary followed by any
fallback whose key is configured, and the runner walks that list **per event**: a backend that answers "out of
quota" is skipped for the rest of the run, and the next one is asked instead. Only when every backend is spent
does the run stop — and even then the event is left *pending*, never written with a rules-only result under a
fresh `input_hash`, which would park it until its inputs changed.

```
NOCT_LLM_*            primary (currently Gemini 3.6 Flash)
GROQ_API_KEY          -> groq / openai-gpt-oss-120b
NOCT_LLM_FALLBACK_*   -> any other OpenAI-compatible endpoint (BASE_URL / API_KEY / MODEL)
```

**A per-minute ceiling is not a daily wall.** Groq answers `tokens per minute (TPM): Limit 8000 ... try again
in 13.14s`; the first version of this treated that as exhaustion and threw the backend away for the whole run.
`isPerMinuteLimit()` now separates the two, and a per-minute limit is handled as a transient hiccup.

**Groq's free tier is 1,000 requests/day but only 8,000 tokens/minute**, and a 429 counts the *reservation* —
prompt plus `max_tokens`. The 6000 default (headroom for Gemini's thinking) reserved ~7.7k of the 8k by
itself, capping throughput at one call a minute. Groq therefore defaults to `max_tokens: 2500` and a 32s
spacing. Measured: 5 events classified in 3m45s, all on Groq, with Gemini exhausted.

## Vibe is a mood, not a door policy

The taxonomy has always split vibes by `kind` — `crowd`, `space`, `format`, `time`, `policy` — and the feed
was shipping all five. The result was that the most-assigned vibe in the city was **`21+`, on 1,098 of ~1,600
events**, which says nothing about the night and is already its own row in the event sheet. Free / RSVP,
Pricey and Cheaper early are in the price label. The mood words were there — Underground (227), Intimate
(125), Mainstream (111), Warehouse (85), Basement (60) — just outnumbered.

`moodVibes()` now drops `policy` (keeping `phone_free` and `sober_friendly`, which describe the room's culture
rather than its paperwork) and orders the rest **crowd → space → format → time**, so the answer reads
`Underground · Local crews · Intimate · Basement` instead of `21+ · Free / RSVP · Ends early`.

**This is where the model earns its keep**, and the numbers say so:

| | events | with a mood vibe | logistics only |
| --- | --- | --- | --- |
| classified by the LLM | 568 | **62.3%** | 33.1% |
| rules only (`provisional/`) | 957 | 41.3% | 44.3% |

Rules can read a door time and a ticket price off a listing. Whether a night is underground or mainstream,
a warehouse or a listening room, is a judgement — so mood coverage rises by half once the model reaches an
event, and 957 upcoming events are still waiting on the free tier's daily quota.
