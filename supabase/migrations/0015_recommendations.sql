-- NOCT 0015: content-based recommendations from a user's own going/saved history.
--
-- Why content-based and not collaborative: NOCT has one user's worth of history, not thousands. A taste
-- profile built from the events someone already marked works from the first mark and needs nobody else,
-- which is exactly the cold-start shape this app is in. Collaborative filtering becomes possible later and
-- can be blended in without changing this interface.
--
-- Signals, in the order they actually predict a night out (coverage measured 2026-09-15 over 1,334 upcoming
-- events): artists 679, vibes 648, genres 609, venue priors 50 venues, and of the scalars only
-- start_lateness 650 / end_lateness 628 / price_tier 544 / underground_index 344 — energy and darkness come
-- only from the LLM pass (29) so they are scored when present and simply skipped when not. `promoter` is
-- still empty, so promoters are not a signal yet.
--
-- Security: SECURITY DEFINER so the function can read the catalogue (event_artist, venue, ...) that anon and
-- authenticated have no grants on, with a pinned search_path. It takes NO user argument — the profile is
-- always auth.uid()'s own — so it cannot be pointed at somebody else's history, and it returns only event
-- ids plus the reasons, never another user's rows.
set search_path = public, extensions;

-- Weights. Artist overlap is worth more than everything else combined on purpose: "a DJ you have seen is
-- playing" is the single most predictive thing NOCT knows, and it is also the reason a human would go.
create or replace function recommend_events(
  p_limit int default 20,
  p_city  text default null,     -- default: the city of the most recent mark, else nyc
  p_days  int default 28
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
    -- going is an intent to show up; saved is a bookmark. Both say something, not the same thing.
    select e.*, 1.0::real as w, g.created_at as marked_at
    from going g join event e on e.event_id = g.event_id
    where g.user_id = v_uid and e.merged_into is null
    union all
    select e.*, 0.4::real, s.created_at
    from saved s join event e on e.event_id = s.event_id
    where s.user_id = v_uid and e.merged_into is null
  ),
  tot as (select count(*)::int as n, greatest(coalesce(sum(w), 0), 0.001)::real as w from hist),
  city as (
    select coalesce(p_city, (select h.city from hist h order by h.marked_at desc limit 1), 'nyc') as key
  ),
  -- taste profile: how much of the history each code / artist / venue accounts for
  g_w as (select x.code, sum(h.w) as w from hist h, unnest(h.genre_codes) as x(code) group by x.code),
  f_w as (select split_part(x.code, '.', 1) as fam, sum(h.w) as w from hist h, unnest(h.genre_codes) as x(code) group by 1),
  v_w as (select x.code, sum(h.w) as w from hist h, unnest(h.vibe_codes) as x(code) group by x.code),
  a_w as (select ea.artist_id, sum(h.w) as w from hist h join event_artist ea on ea.event_id = h.event_id group by 1),
  ven_w as (select venue_family(h.venue_id) as fam, sum(h.w) as w from hist h where h.venue_id is not null group by 1),
  -- scalar profile, averaged over the marks that actually carry each dimension
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
      and not exists (select 1 from going  g where g.user_id = v_uid and g.event_id = e.event_id)
      and not exists (select 1 from saved  s where s.user_id = v_uid and s.event_id = e.event_id)
  ),
  scored as (
    select
      c.event_id,
      c.night,
      -- every component is "share of my history this event matches", so a heavy user does not get bigger numbers
      least(coalesce(art.w, 0) / t.w, 1)::real  as s_artist,
      least(coalesce(gen.w, 0) / t.w, 1)::real  as s_genre,
      least(coalesce(fam.w, 0) / t.w, 1)::real  as s_family,
      least(coalesce(vib.w, 0) / t.w, 1)::real  as s_vibe,
      least(coalesce(ven.w, 0) / t.w, 1)::real  as s_venue,
      coalesce(sc.v, 0)::real                   as s_scalar,
      least(coalesce(c.interested_count, 0) / 2000.0, 1)::real as s_pop,
      art.names as artist_names, gen.labels as genre_labels, vib.labels as vibe_labels, ven.name as venue_name
    from cand c
    cross join tot t
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
      select vw.w, vn.name
      from ven_w vw join venue vn on vn.venue_id = vw.fam
      where vw.fam = venue_family(c.venue_id)
    ) ven on true
    left join lateral (
      -- closeness on the dimensions both sides have; 1 = identical, 0 = four bins apart. Needs two shared
      -- dimensions before it says anything, so a single stray scalar cannot carry a recommendation.
      select case when count(*) >= 2 then 1 - avg(d) / 4.0 else 0 end as v
      from (
        select abs(c.start_lateness    - p.sl) as d from s_p p where c.start_lateness    is not null and p.sl is not null
        union all select abs(c.end_lateness    - p.el) from s_p p where c.end_lateness    is not null and p.el is not null
        union all select abs(c.price_tier      - p.pt) from s_p p where c.price_tier      is not null and p.pt is not null
        union all select abs(c.underground_index - p.ui) from s_p p where c.underground_index is not null and p.ui is not null
        union all select abs(c.energy          - p.en) from s_p p where c.energy          is not null and p.en is not null
        union all select abs(c.darkness        - p.dk) from s_p p where c.darkness        is not null and p.dk is not null
      ) q(d)
    ) sc on true
  )
  select
    s.event_id,
    (3.0 * s.s_artist + 1.5 * s.s_genre + 0.6 * s.s_family + 0.8 * s.s_vibe + 0.7 * s.s_venue
      + 1.0 * s.s_scalar + 0.15 * s.s_pop)::real as score,
    -- why, in the order a person would say it. Same provenance habit as the genre chips.
    (select coalesce(jsonb_agg(r order by ord), '[]'::jsonb) from (
        select 1 as ord, jsonb_build_object('kind','artist','detail', array_to_string(s.artist_names[1:2], ' and ')) as r
          where s.s_artist > 0
        union all
        select 2, jsonb_build_object('kind','genre','detail', array_to_string(s.genre_labels[1:2], ', '))
          where s.s_genre > 0
        union all
        select 3, jsonb_build_object('kind','venue','detail', s.venue_name) where s.s_venue > 0 and s.venue_name is not null
        union all
        select 4, jsonb_build_object('kind','vibe','detail', array_to_string(s.vibe_labels[1:2], ', '))
          where s.s_vibe > 0
      ) reasons(ord, r)
    ) as reasons,
    (select n from tot) as history_size
  from scored s
  -- A real overlap is the price of admission: artist, genre, vibe or venue. The scalars only RANK what is
  -- already relevant — almost every club night starts late, ends late and costs $20, so letting them admit
  -- an event on their own would recommend the whole calendar.
  where (s.s_artist + s.s_genre + s.s_family + s.s_vibe + s.s_venue) > 0
  order by score desc, s.night asc
  limit greatest(least(p_limit, 50), 1);
end $$;

comment on function recommend_events(int, text, int) is
  'Content-based recommendations for auth.uid() from their own going/saved history. SECURITY DEFINER for catalogue reads; takes no user argument so it can only ever profile the caller.';

-- Only signed-in callers, and never anon or the world.
revoke execute on function recommend_events(int, text, int) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function recommend_events(int, text, int) from anon';
    execute 'grant execute on function recommend_events(int, text, int) to authenticated';
  end if;
end $$;

create index if not exists going_user_idx on going (user_id);
create index if not exists saved_user_idx on saved (user_id);
