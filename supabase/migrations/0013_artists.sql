-- NOCT 0013: artist linking, and a correction to 0009.
--
-- 1. going_count goes back to owner privileges. 0005 made it an owner-privilege view on purpose: it aggregates
--    rows nobody may read one by one and exposes only (event_id, n). 0009 set security_invoker on it along with
--    the other read models, which would make a signed-in client see only its OWN going rows — i.e. a count of 1
--    or 0 on every event. /api/feed reads as the owner so nothing broke in production, but the client wiring
--    lands next, so put it back.
--
-- 2. Artists. 0002 shipped `artist`, `artist_alias`, `artist_external_id` and `event_artist` plus
--    parse_lineup_item() (b2b/b3b splitting, "(live)", "(US)"), but nothing ever wrote to them: line-ups lived
--    only as text in listing.lineup_raw / event.lineup. Artist identity is the strongest signal a nightlife
--    recommender has ("you went to three nights with dub-techno residents"), and it also unlocks "this DJ's
--    next gigs", so resolve the canonical event line-up into artist rows.
--
--    Matching is deliberately conservative: curated alias first, then exact normalised name + country
--    disambiguator. No trigram/phonetic guessing — merging two different artists is far worse than leaving two
--    rows for the same one, and artist_alias exists to fix those by hand. Placeholders ("TBA", "Special Guest")
--    are skipped so they never become an artist everyone has "seen".
set search_path = public, extensions;

------------------------------------------------------------------------------
-- 1. Correction to 0009
------------------------------------------------------------------------------
do $$
begin
  if current_setting('server_version_num')::int >= 150000 and to_regclass('public.going_count') is not null then
    execute 'alter view public.going_count reset (security_invoker)';
  end if;
end $$;
comment on view going_count is
  'Public per-event count of users marked going. Owner-privilege view ON PURPOSE (see 0005/0013): it exposes a count, never a row. Do not set security_invoker on it.';

------------------------------------------------------------------------------
-- 2. Artist resolution
------------------------------------------------------------------------------
-- Line-up entries that name no one. Kept narrow: only strings that are placeholders on their own.
create or replace function is_placeholder_artist(p_norm text) returns boolean
language sql immutable parallel safe as $$
  select p_norm is null or p_norm in (
    'tba','tbc','to be announced','to be confirmed','special guest','special guests','surprise guest',
    'surprise guests','secret guest','secret guests','guest','guests','more','many more','and more',
    'plus more','special guest tba','residents','resident','vip','live','dj','djs','support','open decks'
  )
$$;

-- Find or create the artist for one parsed line-up name. Null when the name is a placeholder or too short to
-- be safely distinctive ("K", "&") — those stay text on the event and never gain an identity.
create or replace function resolve_artist(p_name text, p_disambig text default null) returns uuid
language plpgsql as $$
declare n text := norm_text(p_name); v uuid;
begin
  if n is null or length(n) < 2 or is_placeholder_artist(n) then return null; end if;
  -- curated redirects win: artist_alias is how a human merges "Floorplan" spellings after the fact
  select a.artist_id into v from artist_alias a where a.alias_norm = n;
  if v is not null then return v; end if;
  insert into artist (name, disambig) values (trim(p_name), nullif(trim(coalesce(p_disambig,'')), ''))
  on conflict (name_norm, coalesce(disambig,'')) do update set name = artist.name   -- no-op, so RETURNING fires
  returning artist_id into v;
  return v;
end $$;

-- event.lineup is the best line-up among the event's live listings (refresh_event picks it). Rebuild
-- event_artist from it and stamp lineup_key so unchanged events are skipped on the next run.
alter table event add column if not exists lineup_key text;
comment on column event.lineup_key is 'md5 of event.lineup when event_artist was last rebuilt; null/stale means link_pending_artists() should revisit it.';

create or replace function link_event_artists(p_event_id uuid) returns int
language plpgsql as $$
declare r record; v uuid; n int := 0;
begin
  delete from event_artist where event_id = p_event_id;
  for r in
    select p.name_display, p.disambig, p.is_live, p.group_pos, li.ord::int as ord
    from event e, unnest(e.lineup) with ordinality as li(item, ord),
         lateral parse_lineup_item(li.item) p
    where e.event_id = p_event_id
    order by li.ord, p.group_pos
  loop
    v := resolve_artist(r.name_display, r.disambig);
    if v is not null then
      -- an artist billed twice on one night (b2b plus a solo set) keeps its first, highest billing
      insert into event_artist (event_id, artist_id, position, group_pos, is_live)
      values (p_event_id, v, r.ord, r.group_pos, r.is_live)
      on conflict (event_id, artist_id) do nothing;
      n := n + 1;
    end if;
  end loop;
  update event set lineup_key = md5(coalesce(array_to_string(lineup, '|'), '')) where event_id = p_event_id;
  return n;
end $$;

-- Walk events whose line-up changed (or was never linked). Called by the ingest runner after resolve_pending();
-- newest nights first so a capped run keeps the upcoming feed correct.
create or replace function link_pending_artists(p_limit int default 5000) returns int
language plpgsql as $$
declare r record; n int := 0;
begin
  for r in
    select event_id from event
    where merged_into is null
      and lineup_key is distinct from md5(coalesce(array_to_string(lineup, '|'), ''))
    order by night desc
    limit p_limit
  loop
    perform link_event_artists(r.event_id);
    n := n + 1;
  end loop;
  return n;
end $$;

create index if not exists event_artist_artist_idx on event_artist (artist_id);
create index if not exists event_lineup_pending_idx on event (night desc) where merged_into is null and lineup_key is null;

------------------------------------------------------------------------------
-- 3. Privileges. 0007 revokes EXECUTE in public from anon/authenticated; functions added later must do the same
--    for themselves or Supabase's default privileges expose them through PostgREST as /rpc/.
------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'is_placeholder_artist(text)', 'resolve_artist(text,text)', 'link_event_artists(uuid)', 'link_pending_artists(integer)'
  ] loop
    execute format('revoke execute on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke execute on function %s from anon, authenticated', f);
    end if;
  end loop;
end $$;
