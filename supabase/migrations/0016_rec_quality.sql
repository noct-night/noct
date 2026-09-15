-- NOCT 0016: recommendation quality — classes, diversity, and a feedback loop.
--
-- 1. Classes and karaoke nights are not nights out. `is_electronic` answers "is this electronic music", which
--    an Ableton production class at Nowadays passes. Matching has to be ANCHORED, not substring: the upcoming
--    data contains "Ivy Lab: A Farewell Tour" (a drum & bass act), "… @ Market Hotel" (a venue) and "Italo
--    Horror Disco with Street Cleaner LIVE & Dark Karaoke" (a real club night), all of which a loose
--    /lab|market|karaoke/ would wrongly throw away.
-- 2. One venue could fill the whole list; recommendations are capped per venue family.
-- 3. rec_feedback closes the loop: dismissing a recommendation removes it AND builds a negative profile that
--    demotes whatever it had in common with the rest. Opening one is a mild positive.
set search_path = public, extensions;

------------------------------------------------------------------------------
-- 1. Is this a class / workshop / karaoke night rather than a night out?
------------------------------------------------------------------------------
create or replace function event_is_class(p_title text) returns boolean
language sql immutable parallel safe as $$
  select coalesce(
       -- "Intro to Ableton Lab: …", "Introduction to modular"
       p_title ~* '^\s*intro(duction)?\s+to\M'
       -- words that essentially never appear in a party name
    or p_title ~* '\m(workshop|masterclass|seminar|lecture|artist talk|panel discussion|open rehearsal)\M'
       -- "class" alone is a plausible party name ("Working Class"), so it counts only in the plural or with a
       -- teaching noun in front of it
    or p_title ~* '\mclasses\M'
    or p_title ~* '\m(dj|production|dance|line dance|music|ableton|mixing|modular|synth|art)\s+class\M'
    or p_title ~* '\m(dj|production|music|dance)\s+lessons?\M'
    or p_title ~* '\myoga\M'
       -- karaoke only when karaoke IS the event: at the start, as "Karaoke <weekday>", or after a short label
    or p_title ~* '^\s*karaoke\M'
    or p_title ~* '\mkaraoke\s+(night|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?)\M'
    or p_title ~* '^[^:]{0,24}:\s*karaoke\M'
    or p_title ~* '^\s*(trivia|bingo|quiz)\M'
  , false)
$$;
comment on function event_is_class(text) is
  'Anchored title test for classes/workshops/karaoke nights, used to keep them out of recommendations. Deliberately conservative: a substring match would drop "Ivy Lab" and "@ Market Hotel".';

------------------------------------------------------------------------------
-- 2. Feedback on recommendations
------------------------------------------------------------------------------
create table if not exists rec_feedback (
  user_id    uuid not null,
  event_id   uuid not null references event(event_id) on delete cascade,
  action     text not null check (action in ('dismissed','opened')),
  created_at timestamptz not null default now(),
  primary key (user_id, event_id)
);
create index if not exists rec_feedback_user_idx on rec_feedback (user_id, action);

alter table rec_feedback enable row level security;
do $$
begin
  if to_regprocedure('auth.uid()') is null then
    raise notice 'auth.uid() not present: rec_feedback policy/default skipped (local Postgres)';
    return;
  end if;
  execute 'alter table rec_feedback alter column user_id set default auth.uid()';
  execute 'drop policy if exists rec_feedback_own on rec_feedback';
  execute 'create policy rec_feedback_own on rec_feedback for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())';
end $$;
revoke all on rec_feedback from anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant select, insert, update, delete on rec_feedback to authenticated';
  end if;
end $$;

