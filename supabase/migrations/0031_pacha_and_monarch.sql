-- NOCT 0031: the name on the ticket, and a fuzzy venue match that cannot wander off the map.
--
-- The report was one card: DICE says Indo Warehouse is at Pacha New York, NOCT said Avant Gardner. The row was
-- right about the place and wrong about the name -- Pacha Group operates the 140 Stewart Ave complex as Pacha New
-- York in 2026, and the venue note said so while the name stayed the old one. The name follows the ticket now;
-- "Avant Gardner" stays as the former name, so search and old links still land.
--
-- Looking at that family found the real bug. resolve_venue()'s trigram branch takes word_similarity, which
-- measures how well the EXISTING name sits inside the incoming one -- and "brooklyn mirage" sits 0.59 inside
-- "the brooklyn monarch". The Monarch (23 Meadow St) resolved to the Mirage, learn_venue_ref() then stored RA
-- 188422, DICE 5080 and the label itself as the Mirage's, every later listing hit that alias exactly, and 0022
-- adopted the Monarch's coordinates as the Mirage's. The same shape put "Silence Please" (132 Bowery) on SILO,
-- three "... Lounge" rooms on LK Lounge and Zero Lounge, Hollywood Palladium on W Hollywood, Brooklyn Bowl on
-- SILO: 26 live listings on the wrong room on 2026-09-16.
--
-- Two rules, then the data:
--   1. a trigram hit has to be about the same words: after the place words are dropped (nyc, brooklyn,
--      hollywood, the, ...), every word of one name must have its word in the other -- the same word, a typo
--      of it, or a stem ("el rey" in "el rey theatre", "nowadays" in "nowadays nyc", "nowdays" for
--      "nowadays"). "Hollywood Bowl" no longer finds "W Hollywood", "Sound Nightclub" no longer finds
--      "Spin", "Westlight Rooftop at The William Vale" no longer finds "Elsewhere Rooftop";
--   2. a placeholder (tba / secret) is never a trigram candidate -- "Location TBA - New York" had collected
--      Rooftop at Arlo Williamsburg, Marquee New York and 1 Hotel Brooklyn Bridge -- and a trigram hit is vetoed
--      when the listing's own coordinates are more than 500 m from the venue's (or its family's);
--   3. a trigram match is never learned: an exact-id or exact-name match becomes an alias, a guess is re-judged
--      on every run.
-- Then every learned label the rules would not produce today is unlearned (with the source ids learned beside
-- it), every learned reference whose listings sit far from the venue likewise, and their listings are resolved
-- again (reresolve_listing_venue(): the new venue, the event refreshed, the listing rematched) -- most become
-- rooms of their own, with the source's address and coordinates. The Brooklyn Monarch gets its own row with The
-- Meadows as its second room, and the Mirage gets its family's coordinates back.
set search_path = public, extensions;

------------------------------------------------------------------------------
-- 1. resolve_venue(): a guess has to be about the same words, never a placeholder, and within reach
------------------------------------------------------------------------------
-- The words of a venue name that say which venue it is: place words and articles dropped, spellings folded.
create or replace function venue_tokens(p text) returns text[]
language sql immutable as $$
  select coalesce(array_agg(case when t = 'theatre' then 'theater' when t = 'centre' then 'center' else t end), '{}'::text[])
  from unnest(string_to_array(coalesce(norm_text(p), ''), ' ')) as t
  where t <> '' and t not in ('the', 'at', 'of', 'and', 'nyc', 'ny', 'new', 'york', 'brooklyn', 'manhattan', 'queens', 'bronx',
                              'la', 'los', 'angeles', 'hollywood', 'chicago', 'city')
$$;
-- One word is another when it is the same word, a typo of it (five letters or more, half the trigrams shared:
-- "nowdays" / "nowadays"), or a stem of it ("break" / "breakpoint").
create or replace function venue_token_close(a text, b text) returns boolean
language sql immutable as $$
  select a = b
      or (length(a) >= 5 and length(b) >= 5 and extensions.similarity(a, b) >= 0.5)
      or (least(length(a), length(b)) >= 4 and (a like b || '%' or b like a || '%'))
$$;
-- Two names are about the same place when every distinctive word of one has its word in the other: "el rey" in
-- "el rey theatre", "nowadays nyc" and "nowadays", "pacha new york - the great hall" and "the great hall".
-- "the brooklyn monarch" and "brooklyn mirage" share only a place word, and are not. Neither side may be left
-- with no words at all.
create or replace function venue_names_agree(a text, b text) returns boolean
language sql immutable as $$
  with ta as (select unnest(venue_tokens(a)) as t), tb as (select unnest(venue_tokens(b)) as t)
  select cardinality(venue_tokens(a)) > 0 and cardinality(venue_tokens(b)) > 0 and (
         not exists (select 1 from ta where not exists (select 1 from tb where venue_token_close(ta.t, tb.t)))
      or not exists (select 1 from tb where not exists (select 1 from ta where venue_token_close(ta.t, tb.t))))
$$;

drop function if exists resolve_venue(text, text, text, text);
create or replace function resolve_venue(p_source_key text, p_source_venue_id text, p_name text, p_city text default 'nyc',
                                         p_lat double precision default null, p_lng double precision default null)
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
      select a.venue_id, a.alias_norm as cand, greatest(extensions.similarity(a.alias_norm, n),
                                  extensions.word_similarity(a.alias_norm, n) * 0.95,
                                  case when long then extensions.word_similarity(n, a.alias_norm) * 0.95 else 0 end) as sim
      from venue_alias a join venue va on va.venue_id = a.venue_id
      where va.city = p_city and (a.alias_norm % n or a.alias_norm <% n or (long and n <% a.alias_norm))
      union all
      select v.venue_id, v.name_norm, greatest(extensions.similarity(v.name_norm, n),
                                  extensions.word_similarity(v.name_norm, n) * 0.95,
                                  case when long then extensions.word_similarity(n, v.name_norm) * 0.95 else 0 end)
      from venue v where v.city = p_city and (v.name_norm % n or v.name_norm <% n or (long and n <% v.name_norm))
    ) s
    join venue sv on sv.venue_id = s.venue_id
    left join venue sp on sp.venue_id = sv.parent_venue_id
    where s.sim >= 0.55
      -- the same words, not just a shared "brooklyn" or "lounge"
      and venue_names_agree(s.cand, n)
      -- a placeholder is never a guess: "TBA - Hollywood" must not collect "Casita Hollywood"
      and sv.kind not in ('tba', 'secret')
      -- the veto: coordinates on both sides, and more than half a kilometre between them
      and (p_lat is null or p_lng is null or coalesce(sv.lat, sp.lat) is null
           or haversine_km(p_lat, p_lng, coalesce(sv.lat, sp.lat), coalesce(sv.lng, sp.lng)) <= 0.5)
    order by s.sim desc limit 1;
