-- NOCT 0034: more than one post per weekend.
--
-- Until now a post was identified by its series and its date, which was enough when the only recurring post
-- was the weekend deck. Genre editions break that: "house this weekend" and "techno this weekend" share a
-- series and a Friday, so drafting the second would have overwritten the first. `edition` says which one --
-- a genre family, an event id -- and drafting the same edition again updates it in place.
--
-- Series gains 'genre' now, and 'artists' for the Coming to New York post that follows. Additive only: no
-- existing row changes, and every statement is safe to run twice.
set search_path = public, extensions;

alter table ig_post drop constraint if exists ig_post_series_check;
alter table ig_post add constraint ig_post_series_check
  check (series in ('weekend', 'venues', 'single', 'genre', 'artists'));

alter table ig_post add column if not exists edition text;
comment on column ig_post.edition is
  'Which post within a series and slot: a genre family, an event id, a venue. Null for the weekend deck and reels.';

-- One post per edition per slot. Partial, so the weekend deck and reels (edition null) are governed by the
-- rules they already had. The slot is coalesced because evergreen posts have none, and two venue posts for
-- the same venue should still collide.
create unique index if not exists ig_post_one_per_edition
  on ig_post (series, coalesce(slot, '0001-01-01'::date), edition)
  where edition is not null;
