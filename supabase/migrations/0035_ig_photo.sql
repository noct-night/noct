-- NOCT 0035: photos added by hand in the studio.
--
-- Venue posts need photographs the feed does not have, and an event slide sometimes needs a better picture
-- than its flyer. A person picks the photo and says where it came from; the credit is added to the caption
-- when the post publishes, so it cannot be lost by redrafting.
--
-- In Postgres rather than a storage bucket, deliberately. Photos are few (a venue each, the odd flyer) and
-- resized to a couple of hundred kilobytes, and a bucket would need a write credential inside the deployed
-- functions -- the service-role key the reels work was careful to keep off Vercel. Here the bytes travel
-- through the same gated API and the same pool as everything else in the studio.
--
-- Closed to PostgREST roles like every ig_ table. Additive only, safe to run twice.
set search_path = public, extensions;

create table if not exists ig_photo (
  photo_id   uuid primary key default gen_random_uuid(),
  -- Always JPEG, re-encoded on upload: resized, orientation applied, and metadata dropped -- a phone photo's
  -- EXIF carries where it was taken.
  bytes      bytea not null,
  width      int not null check (width > 0),
  height     int not null check (height > 0),
  -- The credit, as it will read in the caption: "Nowadays / @nowadaysnyc".
  source     text not null check (char_length(btrim(source)) between 1 and 200),
  created_at timestamptz not null default now(),
  constraint ig_photo_size check (octet_length(bytes) <= 4000000)
);

alter table ig_photo enable row level security;
revoke all on ig_photo from anon, authenticated;

comment on table ig_photo is
  'Photos attached in the studio. Referenced from slides as photo:<photo_id>. Server-side only.';