end $$;
comment on function resolve_venue(text, text, text, text, double precision, double precision) is
  'Source venue id -> exact alias -> exact name -> trigram (>= 0.55, both directions, the same distinctive words, never a placeholder, vetoed beyond 500 m of the listing''s own coordinates).';

------------------------------------------------------------------------------
-- 2. upsert_listing(): passes the coordinates through, learns nothing from a guess (0011 body otherwise)
------------------------------------------------------------------------------
create or replace function upsert_listing(
  p_source_key text, p_source_id text, p_source_url text, p_raw jsonb, p_run_id bigint,
  p_title text, p_starts_at timestamptz, p_ends_at timestamptz, p_has_time boolean, p_night date,
  p_venue_name text, p_venue_addr text, p_venue_source_id text, p_venue_lat double precision, p_venue_lng double precision,
  p_lineup text[], p_price_min numeric, p_price_max numeric, p_fees_included boolean, p_price_note text, p_prices jsonb,
  p_sold_out boolean, p_status text, p_age_min int, p_genres text[], p_promoters text[],
  p_description text, p_image_url text, p_interested_count int, p_source_tags jsonb, p_external_refs jsonb,
  p_city text default 'nyc', p_tz text default 'America/New_York')
returns table(listing_id bigint, is_new boolean, changed boolean, event_id uuid)
language plpgsql as $$
#variable_conflict use_column
declare v_id bigint; v_hash text; v_venue uuid; v_vmethod text; v_event uuid; v_old_hash text; v_new boolean := false;
begin
  v_hash := md5(concat_ws('|', p_title, p_starts_at, p_ends_at, p_venue_name, array_to_string(p_lineup, ','), p_price_min, p_price_max, p_sold_out, p_status, p_age_min, array_to_string(p_genres, ',')));
  select l.content_hash into v_old_hash from listing l where l.source_key = p_source_key and l.source_id = p_source_id;
  select r.venue_id, r.method into v_venue, v_vmethod
    from resolve_venue(p_source_key, p_venue_source_id, p_venue_name, p_city, p_venue_lat, p_venue_lng) r limit 1;
  -- Unknown venue: create a provisional row so events at new rooms still get a venue family (dupe guard,
  -- cross-source matching). Humans review these later (needs_review); the seed/alias tables absorb them.
  if v_venue is null and norm_text(p_venue_name) is not null then
    v_venue := create_provisional_venue(p_source_key, p_venue_source_id, p_venue_name, p_venue_addr, p_venue_lat, p_venue_lng, p_city);
  end if;
  insert into listing (source_key, source_id, source_url, raw, content_hash, title, starts_at, ends_at, has_time, night,
                       venue_name_raw, venue_addr_raw, venue_source_id, venue_lat_raw, venue_lng_raw, venue_id, lineup_raw,
                       price_min, price_max, fees_included, price_note, sold_out, status, age_min, genres, promoters,
                       description, image_url, interested_count, source_tags, external_refs, seen_in_run_id, city, tz)
  values (p_source_key, p_source_id, p_source_url, p_raw, v_hash, p_title, p_starts_at, p_ends_at, p_has_time,
          coalesce(p_night, night_date(p_starts_at, p_tz)),
          p_venue_name, p_venue_addr, p_venue_source_id, p_venue_lat, p_venue_lng, v_venue, coalesce(p_lineup,'{}'),
          p_price_min, p_price_max, p_fees_included, p_price_note, p_sold_out, coalesce(p_status,'scheduled'), p_age_min,
          coalesce(p_genres,'{}'), coalesce(p_promoters,'{}'),
          p_description, p_image_url, p_interested_count, coalesce(p_source_tags,'{}'), coalesce(p_external_refs,'[]'), p_run_id, p_city, p_tz)
  on conflict (source_key, source_id) do update set
    source_url = excluded.source_url, raw = excluded.raw, content_hash = excluded.content_hash, title = excluded.title,
    starts_at = excluded.starts_at, ends_at = excluded.ends_at, has_time = excluded.has_time, night = excluded.night,
    venue_name_raw = excluded.venue_name_raw, venue_addr_raw = excluded.venue_addr_raw, venue_source_id = excluded.venue_source_id,
    venue_lat_raw = excluded.venue_lat_raw, venue_lng_raw = excluded.venue_lng_raw,
    venue_id = coalesce(excluded.venue_id, listing.venue_id),
    lineup_raw = excluded.lineup_raw, price_min = excluded.price_min, price_max = excluded.price_max, fees_included = excluded.fees_included,
    price_note = excluded.price_note, sold_out = excluded.sold_out, status = excluded.status, age_min = excluded.age_min,
    genres = excluded.genres, promoters = excluded.promoters, description = excluded.description, image_url = excluded.image_url,
    interested_count = excluded.interested_count, source_tags = excluded.source_tags, external_refs = excluded.external_refs,
    seen_in_run_id = excluded.seen_in_run_id, city = excluded.city, tz = excluded.tz
  returning listing.listing_id, listing.event_id, (xmax = 0) into v_id, v_event, v_new;
  -- price tiers: replace the set for this listing
  delete from listing_price lp where lp.listing_id = v_id;
  if p_prices is not null and jsonb_typeof(p_prices) = 'array' then
    -- Sources repeat tier names ("GA" twice with different prices); suffix duplicates so every tier survives
    -- and the ON CONFLICT clause never sees the same key twice in one statement.
    insert into listing_price (listing_id, tier, price, fees_included, available, note)
    select v_id,
           case when n = 1 then tier else tier || ' (' || n || ')' end,
           price, fees_included, available, note
    from (
      select coalesce(nullif(trim(t->>'tier'), ''), 'GA') as tier,
             nullif(t->>'price','')::numeric as price, (t->>'feesIncluded')::boolean as fees_included,
             (t->>'available')::boolean as available, t->>'note' as note,
             row_number() over (partition by coalesce(nullif(trim(t->>'tier'), ''), 'GA') order by ord) as n
      from jsonb_array_elements(p_prices) with ordinality as x(t, ord)
    ) tiers
    on conflict (listing_id, tier) do update set price = excluded.price, fees_included = excluded.fees_included, available = excluded.available, note = excluded.note;
  end if;
  -- remember how this source labels the venue, so the next run resolves by exact alias -- unless the match was a
  -- guess: a trigram hit is re-judged every run and never becomes an alias (0031)
  if v_vmethod is distinct from 'trgm' then
    perform learn_venue_ref(p_source_key, p_venue_source_id, p_venue_name, v_venue);
  end if;
  if v_event is not null then perform refresh_event(v_event); end if;
  return query select v_id, v_new, (v_old_hash is distinct from v_hash), v_event;
