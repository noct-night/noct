-- NOCT 0026: the Instagram posts.
--
-- One row per post, not per slide: a carousel publishes as a single unit and is approved as a single unit,
-- so the slides ride along as jsonb. They are display data (a headline, a venue, a flyer URL), never the
-- authority for anything -- the events themselves already live in `event`, and a post is a snapshot of how
-- the feed read at drafting time. Editing a slide must not rewrite history in the feed, and it does not.
--
-- Nothing here is readable through PostgREST. The review page is served by /api/posts behind a studio
-- session (api/_lib/studio.ts) and reaches Postgres as the pool owner; anon and authenticated get nothing.
-- A table anybody could read is a table anybody could learn the posting schedule from, and a table anybody
-- could write is a table anybody could put words in NOCT's mouth.
set search_path = public, extensions;

------------------------------------------------------------------------------
-- 1. Posts
------------------------------------------------------------------------------
-- status is the review state machine: queued -> approved -> posted, or queued -> passed.
-- 'posted' is terminal. The publish path refuses anything that is not 'approved', so an accidental PATCH
-- cannot move a passed post to the account without going through approval first.
create table if not exists ig_post (
  post_id    uuid primary key default gen_random_uuid(),
  -- 'weekend' is the recurring deck tied to the feed; 'venues' is evergreen and reusable any time.
  series     text not null default 'weekend' check (series in ('weekend','venues','single')),
  -- The night the deck is about (the Friday of the weekend), not when it goes out. Null for evergreen.
  slot       date,
  status     text not null default 'queued' check (status in ('queued','approved','passed','posted')),
  caption    text not null default '',
  -- [{template, data}] in the order they are swiped. Instagram caps a carousel at 10.
  slides     jsonb not null default '[]'::jsonb,
  -- Treatment is per post, not per slide: one look across a deck is the whole point of having one.
  treatment  text not null default 'mono' check (treatment in ('none','mono','crush','warm')),
  grain      boolean not null default false,
  -- Set once the Graph API accepts the carousel. ig_media_id is the published media, not the container.
  ig_media_id  text,
  ig_permalink text,
  posted_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint ig_post_slides_is_array check (jsonb_typeof(slides) = 'array'),
  constraint ig_post_slides_fit_carousel check (jsonb_array_length(slides) <= 10),
  -- Instagram's own caption ceiling. Worth enforcing here too: the 400 comes back before a publish burns
  -- one of the 100 daily API posts on a caption the Graph API would reject anyway.
  constraint ig_post_caption_len check (char_length(caption) <= 2200),
  constraint ig_post_posted_has_media check (status <> 'posted' or ig_media_id is not null)
);

-- The studio lists by slot, newest first, filtered by status. One index covers both.
create index if not exists ig_post_slot_idx on ig_post (slot desc nulls last, created_at desc);
create index if not exists ig_post_status_idx on ig_post (status);

-- At most one weekend deck per weekend. Re-drafting the same Friday updates in place rather than stacking
-- near-identical decks for her to tell apart; a passed deck still holds the slot, which is the point of
-- passing one. Partial so the evergreen series (slot null) is unconstrained.
create unique index if not exists ig_post_one_weekend_per_slot
  on ig_post (series, slot) where slot is not null and series = 'weekend';

drop trigger if exists ig_post_touch on ig_post;
create trigger ig_post_touch before update on ig_post for each row execute function touch_updated_at();

------------------------------------------------------------------------------
-- 2. Publish attempts
------------------------------------------------------------------------------
-- Same shape of record as ingest_run and classification_run: what was tried, what came back, what it cost.
-- A carousel is three or more Graph API calls (one container per slide, one for the carousel, one publish)
-- and any of them can fail halfway, leaving orphaned containers. Those ids are only recoverable from here.
create table if not exists ig_publish_run (
  run_id       uuid primary key default gen_random_uuid(),
  post_id      uuid not null references ig_post(post_id) on delete cascade,
  status       text not null check (status in ('running','succeeded','failed')),
  -- Container ids in slide order, then the carousel container. Kept on failure on purpose: an unpublished
  -- container expires on its own in 24 h, but knowing it existed is what explains a half-finished attempt.
  child_ids    text[] not null default '{}',
  container_id text,
  media_id     text,
  error        text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index if not exists ig_publish_run_post_idx on ig_publish_run (post_id, started_at desc);

------------------------------------------------------------------------------
-- 3. Lock both tables down
------------------------------------------------------------------------------
-- RLS on with no policies: closed to every PostgREST role, open to the owner the API pool connects as.
-- 0005 uses the same shape for the tables only their owner should touch.
alter table ig_post        enable row level security;
alter table ig_publish_run enable row level security;
revoke all on ig_post, ig_publish_run from anon, authenticated;

comment on table ig_post is
  'Instagram posts. Server-side only: reached through /api/posts behind a studio session, never PostgREST.';
comment on table ig_publish_run is
  'One row per publish attempt. Holds the Graph API container ids so a half-finished carousel is explainable.';
