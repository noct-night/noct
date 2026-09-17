-- NOCT 0032: reels, alongside the carousel.
--
-- A reel is a post, not a slide. It shares everything that made ig_post worth having -- one review state
-- machine, one caption with the house rules applied to it, one gated publish endpoint, one audit trail in
-- ig_publish_run -- and differs only in what Meta is handed at the end: a single `video_url` with
-- media_type=REELS instead of ten `image_url` children with is_carousel_item.
--
-- So this adds a discriminator and the video's own columns rather than a second table. The alternative was
-- an ig_reel table duplicating status, caption, slot and the publish-claim transaction, which is the part
-- that is actually hard to get right and the last part worth having two copies of.
--
-- Why the video is a URL and not bytes: Meta fetches it, the same as every image_url. But a slide is
-- regenerated on demand by /api/render under an HMAC, and a 30 MB video cannot be -- so the encoded file
-- is uploaded to object storage once and this column is where it went. That is the one real structural
-- difference between the two kinds, and it is why `npm run clip` exists outside the lambda.
set search_path = public, extensions;

------------------------------------------------------------------------------
-- 1. The discriminator
------------------------------------------------------------------------------
-- 'carousel' is every row that existed before this migration, which is why it is the default: a backfill
-- would otherwise have to guess, and guessing wrong publishes the wrong media type.
alter table ig_post
  add column if not exists kind text not null default 'carousel'
    check (kind in ('carousel','reel'));

-- Where the encoded MP4 lives, and what it is. `video_meta` holds what ffprobe said about the *output*
-- (duration, dimensions, fps, bytes) so a failure to publish can be diagnosed without the file: nearly
-- every Graph API rejection of a reel is a spec violation, and these are the specs.
alter table ig_post add column if not exists video_url  text;
alter table ig_post add column if not exists cover_url  text;
alter table ig_post add column if not exists video_meta jsonb not null default '{}'::jsonb;

comment on column ig_post.kind is
  'carousel = slides as image_url children; reel = video_url with media_type=REELS.';
comment on column ig_post.video_url is
  'Public HTTPS URL of the encoded MP4. Meta fetches this itself, so it cannot be signed or gated.';
comment on column ig_post.cover_url is
  'Optional public HTTPS cover frame. Null lets Instagram pick its own.';

------------------------------------------------------------------------------
-- 2. What each kind requires
------------------------------------------------------------------------------
-- The existing slides constraints stay as they are (<= 10, array) and hold trivially for a reel's empty
-- array. What is added is the other half: a reel needs a video, a carousel needs slides, and neither can
-- be published while missing its own media.
--
-- Checked at approval rather than only at publish time because the studio's Approve button is the decision
-- point. A reel approved with no video is a Friday-night failure; a 23514 from Postgres is a Tuesday one.
alter table ig_post drop constraint if exists ig_post_kind_has_media;
alter table ig_post add constraint ig_post_kind_has_media check (
  case kind
    when 'reel'     then status in ('queued','passed') or video_url is not null
    when 'carousel' then status in ('queued','passed') or jsonb_array_length(slides) > 0
  end
);

-- A reel carries no slides and a carousel carries no video. Keeping the unused half empty means neither
-- publish path has to decide which of two populated fields it was meant to believe.
alter table ig_post drop constraint if exists ig_post_kind_media_exclusive;
alter table ig_post add constraint ig_post_kind_media_exclusive check (
  kind <> 'carousel' or (video_url is null and cover_url is null)
);

alter table ig_post drop constraint if exists ig_post_video_meta_is_object;
alter table ig_post add constraint ig_post_video_meta_is_object check (jsonb_typeof(video_meta) = 'object');

------------------------------------------------------------------------------
-- 3. The one-per-slot rule is about the weekend deck, not about reels
------------------------------------------------------------------------------
-- 0026's unique index covers (series, slot) where series = 'weekend'. A reel tied to the same Friday as
-- the weekend deck is a normal thing to want -- the deck goes out Thursday, a clip of the night goes out
-- Saturday -- and it must not collide with it. Reels use series 'single', which that index never touched,
-- so nothing here needs changing. This comment exists so the next reader does not have to re-derive it.

-- The studio lists reels separately from decks.
create index if not exists ig_post_kind_idx on ig_post (kind, created_at desc);