end $$;

------------------------------------------------------------------------------
-- 3. reresolve_listing_venue(): one listing, resolved again with today's rules
------------------------------------------------------------------------------
create or replace function reresolve_listing_venue(p_listing_id bigint) returns uuid
language plpgsql as $$
#variable_conflict use_column
declare l listing%rowtype; r record; v uuid;
begin
  select * into l from listing where listing_id = p_listing_id;
  if not found then return null; end if;
  select x.venue_id, x.method into r from resolve_venue(l.source_key, l.venue_source_id, l.venue_name_raw, l.city, l.venue_lat_raw, l.venue_lng_raw) x limit 1;
  v := r.venue_id;
  if v is null and norm_text(l.venue_name_raw) is not null then
    v := create_provisional_venue(l.source_key, l.venue_source_id, l.venue_name_raw, l.venue_addr_raw, l.venue_lat_raw, l.venue_lng_raw, l.city);
  end if;
  if v is not distinct from l.venue_id then return v; end if;
  update listing set venue_id = v where listing_id = p_listing_id;
  if r.method is distinct from 'trgm' then
    perform learn_venue_ref(l.source_key, l.venue_source_id, l.venue_name_raw, v);
  end if;
  if l.event_id is not null and l.gone_at is null then
    perform rematch_listing(p_listing_id);        -- a twin at the right room takes it; otherwise it stays
    begin
      perform refresh_event((select e.event_id from listing e where e.listing_id = p_listing_id));
    exception when unique_violation then
      null;                                        -- a live twin holds the title at this room; the next ingest refreshes
    end;
  end if;
  return v;
