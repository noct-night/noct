-- NOCT 0029: a representative track per artist, so every name on a line-up can be heard.
--
-- The night's DICE track (0024) reaches one artist on one night in three. For the rest, Apple's iTunes Search
-- API gives a 30-second preview per song with no key: NOCT searches the artist's name, keeps the top result
-- only when Apple's artist name is exactly ours (accents folded) and the genre is not something no DJ is filed
-- under, and stores the URLs -- never the audio. Apple's terms for the previews: streamed, not downloaded or
-- cached; shown as promotion next to a link to the track on Apple Music; credited "courtesy of Apple Music".
-- src/enrich/artist_tracks.ts does the looking up, at Apple's ~20 calls a minute, inside the daily crons'
-- time budget; misses are stored too (found = false) so a name is not searched again for sixty days.
--
-- Owner-read only: the feed joins it from the pooled connection (EVENTS_COLUMNS_SQL); nothing here is for anon.
set search_path = public, extensions;

create table if not exists artist_track (
  artist_id  uuid primary key references artist(artist_id) on delete cascade,
  found      boolean not null,
  platform   text check (platform in ('apple')),
  title      text,
  url        text,          -- the track on music.apple.com
  preview    text,          -- Apple's 30 s clip (audio-ssl.itunes.apple.com / *.mzstatic.com)
  genre      text,          -- Apple's primaryGenreName, kept for the exclusion rule and for review
  apple_id   bigint,        -- trackId, so a later lookup can refresh without a search
  checked_at timestamptz not null default now(),
  check (not found or (platform is not null and title is not null and url is not null and preview is not null))
);
create index if not exists artist_track_checked_idx on artist_track (checked_at);
comment on table artist_track is 'One representative track per artist from the iTunes Search API: URLs only, never audio. found=false rows are remembered misses.';

alter table artist_track enable row level security;
revoke all on artist_track from public, anon, authenticated;
