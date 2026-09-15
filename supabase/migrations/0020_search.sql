-- NOCT 0020: one search across events, artists and venues.
--
-- Everything this needs already exists: trigram indexes on event.title, artist.name, venue.name and
-- venue_alias (0001/0002), and norm_text() for accent- and case-folding. This is the query, not new machinery.
--
-- Only things with an upcoming night are returned. An artist with no dates is a dead end in a listings app --
-- you cannot go and see them -- so they are not offered, and the count is part of the answer.
set search_path = public, extensions;

-- the shape changed once (city added), and create-or-replace cannot widen an OUT list
drop function if exists search_noct(text, text, int, int);
create or replace function search_noct(
  p_q     text,
  p_city  text default null,
  p_limit int  default 8,
  p_days  int  default 120
) returns table (kind text, id uuid, label text, sub text, n int, city text, night date, score real)
language sql stable parallel safe
as $$
  with q as (
    select norm_text(p_q) as nq, greatest(least(p_limit, 20), 1) as lim,
           current_date + greatest(p_days, 1) as horizon
  ),
  ev as (
    select 'event'::text as kind, e.event_id as id, e.title as label,
           to_char(e.night, 'Dy Mon DD') || coalesce(' · ' || v.name, '') as sub,
           0 as n, e.city as city, e.night as night,
           -- a prefix match is an intent, a trigram match is a guess; never let the guess outrank it
           greatest(similarity(e.title_norm, q.nq), case when e.title_norm like q.nq || '%' then 1.0 else 0 end)::real as score
    from event e
    left join venue v on v.venue_id = e.venue_id
    cross join q
    where e.merged_into is null and e.status <> 'removed'
      and e.night between current_date and q.horizon
      and (p_city is null or e.city = p_city)
      and not event_is_class(e.title)          -- the feed hides these (0016); offering them leads nowhere
      and (e.title_norm like q.nq || '%' or e.title_norm % q.nq)
  ),
  ar as (
    select 'artist'::text as kind, a.artist_id as id, a.name as label,
           (select count(*) from event_artist ea join event e2 on e2.event_id = ea.event_id
             where ea.artist_id = a.artist_id and e2.merged_into is null
               and e2.night between current_date and q.horizon
               and (p_city is null or e2.city = p_city))::int as upcoming,
           -- where to find them next; an artist can tour, so this is the soonest night's city
           (select e2.city from event_artist ea join event e2 on e2.event_id = ea.event_id
             where ea.artist_id = a.artist_id and e2.merged_into is null
               and e2.night between current_date and q.horizon
               and (p_city is null or e2.city = p_city)
             order by e2.night limit 1) as city,
           null::date as night,
           greatest(similarity(a.name_norm, q.nq), case when a.name_norm like q.nq || '%' then 1.0 else 0 end)::real as score
    from artist a, q
    where (a.name_norm like q.nq || '%' or a.name_norm % q.nq)
  ),
  ve as (
    select 'venue'::text as kind, v.venue_id as id, v.name as label,
           coalesce(v.neighborhood, v.borough, '') as area,
           (select count(*) from event e3 where e3.venue_id = v.venue_id and e3.merged_into is null
              and e3.night between current_date and q.horizon)::int as upcoming,
           v.city as city,
           null::date as night,
           greatest(
             similarity(v.name_norm, q.nq),
             case when v.name_norm like q.nq || '%' then 1.0 else 0 end,
             coalesce((select max(similarity(norm_text(al.alias), q.nq)) from venue_alias al where al.venue_id = v.venue_id), 0)
           )::real as score
    from venue v, q
    where (p_city is null or v.city = p_city)
      and (v.name_norm like q.nq || '%' or v.name_norm % q.nq
           or exists (select 1 from venue_alias al where al.venue_id = v.venue_id and norm_text(al.alias) % q.nq))
  )
  select kind, id, label, sub, n, city, night, score from (
    select kind, id, label, sub, n, city, night, score from ev
    union all
    select kind, id, label, case when upcoming = 1 then '1 night' else upcoming || ' nights' end, upcoming, city, night, score
      from ar where upcoming > 0
    union all
    select kind, id, label, nullif(area, ''), upcoming, city, night, score
      from ve where upcoming > 0
  ) hits, q
  where score > 0.22
  order by score desc, n desc, label
  limit (select lim from q)
$$;

comment on function search_noct(text, text, int, int) is
  'Events, artists and venues matching a query, upcoming only. Prefix match scores 1.0 so an exact start always beats a trigram guess.';