end $$;
comment on function reresolve_listing_venue(bigint) is
  'Resolve one listing''s venue again under the current rules; on a change, rematch the listing and refresh its event.';

------------------------------------------------------------------------------
-- 4. The data: Pacha New York, The Brooklyn Monarch, the Mirage's coordinates, and every far-off learned reference
------------------------------------------------------------------------------
-- 4a. the name on the ticket
update venue set name = 'Pacha New York', updated_at = now(),   -- name_norm is generated
       notes = 'Pacha Group operates the 140 Stewart Ave complex as Pacha New York (2026); formerly Avant Gardner. RA club 286414 (and the old 105938) and DICE venue pacha-new-york-6dvb7 map here. Rooms carry the capacities.'
where slug = 'avant-gardner' and name = 'Avant Gardner';
insert into venue_alias (alias_norm, alias, venue_id, kind, source_key)
select norm_text('Avant Gardner'), 'Avant Gardner', v.venue_id, 'former_name', null from venue v where v.slug = 'avant-gardner'
on conflict (alias_norm) do update set kind = 'former_name';
insert into venue_alias (alias_norm, alias, venue_id, kind, source_key)
select norm_text('Pacha New York'), 'Pacha New York', v.venue_id, 'official', null from venue v where v.slug = 'avant-gardner'
on conflict (alias_norm) do nothing;

-- 4b. The Brooklyn Monarch, and The Meadows next door as its second room
insert into venue (slug, name, kind, address, postal_code, borough, lat, lng, geocode_source, geocode_conf, ra_url, city, verified, needs_review, notes)
select 'the-brooklyn-monarch', 'The Brooklyn Monarch', 'venue', '23 Meadow St, Brooklyn, NY 11206', '11206', 'Brooklyn',
       40.71098, -73.936304, 'source:ra', 0.9, 'https://ra.co/clubs/188422', 'nyc', false, false,   -- verified stays for rooms checked in person
       'East Williamsburg warehouse venue on Meadow St; RA club 188422, DICE venue 5080. The Meadows (17 Meadow St) is its second room. Not the Brooklyn Mirage (0031).'
