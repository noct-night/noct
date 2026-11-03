-- NOCT 0039: a shelf of cover photographs, kept apart from the ones a slide is already using.
--
-- Covers are chosen rather than found: she collects images over a week and picks one when the deck is
-- drafted, usually on a phone. Until now a photo only existed as an attachment to a slide, so there was
-- nowhere to put one before it had a post to belong to.
--
-- Same table, one flag: an archived photo is a photo nobody has attached yet. It carries its credit from
-- the moment it is added, because a photo whose source is remembered later is a photo whose source is lost.
set search_path = public, extensions;

alter table ig_photo add column if not exists archived boolean not null default false;
create index if not exists ig_photo_archived_idx on ig_photo (created_at desc) where archived;

comment on column ig_photo.archived is
  'True for a photo on the cover shelf: added in the studio before any post needed it. Attaching one to a slide leaves the flag alone, so it stays on the shelf for the next deck.';