------------------------------------------------------------------------------
-- 3. The scorer, with the negative profile and the per-venue cap
------------------------------------------------------------------------------
create or replace function recommend_events(
  p_limit     int  default 20,
  p_city      text default null,
  p_days      int  default 28,
  p_per_venue int  default 2     -- at most this many from one venue family, so one room cannot fill the list
) returns table (event_id uuid, score real, reasons jsonb, history_size int)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return; end if;

  return query
  with hist as (
    select e.*, 1.0::real as w, g.created_at as marked_at
    from going g join event e on e.event_id = g.event_id
    where g.user_id = v_uid and e.merged_into is null
    union all
    select e.*, 0.4::real, s.created_at
    from saved s join event e on e.event_id = s.event_id
    where s.user_id = v_uid and e.merged_into is null
    union all
    -- opening a recommendation is interest, not a decision: worth less than a bookmark
    select e.*, 0.25::real, f.created_at
    from rec_feedback f join event e on e.event_id = f.event_id
    where f.user_id = v_uid and f.action = 'opened' and e.merged_into is null
  ),
  -- what this person said no to. Same shape as the profile above, used to subtract.
  neg as (
    select e.* from rec_feedback f join event e on e.event_id = f.event_id
    where f.user_id = v_uid and f.action = 'dismissed' and e.merged_into is null
  ),
  tot  as (select count(*)::int as n, greatest(coalesce(sum(w), 0), 0.001)::real as w from hist),
  ntot as (select greatest(count(*), 1)::real as w from neg),
  city as (select coalesce(p_city, (select h.city from hist h order by h.marked_at desc limit 1), 'nyc') as key),
  g_w as (select x.code, sum(h.w) as w from hist h, unnest(h.genre_codes) as x(code) group by x.code),
  f_w as (select split_part(x.code, '.', 1) as fam, sum(h.w) as w from hist h, unnest(h.genre_codes) as x(code) group by 1),
  v_w as (select x.code, sum(h.w) as w from hist h, unnest(h.vibe_codes) as x(code) group by x.code),
  a_w as (select ea.artist_id, sum(h.w) as w from hist h join event_artist ea on ea.event_id = h.event_id group by 1),
  ven_w as (select venue_family(h.venue_id) as fam, sum(h.w) as w from hist h where h.venue_id is not null group by 1),
  ng_w  as (select x.code, count(*)::real as w from neg n, unnest(n.genre_codes) as x(code) group by x.code),
  nv_w  as (select x.code, count(*)::real as w from neg n, unnest(n.vibe_codes) as x(code) group by x.code),
  na_w  as (select ea.artist_id, count(*)::real as w from neg n join event_artist ea on ea.event_id = n.event_id group by 1),
  nven_w as (select venue_family(n.venue_id) as fam, count(*)::real as w from neg n where n.venue_id is not null group by 1),
  s_p as (
    select avg(start_lateness)::real sl, avg(end_lateness)::real el, avg(price_tier)::real pt,
           avg(underground_index)::real ui, avg(energy)::real en, avg(darkness)::real dk
    from hist
  ),
  cand as (
    select e.*
    from event e, city
    where e.merged_into is null
      and e.status = 'scheduled'
      and e.city = city.key
      and e.night between current_date and current_date + greatest(p_days, 1)
      and e.is_electronic is distinct from false
      and not event_is_class(e.title)                                  -- classes are not nights out
      and not exists (select 1 from going g where g.user_id = v_uid and g.event_id = e.event_id)
      and not exists (select 1 from saved s where s.user_id = v_uid and s.event_id = e.event_id)
      and not exists (select 1 from rec_feedback f where f.user_id = v_uid and f.event_id = e.event_id and f.action = 'dismissed')
  ),
  scored as (
    select
      c.event_id, c.night, venue_family(c.venue_id) as ven_fam,
      least(coalesce(art.w, 0) / t.w, 1)::real as s_artist,
      least(coalesce(gen.w, 0) / t.w, 1)::real as s_genre,
      least(coalesce(fam.w, 0) / t.w, 1)::real as s_family,
      least(coalesce(vib.w, 0) / t.w, 1)::real as s_vibe,
      least(coalesce(ven.w, 0) / t.w, 1)::real as s_venue,
      coalesce(sc.v, 0)::real                  as s_scalar,
      least(coalesce(c.interested_count, 0) / 2000.0, 1)::real as s_pop,
      least(coalesce(nart.w, 0) / nt.w, 1)::real as n_artist,
      least(coalesce(ngen.w, 0) / nt.w, 1)::real as n_genre,
      least(coalesce(nvib.w, 0) / nt.w, 1)::real as n_vibe,
      least(coalesce(nven.w, 0) / nt.w, 1)::real as n_venue,
      art.names as artist_names, gen.labels as genre_labels, vib.labels as vibe_labels, ven.name as venue_name
    from cand c
    cross join tot t
    cross join ntot nt
    left join lateral (
      select sum(a.w) as w, array_agg(ar.name order by a.w desc) as names
      from event_artist ea join a_w a on a.artist_id = ea.artist_id join artist ar on ar.artist_id = ea.artist_id
      where ea.event_id = c.event_id
    ) art on true
    left join lateral (
      select sum(g.w) as w, array_agg(coalesce(gg.label, g.code) order by g.w desc) as labels
      from unnest(c.genre_codes) as x(code) join g_w g on g.code = x.code left join genre gg on gg.code = g.code
    ) gen on true
    left join lateral (
      select sum(f.w) as w from (select distinct split_part(y.code, '.', 1) as fam from unnest(c.genre_codes) as y(code)) x
      join f_w f on f.fam = x.fam
    ) fam on true
    left join lateral (
      select sum(v.w) as w, array_agg(coalesce(vv.label, v.code) order by v.w desc) as labels
      from unnest(c.vibe_codes) as x(code) join v_w v on v.code = x.code left join vibe vv on vv.code = v.code
    ) vib on true
    left join lateral (
      select vw.w, vn.name from ven_w vw join venue vn on vn.venue_id = vw.fam where vw.fam = venue_family(c.venue_id)
    ) ven on true
    left join lateral (
      select sum(a.w) as w from event_artist ea join na_w a on a.artist_id = ea.artist_id where ea.event_id = c.event_id
    ) nart on true
    left join lateral (
      select sum(g.w) as w from unnest(c.genre_codes) as x(code) join ng_w g on g.code = x.code
    ) ngen on true
    left join lateral (
      select sum(v.w) as w from unnest(c.vibe_codes) as x(code) join nv_w v on v.code = x.code
    ) nvib on true
    left join lateral (
      select vw.w from nven_w vw where vw.fam = venue_family(c.venue_id)
    ) nven on true
    left join lateral (
      select case when count(*) >= 2 then 1 - avg(d) / 4.0 else 0 end as v
      from (
        select abs(c.start_lateness - p.sl) as d from s_p p where c.start_lateness is not null and p.sl is not null
        union all select abs(c.end_lateness - p.el) from s_p p where c.end_lateness is not null and p.el is not null
        union all select abs(c.price_tier - p.pt) from s_p p where c.price_tier is not null and p.pt is not null
        union all select abs(c.underground_index - p.ui) from s_p p where c.underground_index is not null and p.ui is not null
        union all select abs(c.energy - p.en) from s_p p where c.energy is not null and p.en is not null
        union all select abs(c.darkness - p.dk) from s_p p where c.darkness is not null and p.dk is not null
      ) q(d)
    ) sc on true
  ),
  final as (
    select s.*,
      (3.0 * s.s_artist + 1.5 * s.s_genre + 0.6 * s.s_family + 0.8 * s.s_vibe + 0.7 * s.s_venue
        + 1.0 * s.s_scalar + 0.15 * s.s_pop
        -- saying no demotes what the dismissed nights had in common; it never vetoes a strong positive match,
        -- because one dismissal should not blacklist a whole genre
        - (1.5 * s.n_artist + 0.9 * s.n_genre + 0.5 * s.n_vibe + 0.5 * s.n_venue))::real as sc
    from scored s
    where (s.s_artist + s.s_genre + s.s_family + s.s_vibe + s.s_venue) > 0
  ),
  capped as (
    -- Events with no venue each get a partition of their own (their event_id): "venue unknown" is not a
    -- venue, and SQL groups NULLs into one window partition, which would cap the whole venue-less tail at two.
    select f.*, row_number() over (
      partition by coalesce(f.ven_fam::text, f.event_id::text)
      order by f.sc desc, f.night
    ) as rn
    from final f
  )
  select
    c.event_id,
    c.sc as score,
    (select coalesce(jsonb_agg(r order by ord), '[]'::jsonb) from (
        select 1 as ord, jsonb_build_object('kind','artist','detail', array_to_string(c.artist_names[1:2], ' and ')) as r where c.s_artist > 0
        union all select 2, jsonb_build_object('kind','genre','detail', array_to_string(c.genre_labels[1:2], ', ')) where c.s_genre > 0
        union all select 3, jsonb_build_object('kind','venue','detail', c.venue_name) where c.s_venue > 0 and c.venue_name is not null
        union all select 4, jsonb_build_object('kind','vibe','detail', array_to_string(c.vibe_labels[1:2], ', ')) where c.s_vibe > 0
      ) reasons(ord, r)
    ) as reasons,
    (select n from tot) as history_size
  from capped c
  where c.rn <= greatest(p_per_venue, 1) and c.sc > 0
  order by c.sc desc, c.night asc
  limit greatest(least(p_limit, 50), 1);
end $$;

comment on function recommend_events(int, text, int, int) is
  'Content-based recommendations for auth.uid(): positive profile from going/saved/opened, negative from dismissed, classes excluded, capped per venue family. SECURITY DEFINER, no user argument.';

revoke execute on function recommend_events(int, text, int, int) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function recommend_events(int, text, int, int) from anon';
    execute 'grant execute on function recommend_events(int, text, int, int) to authenticated';
  end if;
end $$;
-- the 3-argument version from 0015 is superseded
drop function if exists recommend_events(int, text, int);
