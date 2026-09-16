-- NOCT 0023: recommendations know what "tonight" means, and where.
--
-- Three defects, found by the 2026-09-15 audit, fixed in one place:
--
--  1. recommend_events() windowed its candidates from `current_date`, which on Supabase is UTC. From 20:00 in
--     New York (17:00 in Los Angeles) the function's "today" was already tomorrow, so tonight's nights fell out
--     of every recommendation for the rest of the evening -- the hours people actually open the app. The window
--     now starts at the city's own night date: night_date(now(), city.tz), so 01:00 still counts as the night
--     before, the same axis the rest of the schema uses.
--
--  2. DICE listings outside New York were persisted with tz = 'America/New_York' (the adapter never passed the
--     city's zone), and refresh_event() copies the winning listing's tz onto the event, so 39 Los Angeles and
--     22 Chicago events printed their doors three hours / one hour late. Backfilled below; the adapter passes
--     the city's zone from this commit on. No `night` moves: checked against production before this was written
--     (the DICE start instants were right all along, only the clock they were printed in was wrong).
--
--  3. Nearly every reason line read "Your nights are 21+". Door policy is not taste -- 21+ is on two nights in
--     three citywide, so it matched everyone and explained nothing -- and it let events through the admission
--     rule on that alone. The scorer now ignores policy vibes, keeping the two that describe a room's culture
--     (phone_free, sober_friendly), which is exactly what the feed shows (moodVibes() in src/feed/shape.ts).
--
-- For the picks surface the function also gains:
--   - p_days = 0 → tonight only; p_night → exactly that night (the client asks for the first night it loaded,
--     so the picks and the feed on screen always agree on which night they are talking about).
--   - `signals`: the five overlap shares behind the score, so the client can say WHY a pick is the safer one or
--     the wildcard from the numbers themselves. The score is still a weighted sum, not a probability, and the
--     client is expected not to print it as one.
set search_path = public, extensions;

------------------------------------------------------------------------------
-- 2. Time zones follow the city
------------------------------------------------------------------------------
update listing l set tz = c.tz
from city c
where c.city_key = l.city and l.tz is distinct from c.tz;

update event e set tz = c.tz
from city c
where c.city_key = e.city and e.tz is distinct from c.tz;

-- keeps the night/tz invariant refresh_event() maintains; a no-op on today's data
update event e set night = night_date(e.starts_at, e.tz)
where e.has_time and e.starts_at is not null and e.night <> night_date(e.starts_at, e.tz);

------------------------------------------------------------------------------
-- 1 + 3. recommend_events(): city-local window, single-night mode, signals, no policy vibes
------------------------------------------------------------------------------
-- the return shape changes (signals), so the old signature has to go first
drop function if exists recommend_events(int, text, int, int);

create or replace function recommend_events(
  p_limit     int  default 20,
  p_city      text default null,
  p_days      int  default 28,   -- 0 = tonight only
  p_per_venue int  default 2,    -- at most this many from one venue family, so one room cannot fill the list
  p_night     date default null  -- exactly this night, overriding p_days
) returns table (event_id uuid, score real, reasons jsonb, history_size int, signals jsonb)
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
  -- what the account said it likes during onboarding. A stated preference is worth less than a night someone
  -- actually marked, but it is what makes recommendations work from the very first run.
  seed as (select coalesce(p.taste_genres, '{}')::text[] as codes from profile p where p.user_id = v_uid),
  seed_w as (select x.code, 0.7::real as w from seed, unnest(seed.codes) as x(code)),
  tot as (
    select (select count(*) from hist)::int + (case when exists (select 1 from seed_w) then 1 else 0 end) as n,
           greatest(coalesce((select sum(w) from hist), 0) + coalesce((select sum(w) from seed_w), 0), 0.001)::real as w
  ),
  ntot as (select greatest(count(*), 1)::real as w from neg),
  -- the city asked for (else the last one marked, else New York) and its clock. public.city is the table;
  -- this CTE shadows the bare name for the rest of the query.
  city as (
    select k.key, coalesce((select c.tz from public.city c where c.city_key = k.key), 'America/New_York') as tz
    from (select coalesce(p_city, (select h.city from hist h order by h.marked_at desc limit 1), 'nyc') as key) k
  ),
  -- the nights in play, on the city's own night axis (before 06:00 local is still last night)
  win as (
    select coalesce(p_night, night_date(now(), city.tz)) as lo,
           coalesce(p_night, night_date(now(), city.tz) + greatest(p_days, 0)) as hi
    from city
  ),
  -- a vibe counts as taste when it says what kind of night it was, not what the door asked for
  taste_vibe as (
    select v.code from vibe v where v.kind <> 'policy' or v.code in ('phone_free', 'sober_friendly')
  ),
  g_w as (
    select code, sum(w) as w from (
      select x.code, h.w from hist h, unnest(h.genre_codes) as x(code)
      union all select code, w from seed_w
    ) q group by code
  ),
  f_w as (
    select fam, sum(w) as w from (
      select split_part(x.code, '.', 1) as fam, h.w from hist h, unnest(h.genre_codes) as x(code)
      union all select split_part(code, '.', 1), w from seed_w
    ) q group by fam
  ),
  v_w as (
    select x.code, sum(h.w) as w from hist h, unnest(h.vibe_codes) as x(code)
    where x.code in (select code from taste_vibe) or not exists (select 1 from vibe v where v.code = x.code)
    group by x.code
  ),
  a_w as (select ea.artist_id, sum(h.w) as w from hist h join event_artist ea on ea.event_id = h.event_id group by 1),
  ven_w as (select venue_family(h.venue_id) as fam, sum(h.w) as w from hist h where h.venue_id is not null group by 1),
  ng_w  as (select x.code, count(*)::real as w from neg n, unnest(n.genre_codes) as x(code) group by x.code),
  nv_w  as (
    select x.code, count(*)::real as w from neg n, unnest(n.vibe_codes) as x(code)
    where x.code in (select code from taste_vibe) or not exists (select 1 from vibe v where v.code = x.code)
    group by x.code
  ),
  na_w  as (select ea.artist_id, count(*)::real as w from neg n join event_artist ea on ea.event_id = n.event_id group by 1),
  nven_w as (select venue_family(n.venue_id) as fam, count(*)::real as w from neg n where n.venue_id is not null group by 1),
  s_p as (
    select avg(start_lateness)::real sl, avg(end_lateness)::real el, avg(price_tier)::real pt,
           avg(underground_index)::real ui, avg(energy)::real en, avg(darkness)::real dk
    from hist
  ),
  cand as (
    select e.*
    from event e, city, win
    where e.merged_into is null
      and e.status = 'scheduled'
      and e.city = city.key
      and e.night between win.lo and win.hi
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
    select s.*, c2.title,
      (3.0 * s.s_artist + 1.5 * s.s_genre + 0.6 * s.s_family + 0.8 * s.s_vibe + 0.7 * s.s_venue
        + 1.0 * s.s_scalar + 0.15 * s.s_pop
        -- saying no demotes what the dismissed nights had in common; it never vetoes a strong positive match,
        -- because one dismissal should not blacklist a whole genre
        - (1.5 * s.n_artist + 0.9 * s.n_genre + 0.5 * s.n_vibe + 0.5 * s.n_venue))::real as sc
    from scored s join cand c2 on c2.event_id = s.event_id
    where (s.s_artist + s.s_genre + s.s_family + s.s_vibe + s.s_venue) > 0
  ),
  capped as (
    -- Events with no venue each get a partition of their own (their event_id): "venue unknown" is not a
    -- venue, and SQL groups NULLs into one window partition, which would cap the whole venue-less tail at two.
    -- rn_run collapses a multi-night run to its best night: a show that plays eight dates is one thing to
    -- recommend, not eight, and the venue cap does not catch it because the whole run is at one venue.
    select f.*,
      row_number() over (
        partition by coalesce(f.ven_fam::text, f.event_id::text)
        order by f.sc desc, f.night
      ) as rn,
      row_number() over (
        partition by norm_title(f.title)
        order by f.sc desc, f.night
      ) as rn_run
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
    (select n from tot) as history_size,
    jsonb_build_object(
      'artist', round(c.s_artist::numeric, 3), 'genre', round(c.s_genre::numeric, 3), 'family', round(c.s_family::numeric, 3),
      'vibe', round(c.s_vibe::numeric, 3), 'venue', round(c.s_venue::numeric, 3)
    ) as signals
  from capped c
  where c.rn <= greatest(p_per_venue, 1) and c.rn_run = 1 and c.sc > 0
  order by c.sc desc, c.night asc
  limit greatest(least(p_limit, 50), 1);
end $$;

comment on function recommend_events(int, text, int, int, date) is
  'Content-based recommendations for auth.uid() from their own going/saved/taste history, windowed on the city''s own night date (p_days = 0 → tonight, p_night → that night). SECURITY DEFINER for catalogue reads; takes no user argument so it can only ever profile the caller.';

-- Only signed-in callers, and never anon or the world.
revoke execute on function recommend_events(int, text, int, int, date) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function recommend_events(int, text, int, int, date) from anon';
    execute 'grant execute on function recommend_events(int, text, int, int, date) to authenticated';
  end if;
end $$;
