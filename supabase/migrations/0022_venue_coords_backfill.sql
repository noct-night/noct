-- NOCT 0022: coordinates the listings already know, copied up to the venue.
--
-- create_provisional_venue() sets lat/lng when it CREATES a venue, but a listing that resolves to an existing
-- venue -- a seeded one, or a provisional one made from a source that had no coordinates -- never passes its
-- own coordinates up. So Bossa Nova, SILO, Mood Ring and The Lot Radio sat with lat/lng null while DICE and
-- RA listings at those rooms carried the numbers: 38% of a NYC night could be placed on a map.
--
-- Guarded, because DICE's city filter has leaked a Giza festival under New York before: a listing's
-- coordinates are accepted only when they fall within ~0.75 degrees (~80 km) of where the city's other venues
-- already are. Curated coordinates are never overwritten -- only nulls are filled.
set search_path = public, extensions;

create or replace function venue_is_placeholder(p_name text) returns boolean
language sql immutable parallel safe as $$
  select coalesce(p_name ~* '\m(tba|tbc)\M|to be announced|secret location|location tba|undisclosed|venue tba', false)
$$;
comment on function venue_is_placeholder(text) is 'A venue name that stands for "we do not know where": never geocoded, never mapped.';

-- and take the coordinates back off the ones that already have them
update venue set lat = null, lng = null, geocode_source = null
 where lat is not null and venue_is_placeholder(name);

create or replace function backfill_venue_coords() returns int
language plpgsql as $$
declare n int;
begin
  with centre as (
    select city, avg(lat) as lat, avg(lng) as lng from venue
    where lat is not null and lng is not null and city is not null and coalesce(geocode_source, '') not like 'listing:%'
    group by city
  ),
  cand as (
    select v.venue_id, l.venue_lat_raw as lat, l.venue_lng_raw as lng, l.source_key,
           -- ~100 m cells, so listings that agree on a room agree on a cell
           round(l.venue_lat_raw::numeric, 3) as cell_lat, round(l.venue_lng_raw::numeric, 3) as cell_lng,
           -- decimals carried: RA rounds a venue it has wrong to 40.72, -73.99; a real geocode has six
           length(split_part(l.venue_lat_raw::text, '.', 2)) as precision
    from venue v
    join event e on e.venue_id = v.venue_id and e.merged_into is null
    join listing l on l.event_id = e.event_id and l.gone_at is null
    left join centre c on c.city = v.city
    where (v.lat is null or coalesce(v.geocode_source, '') like 'listing:%')   -- fill nulls, re-judge our own
      -- "Location TBA", "Secret location", "TBA": a placeholder is not a place. DICE geocodes these to the
      -- middle of the borough, and 14 unlocated nights then show up as the busiest dot on the map.
      and not venue_is_placeholder(v.name)
      and l.venue_lat_raw is not null and l.venue_lng_raw is not null
      and abs(l.venue_lat_raw) > 1 and abs(l.venue_lng_raw) > 1
      -- 37.09, -95.71 is the geographic centre of the United States: what a geocoder returns for "USA" when
      -- it has no idea. RA sent it for a room called Ssshhh, and it put a dot in Kansas on the New York map.
      and not (round(l.venue_lat_raw::numeric, 1) = 37.1 and round(l.venue_lng_raw::numeric, 1) = -95.7)
      and (c.lat is null or (abs(l.venue_lat_raw - c.lat) < 0.75 and abs(l.venue_lng_raw - c.lng) < 0.75))
  ),
  -- Sources disagree about where a room is, and the highest-priority source is not the best geocoder: RA had
  -- SILO Brooklyn at 132 Bowery while SILO's own feed and DICE agreed on 90 Scott Ave. The cell most listings
  -- agree on wins; within it, the most precise value.
  cells as (
    select venue_id, cell_lat, cell_lng, count(*) as votes from cand group by 1, 2, 3
  ),
  pick as (
    select distinct on (c.venue_id) c.venue_id, c.lat, c.lng, c.source_key
    from cand c join cells k on k.venue_id = c.venue_id and k.cell_lat = c.cell_lat and k.cell_lng = c.cell_lng
    order by c.venue_id, k.votes desc, c.precision desc
  )
  update venue v
     set lat = p.lat, lng = p.lng, geocode_source = 'listing:' || p.source_key
    from pick p
   where p.venue_id = v.venue_id
     and (v.lat is distinct from p.lat or v.lng is distinct from p.lng);
  get diagnostics n = row_count;
  return n;
end $$;

comment on function backfill_venue_coords() is
  'Fill venue lat/lng from live listings: the ~100 m cell most listings agree on wins, most precise value within it, only within ~80 km of the city''s curated venues. Re-judges its own earlier picks; never touches a curated coordinate.';