where not exists (select 1 from venue where slug = 'the-brooklyn-monarch');
update venue m set parent_venue_id = b.venue_id, kind = 'room', updated_at = now()
from venue b where b.slug = 'the-brooklyn-monarch' and m.name_norm = norm_text('The Meadows') and m.city = 'nyc' and m.parent_venue_id is null;
-- two rooms the word rule alone cannot tell from a namesake: Sound (Hollywood) is not The Sound in Del Mar, and
-- 19hz's "Wicker Park" is the park, not the arcade bar named after it. An exact name settles both.
insert into venue (slug, name, kind, address, postal_code, lat, lng, geocode_source, geocode_conf, city, verified, needs_review, notes)
select x.slug, x.name, x.kind, x.address, x.postal, x.lat, x.lng, 'curated', 0.8, x.city, false, false, x.notes
from (values
  ('sound-nightclub', 'Sound Nightclub', 'venue', '1642 N Las Palmas Ave, Los Angeles, CA 90028', '90028', 34.1017, -118.3357, 'la', 'Hollywood club, usually written "Sound"; 19hz labels it Sound Nightclub. Not The Sound (Del Mar).'),
  ('wicker-park', 'Wicker Park', 'outdoor', '1425 N Damen Ave, Chicago, IL 60622', '60622', 41.9075, -87.6776, 'chi', 'The park itself (festivals, day parties); 19hz uses the bare name.')
) x(slug, name, kind, address, postal, lat, lng, city, notes)
where not exists (select 1 from venue v where v.slug = x.slug);

