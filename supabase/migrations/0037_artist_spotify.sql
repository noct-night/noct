-- NOCT 0037: how big a name is, from Spotify, so a post can lead with the ones people are coming for.
--
-- RA's "interested" counts an event, not an artist: a headliner announced yesterday can sit under a local party
-- that has been on sale for a month. Spotify's follower count is the only public number NOCT has that is about
-- the artist, so it is what ranks "Coming to New York" -- and, like every other volatile number, it ranks and is
-- never printed on a post.
--
-- One row per artist, hits and misses alike (found = false), so a name is not searched again for sixty days;
-- src/enrich/artist_spotify.ts does the looking up inside a time budget. `confident` is false when the match is
-- a guess rather than a name Spotify spells the same way we do -- the studio says so before such a post is
-- approved, because publishing the wrong Anna is a correction in public.
--
-- Spotify's terms: the Client Credentials flow, no user data, attribute Spotify where content is shown. NOCT
-- stores the number, the id and the profile URL; no audio, no images.
--
-- Owner-read only, like artist_track (0029): nothing here is for anon.
set search_path = public, extensions;

create table if not exists artist_spotify (
  artist_id   uuid primary key references artist(artist_id) on delete cascade,
  found       boolean not null,
  spotify_id  text,
  name        text,          -- Spotify's own spelling, so a wrong match can be seen for what it is
  followers   integer,
  popularity  smallint,      -- Spotify's own 0-100 score, kept beside followers for ranking
  genres      text[],
  url         text,          -- open.spotify.com/artist/...
  confident   boolean not null default true,
  checked_at  timestamptz not null default now(),
  check (not found or (spotify_id is not null and name is not null and followers is not null))
);
create index if not exists artist_spotify_checked_idx on artist_spotify (checked_at);
create index if not exists artist_spotify_followers_idx on artist_spotify (followers desc) where found;
comment on table artist_spotify is 'Spotify follower counts per artist, for ranking only. found=false rows are remembered misses; confident=false means the name match is a guess.';

alter table artist_spotify enable row level security;
revoke all on artist_spotify from public, anon, authenticated;
