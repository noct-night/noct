-- NOCT 0003: genre / vibe enrichment — storage contract.
-- This file only defines SHAPES (columns + tables) so the ingestion, enrichment and feed layers can be
-- developed independently. Taxonomy rows, rules and the classifier live in 0004_enrichment.sql + src/enrich/.
set search_path = public, extensions;

-- Controlled genre taxonomy: hierarchical codes like 'house.deep', 'techno.dub'. family = code before the dot.
create table if not exists genre (
  code           text primary key,
  family         text not null,                    -- 'house', 'techno', 'trance', ...
  label          text not null,                    -- 'Deep House'
  description    text,
  ra_names       text[] not null default '{}',     -- RA genre names that map here ('Deep House')
  dice_tags      text[] not null default '{}',     -- DICE genre_tags suffixes ('deephouse')
  discogs_styles text[] not null default '{}',     -- Discogs style names ('Deep House')
  aliases        text[] not null default '{}',     -- free-text synonyms for title/description matching
  sort           int not null default 0
);
create index if not exists genre_family_idx on genre (family);

-- Vibe vocabulary: multi-select tags grouped by kind (space, time, format, crowd, policy).
create table if not exists vibe (
  code        text primary key,                    -- 'dark_warehouse', 'sunny_day_party', 'free_rsvp'
  kind        text not null check (kind in ('space','time','format','crowd','policy')),
  label       text not null,
  glyph       text,                                -- short emoji/symbol for chips
  description text,
  sort        int not null default 0
);

-- Per-event tags with provenance. One row per (event, kind, code).
create table if not exists event_tag (
  event_id    uuid not null references event(event_id) on delete cascade,
  kind        text not null check (kind in ('genre','vibe')),
  code        text not null,
  confidence  numeric(3,2) not null default 0.50 check (confidence between 0 and 1),
  -- [{"source":"ra"|"dice"|"discogs"|"rule:<id>"|"venue_prior"|"promoter_prior"|"llm"|"community", "evidence":"...", "weight":0.4}]
  sources     jsonb not null default '[]',
  status      text not null default 'auto' check (status in ('auto','confirmed','community','rejected')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (event_id, kind, code)
);
create index if not exists event_tag_code_idx on event_tag (kind, code) where status <> 'rejected';

-- Denormalised enrichment output on the canonical event (what the feed reads).
alter table event
  add column if not exists primary_genre          text references genre(code),
  add column if not exists genre_codes            text[] not null default '{}',   -- ordered, best first (<= 3)
  add column if not exists genre_confidence       numeric(3,2),
  add column if not exists vibe_codes             text[] not null default '{}',
  add column if not exists energy                 smallint check (energy between 1 and 5),
  add column if not exists darkness               smallint check (darkness between 1 and 5),
  add column if not exists crowd_size             smallint check (crowd_size between 1 and 5),
  add column if not exists start_lateness         smallint check (start_lateness between 1 and 5),
  add column if not exists end_lateness           smallint check (end_lateness between 1 and 5),
  add column if not exists price_tier             smallint check (price_tier between 0 and 4),
  add column if not exists underground_index      smallint check (underground_index between 1 and 5),
  add column if not exists sound_summary          text,                            -- <= 20 words, human-facing
  add column if not exists is_electronic          boolean,                         -- false = classifier says not a rave/club night
  add column if not exists needs_review           boolean not null default false,
  add column if not exists classification_version text,                            -- prompt/rules version that produced the above
  add column if not exists classified_at          timestamptz,
  add column if not exists input_hash             text;                            -- sha256 of the enrichment inputs; re-run when it changes
create index if not exists event_enrich_pending_idx on event (night) where merged_into is null and classified_at is null;
create index if not exists event_primary_genre_idx on event (primary_genre) where merged_into is null;

-- Venue priors used by the rules engine (curated by hand; seeded in 0006).
alter table venue
  add column if not exists space_types      text[] not null default '{}',   -- 'warehouse','basement','club','outdoor_yard','rooftop','boat','art_space','bar'
  add column if not exists outdoor          boolean,
  add column if not exists phone_policy     text check (phone_policy in ('none','no_photos','pouch')),
  add column if not exists typical_genres   text[] not null default '{}',   -- genre codes
  add column if not exists vibe_priors      text[] not null default '{}',   -- vibe codes
  add column if not exists underground_prior smallint check (underground_prior between 1 and 5),
  add column if not exists notes            text;

-- Promoters / series priors (Mister Sunday, Teksupport, Nowadays, ...). Matched by alias against listing.promoters and titles.
create table if not exists promoter (
  promoter_id   uuid primary key default gen_random_uuid(),
  name          text not null,
  name_norm     text generated always as (norm_text(name)) stored,
  aliases       text[] not null default '{}',
  genre_priors  text[] not null default '{}',    -- genre codes
  vibe_priors   text[] not null default '{}',    -- vibe codes
  underground_prior smallint check (underground_prior between 1 and 5),
  website       text, instagram text, ra_url text,
  notes         text
);
create unique index if not exists promoter_name_norm_uq on promoter (name_norm);