-- 4c. a room whose coordinates came from a listing (0022) and sit more than 500 m from its family's got them
-- from a mis-filed listing: the Mirage was on Meadow St (the Monarch's), the Sound Room at Public Records in
-- Williamsburg (Jolene's), Elsewhere's rooftop at The William Vale. A room is where its family is.
update venue r set lat = p.lat, lng = p.lng, geocode_source = 'family', updated_at = now()
from venue p
where p.venue_id = r.parent_venue_id and p.lat is not null and r.lat is not null
  and r.geocode_source like 'listing:%' and haversine_km(r.lat, r.lng, p.lat, p.lng) > 0.5;

-- 4d. exact aliases for the boat, which is geotagged on the water and not at the pier
insert into venue_alias (alias_norm, alias, venue_id, kind, source_key)
select norm_text(x.alias), x.alias, v.venue_id, 'alias', null
from (values ('Circle Line Sightseeing Cruises'), ('Circle Line Boat')) x(alias), venue v
where v.name_norm = norm_text('Circle Line Cruises') and v.city = 'nyc'
on conflict (alias_norm) do update set kind = 'alias', venue_id = excluded.venue_id;

-- 4e. unlearn every learned label the rules would not produce today (the words disagree with the venue's name
-- and every curated alias of it; or a real room parked on a placeholder), every learned reference whose
-- listings sit far from the venue, and the source ids learned beside them; then resolve those listings again
drop table if exists far_ref;
create temp table far_ref as
with wrong_label as (
  select a.alias_norm as label_norm, a.venue_id
  from venue_alias a join venue v on v.venue_id = a.venue_id
  where a.kind = 'source_label' and a.alias_norm is distinct from v.name_norm
    and not venue_names_agree(a.alias_norm, v.name_norm)
    and not exists (select 1 from venue_alias c where c.venue_id = v.venue_id and c.kind <> 'source_label' and venue_names_agree(a.alias_norm, c.alias_norm))
    and not (v.kind in ('tba', 'secret') and a.alias ~* '\m(tba|to be announced|secret location|location tba|venue tba)\M')
),
by_label as (
  select distinct l.source_key, l.venue_source_id, w.label_norm, w.venue_id
  from wrong_label w join listing l on l.venue_id = w.venue_id and norm_text(l.venue_name_raw) = w.label_norm
  union
  select null::text, null::text, w.label_norm, w.venue_id from wrong_label w
),
fam as (
  select v.venue_id, v.name_norm, coalesce(v.lat, p.lat) as lat, coalesce(v.lng, p.lng) as lng
  from venue v left join venue p on p.venue_id = v.parent_venue_id
)
select l.source_key, l.venue_source_id, norm_text(l.venue_name_raw) as label_norm, l.venue_id
from listing l join fam f on f.venue_id = l.venue_id
where l.venue_lat_raw is not null and l.venue_lng_raw is not null and f.lat is not null
  and norm_text(l.venue_name_raw) is distinct from f.name_norm
  and not (round(l.venue_lat_raw::numeric, 1) = 37.1 and round(l.venue_lng_raw::numeric, 1) = -95.7)   -- the US centroid is not a place
  and not exists (select 1 from venue_alias a where a.alias_norm = norm_text(l.venue_name_raw) and a.venue_id = l.venue_id and a.kind <> 'source_label')
group by 1, 2, 3, 4
having avg(haversine_km(l.venue_lat_raw, l.venue_lng_raw, f.lat, f.lng)) > 0.5
union
select source_key, venue_source_id, label_norm, venue_id from by_label;

delete from venue_external_id x using far_ref b
where b.venue_source_id is not null and x.source_key = b.source_key and x.source_id = b.venue_source_id and x.venue_id = b.venue_id;
delete from venue_alias a using far_ref b
where a.alias_norm = b.label_norm and a.venue_id = b.venue_id and a.kind = 'source_label';

do $$
declare n int := 0; r record;
begin
  for r in
    select distinct l.listing_id, (l.venue_lat_raw is null) as blind from listing l join far_ref b
      on l.venue_id = b.venue_id
     and (norm_text(l.venue_name_raw) = b.label_norm
          or (b.venue_source_id is not null and l.source_key = b.source_key and l.venue_source_id = b.venue_source_id))
    where l.gone_at is null and l.night >= current_date - 7
    order by blind, l.listing_id
  loop
    perform reresolve_listing_venue(r.listing_id);
    n := n + 1;
  end loop;
  raise notice '0031: % listings resolved again', n;
end $$;
drop table if exists far_ref;

-- 4f. a placeholder filed as a real room ("TBA Brooklyn", kind venue) is a placeholder
update venue set kind = 'tba', updated_at = now()
where kind = 'venue' and name ~* '\m(tba|to be announced|secret location|location tba|venue tba)\M';

-- 4g. further passes: a label that now has a room of its own by exact name (the RA listing above just made it)
-- resolves there; anything a guess parked on a placeholder is judged again; and so is any listing sitting on a
-- room whose name its label disagrees with, when no alias or source id says it belongs there (a guess from
-- before the rules). A pass can create the room the next pass needs, so it runs until a pass changes nothing.
do $$
declare n int; total int := 0; pass int := 0; r record; before uuid; after uuid;
begin
  loop
    n := 0; pass := pass + 1;
    for r in
      select l.listing_id from listing l
      where l.gone_at is null and l.night >= current_date - 7
        and (
          exists (select 1 from venue v where v.name_norm = norm_text(l.venue_name_raw) and v.city = l.city and v.venue_id <> l.venue_id)
          or exists (select 1 from venue t where t.venue_id = l.venue_id and t.kind in ('tba', 'secret')
                     and t.name_norm is distinct from norm_text(l.venue_name_raw)
                     and not exists (select 1 from venue_alias a where a.alias_norm = norm_text(l.venue_name_raw) and a.venue_id = t.venue_id))
          or exists (select 1 from venue g where g.venue_id = l.venue_id and g.kind not in ('tba', 'secret')
                     and g.name_norm is distinct from norm_text(l.venue_name_raw)
                     and not venue_names_agree(l.venue_name_raw, g.name)
                     and not exists (select 1 from venue_alias a where a.alias_norm = norm_text(l.venue_name_raw) and a.venue_id = g.venue_id)
                     and not exists (select 1 from venue_external_id x where x.source_key = l.source_key and x.source_id = l.venue_source_id and x.venue_id = g.venue_id))
        )
        and not exists (select 1 from venue_alias a where a.alias_norm = norm_text(l.venue_name_raw) and a.venue_id = l.venue_id and a.kind <> 'source_label')
      order by (l.venue_lat_raw is null), l.listing_id
    loop
      select venue_id into before from listing where listing_id = r.listing_id;
      after := reresolve_listing_venue(r.listing_id);
      if after is distinct from before then n := n + 1; end if;
    end loop;
    total := total + n;
    exit when n = 0 or pass >= 4;
  end loop;
  raise notice '0031: later passes moved % listings in % pass(es)', total, pass;
end $$;
