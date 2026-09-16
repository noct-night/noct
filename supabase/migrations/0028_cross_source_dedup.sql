-- NOCT 0028: one night, one card -- the merge layer's three open seams.
--
-- The cross-source layer already exists end to end (nine adapters, scored entity resolution, priority-based
-- canonical record). What still showed one night as two cards, measured on 2026-09-15:
--
--  1. RA files a night at "TBA" while 19hz or DICE name the room: the venue term for a placeholder is 0.4, so an
--     exact title on the same night stalled at 0.73, under the 0.78 auto threshold. Chicago Hideaway nights
--     (Brandon, Anton Khabbaz, Freenzy, Skilah, Zoe Gitter) were each two cards. Now: exact title + same night +
--     one side a placeholder clears the threshold.
--  2. resolve_venue()'s trigram branch measured how well the EXISTING name's words appear in the incoming one, so
--     an incoming "El Rey" never found "El Rey Theatre" and a provisional "El Rey" row was born. Now both
--     directions count (the reverse only for names of six characters or more, so "Sound" cannot claim "Sound
--     Nightclub" by accident -- well, it can, and should; "Bar" cannot claim "Bar Lubitsch").
--  3. Nothing ever moved a listing after the fact. rematch_listing() re-resolves one listing against every
--     event but its own; when it moves and leaves its old event with no live listing, that event is marked
--     merged_into the survivor -- the first honest use of the column -- and going / saved / rec_feedback rows
--     travel with it, so nobody loses a night they marked. merge_venue() folds one venue under another (as a
--     room of its family) and rematches what was there.
--
-- platform_host() names the ticketing platform behind a listing by URL host, so "listed on two platforms" is
-- counted by host (DICE's listing and SILO's dice.fm link are one platform), not by adapter.
--
-- Two merges are seeded at the end, both from the data's own evidence: RA files "Indo Warehouse at Cermak Hall"
-- under Radius (640 W Cermak Rd), and the only "El Rey" in Los Angeles is the El Rey Theatre on Wilshire. They
-- run only when both rows exist. Undo: clear the room's parent_venue_id, drop the alias, rematch its listings.
set search_path = public, extensions;

------------------------------------------------------------------------------
-- 1. Placeholder venues do not keep an identical night apart
------------------------------------------------------------------------------
create or replace function score_listing_event(p_listing_id bigint, p_event_id uuid)
returns table(score real, features jsonb)
language plpgsql stable as $$
declare l listing%rowtype; e event%rowtype;
        s_venue real; s_date real; s_title real; s_lineup real; hard boolean; placeholder boolean;
        w_v real; w_t real; w_l real; w_d real; s real;
begin
  select * into l from listing where listing_id = p_listing_id;
  select * into e from event   where event_id   = p_event_id;
  hard := exists (
    select 1 from jsonb_array_elements(l.external_refs) r
    where (r->>'source', r->>'id') in (select li.source_key, li.source_id from listing li where li.event_id = e.event_id)
  ) or exists (
    select 1 from jsonb_array_elements(e.external_refs) r
    where r->>'source' = l.source_key and r->>'id' = l.source_id
  );
  s_date   := date_sim(l.starts_at, l.has_time, l.night, e.starts_at, e.has_time, e.night);
  s_venue  := venue_sim(l.venue_id, e.venue_id);
  s_title  := title_sim(l.title_sim_key, e.title_sim_key);
  s_lineup := lineup_sim(l.lineup_norm, e.lineup_norm);
  placeholder := exists (select 1 from venue vv where vv.venue_id in (l.venue_id, e.venue_id) and vv.kind in ('tba','secret'));
  if hard then
    s := 1.0;
  elsif s_date = 0 then
    s := 0;
  elsif l.venue_id is not null and e.venue_id is not null and s_venue = 0 then
    s := 0;
  else
    w_v := 0.30; w_t := 0.30; w_l := 0.30; w_d := 0.10;
    if cardinality(l.lineup_norm) = 0 or cardinality(e.lineup_norm) = 0 then w_l := 0; w_t := 0.45; w_v := 0.45; end if;
    if l.venue_id is null or e.venue_id is null then w_v := 0; w_t := w_t + 0.15; w_l := w_l + 0.15; end if;
    s := w_v*s_venue + w_t*s_title + w_l*s_lineup + w_d*s_date;
    if s_lineup >= 0.75 and s_venue >= 0.9 and s_date >= 0.8 then s := greatest(s, 0.85); end if;
    if s_date < 0.8 then s := least(s, 0.77); end if;
    -- "TBA" is not a different room; the same title the same night IS the night (0028)
    if placeholder and s_title >= 0.95 and s_date >= 0.8 then s := greatest(s, 0.80); end if;
  end if;
  return query select s::real, jsonb_build_object('hard_link', hard, 'date', s_date, 'venue', s_venue, 'title', s_title, 'lineup', s_lineup,
                                                  'placeholder', placeholder,
                                                  'l_lineup_n', cardinality(l.lineup_norm), 'e_lineup_n', cardinality(e.lineup_norm));
end $$;

------------------------------------------------------------------------------
-- 2. A short name finds the long one it is part of
------------------------------------------------------------------------------
create or replace function resolve_venue(p_source_key text, p_source_venue_id text, p_name text, p_city text default 'nyc')
returns table(venue_id uuid, method text, score real)
language plpgsql stable as $$
declare n text := norm_text(p_name); long boolean;
begin
  if p_source_venue_id is not null then
    return query select x.venue_id, 'external_id'::text, 1.0::real from venue_external_id x
      where x.source_key = p_source_key and x.source_id = p_source_venue_id;
    if found then return; end if;
  end if;
  if n is null then return; end if;
  return query select a.venue_id, 'alias_exact'::text, 1.0::real from venue_alias a join venue v on v.venue_id = a.venue_id where a.alias_norm = n and v.city = p_city limit 1;
  if found then return; end if;
  return query select v.venue_id, 'name_exact'::text, 1.0::real from venue v where v.name_norm = n and v.city = p_city limit 1;
  if found then return; end if;
  if length(n) < 4 then return; end if;
  long := length(n) >= 6;   -- the reverse direction ("el rey" inside "el rey theatre") only for names with some substance
  return query
    select s.venue_id, 'trgm'::text, s.sim::real from (
      select a.venue_id, greatest(extensions.similarity(a.alias_norm, n),
                                  extensions.word_similarity(a.alias_norm, n) * 0.95,
                                  case when long then extensions.word_similarity(n, a.alias_norm) * 0.95 else 0 end) as sim
      from venue_alias a join venue va on va.venue_id = a.venue_id
      where va.city = p_city and (a.alias_norm % n or a.alias_norm <% n or (long and n <% a.alias_norm))
      union all
      select v.venue_id, greatest(extensions.similarity(v.name_norm, n),
                                  extensions.word_similarity(v.name_norm, n) * 0.95,
                                  case when long then extensions.word_similarity(n, v.name_norm) * 0.95 else 0 end)
      from venue v where v.city = p_city and (v.name_norm % n or v.name_norm <% n or (long and n <% v.name_norm))
    ) s where s.sim >= 0.55 order by s.sim desc limit 1;
end $$;

------------------------------------------------------------------------------
-- 3. Moving a listing after the fact, and folding a venue
------------------------------------------------------------------------------
-- Re-resolve one live listing against every canonical event except the one it is on. Moves only for a score at
-- or above the auto threshold. If its old event is left with no live listing, that event is marked merged_into
-- the survivor and its marks (going / saved / rec_feedback) are carried over. Returns what happened.
create or replace function rematch_listing(p_listing_id bigint, p_auto_threshold real default 0.78)
returns table(from_event uuid, to_event uuid, method text, score real)
language plpgsql as $$
#variable_conflict use_column
declare l listing%rowtype; old uuid; best record; v_method text;
begin
  select * into l from listing where listing_id = p_listing_id;
  if not found or l.gone_at is not null then return; end if;
  old := l.event_id;

  select e.event_id, s.score, s.features into best
  from event e, lateral score_listing_event(l.listing_id, e.event_id) s
  where e.merged_into is null and e.status <> 'removed'
    and e.event_id is distinct from old
    and e.city = l.city
    and e.night between l.night - 1 and l.night + 1
    and (
         (l.venue_id is not null and e.venue_id is not null and venue_family(l.venue_id) = venue_family(e.venue_id))
      or l.venue_id is null or e.venue_id is null
      or exists (select 1 from venue vv where vv.venue_id in (l.venue_id, e.venue_id) and vv.kind in ('tba','secret'))
      or e.title_sim_key % l.title_sim_key
      or e.external_refs @> jsonb_build_array(jsonb_build_object('source', l.source_key, 'id', l.source_id))
    )
  order by s.score desc, e.created_at
  limit 1;

  if best.event_id is null or best.score < p_auto_threshold then
    return query select old, old, 'kept'::text, null::real;
    return;
  end if;

  v_method := case when (best.features->>'hard_link')::boolean then 'external_ref' when best.score >= 0.999 then 'exact' else 'fuzzy' end;
  update listing set event_id = best.event_id, match_score = best.score, match_method = v_method, matched_at = now()
  where listing_id = l.listing_id;
  insert into match_candidate(listing_id, event_id, score, features, decision, decided_at)
  values (l.listing_id, best.event_id, best.score, best.features, 'auto_merged', now())
  on conflict (listing_id, event_id) do update set score = excluded.score, features = excluded.features, decision = 'auto_merged', decided_at = now();

  -- the emptied event first: once it is marked merged_into, the dupe guard (partial on merged_into is null)
  -- no longer holds its title at this venue, and the survivor may take that title on refresh
  if old is not null then
    perform refresh_event(old);                                   -- no live listing left -> status 'removed'
    if not exists (select 1 from listing x where x.event_id = old and x.gone_at is null) then
      update event set merged_into = best.event_id where event_id = old;
      insert into going (user_id, event_id, created_at) select g.user_id, best.event_id, g.created_at from going g where g.event_id = old on conflict do nothing;
      insert into saved (user_id, event_id, created_at) select s.user_id, best.event_id, s.created_at from saved s where s.event_id = old on conflict do nothing;
      insert into rec_feedback (user_id, event_id, action, created_at) select f.user_id, best.event_id, f.action, f.created_at from rec_feedback f where f.event_id = old on conflict do nothing;
    end if;
  end if;
  begin
    perform refresh_event(best.event_id);
  exception when unique_violation then
    null;   -- a still-live twin holds the refreshed title at this venue; the move stands, the next ingest refreshes
  end;
  return query select old, best.event_id, v_method, best.score::real;
end $$;
comment on function rematch_listing(bigint, real) is
  'Re-resolve one live listing against every other canonical event; move it when a better match clears the auto threshold, mark an emptied event merged_into the survivor and carry going/saved/rec_feedback with it.';

-- Fold one venue into another. The old row is not deleted -- it becomes a room of the survivor's family, so
-- the nights that stay on it read "Radius · Cermak Hall" -- but its names and external ids now resolve to the
-- survivor, its listings move there and are re-resolved, which is what folds "the same night at both names"
-- into one card (same family scores 0.9 on venue; an identical title takes it over the threshold).
create or replace function merge_venue(p_from uuid, p_into uuid)
returns table(listing_id bigint, from_event uuid, to_event uuid, method text, score real)
language plpgsql as $$
#variable_conflict use_column
declare v_from venue%rowtype; v_into venue%rowtype; fam uuid; moved bigint[]; ev uuid;
begin
  if p_from is null or p_into is null or p_from = p_into then return; end if;
  select * into v_from from venue where venue_id = p_from; if not found then return; end if;
  select * into v_into from venue where venue_id = p_into; if not found then return; end if;
  if v_into.parent_venue_id = p_from then return; end if;          -- never fold a family under its own room
  fam := coalesce(v_into.parent_venue_id, p_into);

  update venue set parent_venue_id = fam where venue_id = p_from;
  update venue set parent_venue_id = fam where parent_venue_id = p_from and venue_id <> p_from;
  update venue_alias set venue_id = p_into where venue_id = p_from;
  insert into venue_alias (alias_norm, alias, venue_id, kind, source_key)
  values (v_from.name_norm, v_from.name, p_into, 'former_name', null)
  on conflict (alias_norm) do nothing;
  update venue_external_id set venue_id = p_into where venue_id = p_from;   -- keyed by (source, id): never collides

  select coalesce(array_agg(l.listing_id), '{}') into moved from listing l where l.venue_id = p_from and l.gone_at is null;
  update listing set venue_id = p_into where venue_id = p_from;
  return query
    select m.id, r.from_event, r.to_event, r.method, r.score
    from unnest(moved) as m(id), lateral rematch_listing(m.id) r;

  -- nights with nothing to fold into follow their listings to the main row; one that would collide with a
  -- differently-timed twin (the dupe guard) simply stays on the room, which is in the family anyway
  for ev in select e.event_id from event e where e.venue_id = p_from and e.merged_into is null loop
    begin
      perform refresh_event(ev);
    exception when unique_violation then null;
    end;
  end loop;
end $$;
comment on function merge_venue(uuid, uuid) is
  'Fold venue p_from into p_into: p_from becomes a room of p_into''s family, its names/external ids resolve to p_into, its listings move there and are re-resolved so a night listed under both names becomes one card.';

------------------------------------------------------------------------------
-- 4. Which platform is this listing really on
------------------------------------------------------------------------------
create or replace function platform_host(p_source_key text, p_url text) returns text
language sql immutable parallel safe as $$
  select case
    when p_url ~* '(^|[./])dice\.fm/'                    then 'dice.fm'
    when p_url ~* '(^|[./])ra\.co/'                      then 'ra.co'
    when p_url ~* '(^|[./])eventbrite\.'                 then 'eventbrite.com'
    when p_url ~* '(^|[./])ticketmaster\.'               then 'ticketmaster.com'
    when p_url ~* '(^|[./])axs\.com/'                    then 'axs.com'
    when p_url ~* '(^|[./])posh\.vip/'                   then 'posh.vip'
    when p_url ~* '(^|[./])shotgun\.live/'               then 'shotgun.live'
    when p_url ~* '(^|[./])tixr\.com/'                   then 'tixr.com'
    when p_url ~* '(^|[./])etix\.com/'                   then 'etix.com'
    when p_url ~* '(^|[./])eventim\.'                    then 'eventim.us'
    when p_url ~* '(^|[./])seetickets\.'                 then 'seetickets.us'
    when p_url ~* '(^|[./])resident-?advisor\.'          then 'ra.co'
    when p_source_key = 'ra'   then 'ra.co'
    when p_source_key in ('dice', 'silo') then 'dice.fm'
    when p_url ~* '^https?://' then lower(regexp_replace(substring(p_url from '^https?://([^/?#]+)'), '^www\.', ''))
    else p_source_key
  end
$$;
comment on function platform_host(text, text) is
  'The ticketing platform behind a listing, by URL host (DICE and SILO''s dice.fm links are one platform; a 19hz row is whatever it links to). For counting "listed in more than one place" honestly.';

------------------------------------------------------------------------------
-- 5. Two merges the data itself asked for
------------------------------------------------------------------------------
do $$
declare v_from uuid; v_into uuid; r record;
begin
  -- RA files "Indo Warehouse at Cermak Hall" under Radius, 640 W Cermak Rd: one building, two names
  select venue_id into v_from from venue where city = 'chi' and name = 'Cermak Hall' limit 1;
  select venue_id into v_into from venue where city = 'chi' and name = 'Radius' limit 1;
  if v_from is not null and v_into is not null then
    for r in select * from merge_venue(v_from, v_into) loop
      raise notice 'Cermak Hall -> Radius: listing % % -> % (%, %)', r.listing_id, r.from_event, r.to_event, r.method, r.score;
    end loop;
  end if;
  -- the only El Rey in Los Angeles is the theatre on Wilshire
  select venue_id into v_from from venue where city = 'la' and name = 'El Rey' limit 1;
  select venue_id into v_into from venue where city = 'la' and name = 'El Rey Theatre' limit 1;
  if v_from is not null and v_into is not null then
    for r in select * from merge_venue(v_from, v_into) loop
      raise notice 'El Rey -> El Rey Theatre: listing % % -> % (%, %)', r.listing_id, r.from_event, r.to_event, r.method, r.score;
    end loop;
  end if;
end $$;
