-- NOCT 0011: cities. Until now the model was New York-only (venue.borough check, night_date() defaulting to
-- America/New_York, one RA area). This adds a city dimension end to end: city table, city/tz on venue, listing
-- and event, time-zone-aware night computation, city-scoped venue resolution and event matching, and the two
-- columns on event_feed. Existing rows default to nyc / America/New_York. Function bodies below are 0002/0007's
-- with only the city/tz lines changed; the old signatures are dropped so 31-argument callers keep resolving.
set search_path = public, extensions;

------------------------------------------------------------------------------
-- 1. City registry (mirror of src/lib/cities.ts)
------------------------------------------------------------------------------
create table if not exists city (
  city_key   text primary key,
  name       text not null,
  country    text not null,
  tz         text not null,
  ra_area_id int,
  hz_region  text,
  sort       int not null default 100
);
insert into city (city_key, name, country, tz, ra_area_id, hz_region, sort) values
  ('nyc', 'New York',      'US', 'America/New_York',    8,   null,         10),
  ('la',  'Los Angeles',   'US', 'America/Los_Angeles', 23,  'LosAngeles', 20),
  ('sf',  'San Francisco', 'US', 'America/Los_Angeles', 218, 'BayArea',    30),
  ('chi', 'Chicago',       'US', 'America/Chicago',     17,  'CHI',        40),
  ('mia', 'Miami',         'US', 'America/New_York',    38,  'Miami',      50),
  ('dc',  'Washington DC', 'US', 'America/New_York',    22,  'DC',         60),
  ('det', 'Detroit',       'US', 'America/New_York',    19,  'Detroit',    70),
  ('tor', 'Toronto',       'CA', 'America/Toronto',     28,  'Toronto',    80),
  ('ldn', 'London',        'UK', 'Europe/London',       13,  null,         90),
  ('ber', 'Berlin',        'DE', 'Europe/Berlin',       34,  null,         100)
on conflict (city_key) do update set name = excluded.name, country = excluded.country, tz = excluded.tz,
  ra_area_id = excluded.ra_area_id, hz_region = excluded.hz_region, sort = excluded.sort;
alter table city enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant select on table city to anon, authenticated';
    execute 'drop policy if exists city_public_read on city';
    execute 'create policy city_public_read on city for select to anon, authenticated using (true)';
  end if;
end $$;

------------------------------------------------------------------------------
-- 2. Columns
------------------------------------------------------------------------------
alter table venue   add column if not exists city text not null default 'nyc' references city(city_key);
alter table venue   drop constraint if exists venue_borough_check;              -- "borough" is now any city area
alter table listing add column if not exists city text not null default 'nyc' references city(city_key);
alter table listing add column if not exists tz   text not null default 'America/New_York';
alter table event   add column if not exists city text not null default 'nyc' references city(city_key);
alter table event   add column if not exists tz   text not null default 'America/New_York';
create index if not exists venue_city_idx      on venue (city);
create index if not exists event_city_night_idx on event (city, night) where merged_into is null;

------------------------------------------------------------------------------
-- 3. Functions (0002 bodies, city/tz aware)
------------------------------------------------------------------------------
create or replace function listing_biu() returns trigger language plpgsql as $$
declare v_norm text[];
begin
  if new.starts_at is not null then
    new.night := night_date(new.starts_at, coalesce(new.tz, 'America/New_York'));
  end if;
  select coalesce(array_agg(distinct p.name_norm), '{}') into v_norm
  from unnest(new.lineup_raw) as li, lateral parse_lineup_item(li) p;
  new.lineup_norm := v_norm;
  if new.status = 'scheduled' and title_status_flag(new.title) is not null then
    new.status := title_status_flag(new.title);
  end if;
  if tg_op = 'UPDATE' then
    if new.content_hash is distinct from old.content_hash then
      new.last_changed_at := now();
      if old.starts_at is not null and new.starts_at is not null
         and abs(extract(epoch from (new.starts_at - old.starts_at))) > 86400
         and new.status = 'scheduled' then
        new.status := 'rescheduled';
      end if;
    end if;
    if new.seen_in_run_id is distinct from old.seen_in_run_id then
      new.last_seen_at := now();
      new.miss_count := 0;
      new.gone_at := null;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists listing_biu on listing;
create trigger listing_biu before insert or update on listing for each row execute function listing_biu();

-- Create a provisional venue from a source's label when nothing resolves. Borough is guessed from the
-- address text; coordinates are kept when the source had real ones. 'TBA'/'secret' labels become tba rows.
drop function if exists create_provisional_venue(text, text, text, text, double precision, double precision);
create or replace function create_provisional_venue(p_source_key text, p_source_venue_id text, p_name text, p_addr text,
                                                    p_lat double precision, p_lng double precision, p_city text default 'nyc') returns uuid
language plpgsql as $$
declare v_id uuid; v_kind text := 'venue'; v_boro text; v_slug text;
begin
  if p_name ~* '\m(tba|to be announced|secret location|location tba|venue tba)\M' then v_kind := 'tba'; end if;
  v_boro := case when p_city <> 'nyc' then null
    when p_addr ~* '\m(brooklyn|bushwick|williamsburg|greenpoint|bed-?stuy|gowanus|red hook|sunset park|ridgewood, ny 112)' then 'Brooklyn'
    when p_addr ~* '\m(queens|ridgewood|maspeth|long island city|astoria|flushing|jamaica, ny|rockaway)' then 'Queens'
    when p_addr ~* '\m(bronx)\M' then 'Bronx'
    when p_addr ~* '\m(staten island)\M' then 'Staten Island'
    when p_addr ~* '\m(new york, ny 100|manhattan|new york, ny 101|new york, ny 102)' then 'Manhattan'
    when p_addr ~* '\m(nj|new jersey|jersey city|newark|hoboken)\M' then 'New Jersey'
    else null end;
  v_slug := left(regexp_replace(norm_text(p_name), '\s+', '-', 'g'), 60) || '-' || left(md5(coalesce(p_source_key,'') || ':' || coalesce(p_source_venue_id, norm_text(p_name)) || ':' || p_city), 6);
  insert into venue (slug, name, kind, address, borough, lat, lng, geocode_source, needs_review, city)
  values (v_slug, trim(p_name), v_kind, nullif(trim(p_addr), ''), v_boro,
          case when p_lat is not null and p_lng is not null and (p_lat <> 0 or p_lng <> 0) then p_lat end,
          case when p_lat is not null and p_lng is not null and (p_lat <> 0 or p_lng <> 0) then p_lng end,
          case when p_lat is not null then 'source:' || p_source_key end, true, p_city)
  on conflict (slug) do update set updated_at = now()
  returning venue_id into v_id;
  perform learn_venue_ref(p_source_key, p_source_venue_id, p_name, v_id);
  return v_id;
end $$;


-- Order: external id -> exact alias -> exact name -> trigram (>= 0.55) -> null
drop function if exists resolve_venue(text, text, text);
create or replace function resolve_venue(p_source_key text, p_source_venue_id text, p_name text, p_city text default 'nyc')
returns table(venue_id uuid, method text, score real)
language plpgsql stable as $$
declare n text := norm_text(p_name);
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
  return query
    select s.venue_id, 'trgm'::text, s.sim::real from (
      select a.venue_id, greatest(extensions.similarity(a.alias_norm, n), extensions.word_similarity(a.alias_norm, n) * 0.95) as sim
      from venue_alias a join venue va on va.venue_id = a.venue_id where va.city = p_city and (a.alias_norm % n or a.alias_norm <% n)
      union all
      select v.venue_id, greatest(extensions.similarity(v.name_norm, n), extensions.word_similarity(v.name_norm, n) * 0.95)
      from venue v where v.city = p_city and (v.name_norm % n or v.name_norm <% n)
    ) s where s.sim >= 0.55 order by s.sim desc limit 1;
end $$;


-- recompute canonical fields from live listings by source priority
create or replace function refresh_event(p_event_id uuid) returns void language plpgsql as $$
begin
  update event e set
    title = coalesce((select l.title from listing l join source s using (source_key)
                      where l.event_id = e.event_id and l.gone_at is null order by s.priority desc, l.first_seen_at limit 1), e.title),
    venue_id = coalesce((select l.venue_id from listing l join source s using (source_key) join venue v on v.venue_id = l.venue_id
                         where l.event_id = e.event_id and l.gone_at is null and v.kind not in ('tba','secret')
                         order by s.priority desc limit 1), e.venue_id),
    starts_at = coalesce((select l.starts_at from listing l join source s using (source_key)
                          where l.event_id = e.event_id and l.gone_at is null and l.has_time order by s.priority desc limit 1), e.starts_at),
    ends_at = coalesce((select l.ends_at from listing l join source s using (source_key)
                        where l.event_id = e.event_id and l.gone_at is null and l.ends_at is not null order by s.priority desc limit 1), e.ends_at),
    has_time = exists (select 1 from listing l where l.event_id = e.event_id and l.gone_at is null and l.has_time),
    status = case
      when exists (select 1 from listing l where l.event_id = e.event_id and l.gone_at is null and l.status = 'cancelled') then 'cancelled'
      when exists (select 1 from listing l where l.event_id = e.event_id and l.gone_at is null and l.status in ('postponed')) then 'postponed'
      when exists (select 1 from listing l where l.event_id = e.event_id and l.gone_at is null and l.status = 'rescheduled') then 'rescheduled'
      when not exists (select 1 from listing l where l.event_id = e.event_id and l.gone_at is null) then 'removed'
      else 'scheduled' end,
    age_min = coalesce((select max(l.age_min) from listing l where l.event_id = e.event_id and l.gone_at is null), e.age_min),
    genres = coalesce((select array_agg(distinct g) from listing l, unnest(l.genres) g where l.event_id = e.event_id and l.gone_at is null), '{}'),
    genre_source = (select string_agg(distinct l.source_key, ',') from listing l where l.event_id = e.event_id and l.gone_at is null and cardinality(l.genres) > 0),
    lineup_norm = coalesce((select array_agg(distinct x) from listing l, unnest(l.lineup_norm) x where l.event_id = e.event_id and l.gone_at is null), '{}'),
    lineup = coalesce((select l.lineup_raw from listing l join source s using (source_key)
                       where l.event_id = e.event_id and l.gone_at is null and cardinality(l.lineup_raw) > 0
                       order by cardinality(l.lineup_raw) desc, s.priority desc limit 1), '{}'),
    description = coalesce((select l.description from listing l join source s using (source_key)
                            where l.event_id = e.event_id and l.gone_at is null and l.description is not null order by s.priority desc limit 1), e.description),
    image_url = coalesce((select l.image_url from listing l join source s using (source_key)
                          where l.event_id = e.event_id and l.gone_at is null and l.image_url is not null order by s.priority desc limit 1), e.image_url),
    interested_count = (select max(l.interested_count) from listing l where l.event_id = e.event_id and l.gone_at is null),
    source_tags = coalesce((select jsonb_object_agg(l.source_key, l.source_tags) from listing l where l.event_id = e.event_id and l.gone_at is null), '{}'),
    external_refs = coalesce((select jsonb_agg(distinct r) from (
                        select jsonb_build_object('source', l.source_key, 'id', l.source_id) r from listing l where l.event_id = e.event_id
                        union select r from listing l, jsonb_array_elements(l.external_refs) r where l.event_id = e.event_id) q), '[]'),
    listing_count = (select count(*) from listing l where l.event_id = e.event_id and l.gone_at is null),
    city = coalesce((select l.city from listing l join source s using (source_key) where l.event_id = e.event_id and l.gone_at is null order by s.priority desc limit 1), e.city),
    tz = coalesce((select l.tz from listing l join source s using (source_key) where l.event_id = e.event_id and l.gone_at is null order by s.priority desc limit 1), e.tz),
    updated_at = now()
  where e.event_id = p_event_id;
  update event e set night = night_date(e.starts_at, e.tz) where e.event_id = p_event_id and e.starts_at is not null and e.has_time;
end $$;


create or replace function resolve_listing(p_listing_id bigint,
                                           p_auto_threshold real default 0.78,
                                           p_review_threshold real default 0.55)
returns table(event_id uuid, method text, score real)
language plpgsql as $$
#variable_conflict use_column
declare l listing%rowtype; best record; v_event uuid; v_method text;
begin
  select * into l from listing where listing_id = p_listing_id;
  if l.gone_at is not null then return; end if;

  if to_regclass('pg_temp._cand') is null then
    create temp table _cand (event_id uuid primary key, score real, features jsonb) on commit drop;
  else
    delete from _cand;
  end if;
  insert into _cand
  select e.event_id, s.score, s.features
  from event e, lateral score_listing_event(l.listing_id, e.event_id) s
  where e.merged_into is null
    and e.city = l.city
    and e.night between l.night - 1 and l.night + 1
    and (
         (l.venue_id is not null and e.venue_id is not null and venue_family(l.venue_id) = venue_family(e.venue_id))
      or l.venue_id is null or e.venue_id is null
      or exists (select 1 from venue vv where vv.venue_id in (l.venue_id, e.venue_id) and vv.kind in ('tba','secret'))
      or e.title_sim_key % l.title_sim_key
      or e.external_refs @> jsonb_build_array(jsonb_build_object('source', l.source_key, 'id', l.source_id))
    )
  on conflict do nothing;

  select c.event_id, c.score, c.features into best from _cand c order by c.score desc limit 1;

  if best.event_id is not null and best.score >= p_auto_threshold then
    v_event := best.event_id;
    v_method := case when (best.features->>'hard_link')::boolean then 'external_ref' when best.score >= 0.999 then 'exact' else 'fuzzy' end;
    insert into match_candidate(listing_id, event_id, score, features, decision, decided_at)
    values (l.listing_id, v_event, best.score, best.features, 'auto_merged', now())
    on conflict (listing_id, event_id) do update set score = excluded.score, features = excluded.features, decision = 'auto_merged', decided_at = now();
  else
    insert into match_candidate(listing_id, event_id, score, features)
    select l.listing_id, c.event_id, c.score, c.features from _cand c where c.score >= p_review_threshold
    on conflict (listing_id, event_id) do update set score = excluded.score, features = excluded.features;
    select e.event_id into v_event from event e
    where e.merged_into is null and e.venue_id is not distinct from l.venue_id and e.venue_id is not null
      and e.night = l.night and e.title_norm = l.title_norm limit 1;
    if v_event is not null then
      v_method := 'exact';
    else
      insert into event(title, venue_id, starts_at, ends_at, has_time, night, status, age_min, genres, genre_source, lineup_norm, lineup,
                        description, image_url, interested_count, external_refs, city, tz)
      values (l.title, l.venue_id, l.starts_at, l.ends_at, l.has_time, l.night, l.status, l.age_min, l.genres, l.source_key, l.lineup_norm, l.lineup_raw,
              l.description, l.image_url, l.interested_count,
              l.external_refs || jsonb_build_array(jsonb_build_object('source', l.source_key, 'id', l.source_id)), l.city, l.tz)
      returning event.event_id into v_event;
      v_method := 'new';
    end if;
  end if;

  update listing set event_id = v_event, match_score = coalesce(best.score, 1.0), match_method = v_method, matched_at = now()
  where listing_id = l.listing_id;
  perform refresh_event(v_event);
  return query select v_event, v_method, coalesce(best.score, 1.0)::real;
end $$;


drop function if exists upsert_listing(text,text,text,jsonb,bigint,text,timestamptz,timestamptz,boolean,date,text,text,text,double precision,double precision,text[],numeric,numeric,boolean,text,jsonb,boolean,text,integer,text[],text[],text,text,integer,jsonb,jsonb);
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
declare v_id bigint; v_hash text; v_venue uuid; v_event uuid; v_old_hash text; v_new boolean := false;
begin
  v_hash := md5(concat_ws('|', p_title, p_starts_at, p_ends_at, p_venue_name, array_to_string(p_lineup, ','), p_price_min, p_price_max, p_sold_out, p_status, p_age_min, array_to_string(p_genres, ',')));
  select l.content_hash into v_old_hash from listing l where l.source_key = p_source_key and l.source_id = p_source_id;
  select r.venue_id into v_venue from resolve_venue(p_source_key, p_venue_source_id, p_venue_name, p_city) r limit 1;
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
  -- remember how this source labels the venue, so the next run resolves by exact alias
  perform learn_venue_ref(p_source_key, p_venue_source_id, p_venue_name, v_venue);
  if v_event is not null then perform refresh_event(v_event); end if;
  return query select v_id, v_new, (v_old_hash is distinct from v_hash), v_event;
end $$;

------------------------------------------------------------------------------
-- 4. Views (0007 bodies + city, tz)
------------------------------------------------------------------------------
drop view if exists event_feed;
drop view if exists event_offer;

do $$
declare
  offer_sql text := $v$
    select
      l.event_id,
      l.listing_id,
      l.source_key            as platform,
      s.display_name          as platform_name,
      s.priority              as platform_priority,
      l.source_url,
      t.tier,
      t.price,
      t.fees_included,
      t.available,
      t.note,
      l.sold_out,
      l.last_seen_at
    from listing l
    join source s on s.source_key = l.source_key
    cross join lateral (
      -- one row per stored tier; a listing without tiers still yields one offer from its listing-level price
      select lp.tier,
             lp.price,
             coalesce(lp.fees_included, l.fees_included, s.fees_included_default) as fees_included,
             coalesce(lp.available, case when l.sold_out then false end)          as available,
             lp.note
      from listing_price lp where lp.listing_id = l.listing_id
      union all
      select 'GA',
             l.price_min,
             coalesce(l.fees_included, s.fees_included_default),
             case when l.sold_out then false when l.sold_out = false then true end,
             l.price_note
      where not exists (select 1 from listing_price lp where lp.listing_id = l.listing_id)
    ) t
    where l.event_id is not null
      and l.gone_at is null
      and s.is_ticketer                    -- aggregators (EDMTrain) and venue pages (Good Room, Public Records) are not offers
    order by l.event_id, (t.available is not false) desc, t.price nulls last, s.priority desc
  $v$;
  feed_sql text := $v$
    select
      e.event_id, e.title, e.night, e.starts_at, e.ends_at, e.has_time, e.status,
      e.venue_id,
      v.name                                   as venue_name,
      v.kind                                   as venue_kind,
      v.slug                                   as venue_slug,
      fam.venue_id                             as family_id,
      fam.name                                 as family_name,     -- room -> complex (Great Hall -> Avant Gardner)
      coalesce(v.borough, fam.borough)         as borough,
      coalesce(v.neighborhood, fam.neighborhood) as neighborhood,
      coalesce(v.address, fam.address)         as address,
      coalesce(v.lat, fam.lat)                 as lat,
      coalesce(v.lng, fam.lng)                 as lng,
      coalesce(v.outdoor, fam.outdoor)         as outdoor,
      e.age_min, e.lineup, e.description, e.image_url, e.interested_count,
      e.genres, e.genre_source,                                     -- raw source labels + which sources tagged
      e.primary_genre, g.label as primary_genre_label,
      e.genre_codes, gl.labels as genre_labels, gl.tags as genre_tags, e.genre_confidence,   -- tags: [{code,label}] in genre_codes order
      e.vibe_codes, vb.vibes,                                       -- [{code,label,glyph,kind}] in vibe_codes order
      e.energy, e.darkness, e.crowd_size, e.start_lateness, e.end_lateness, e.price_tier, e.underground_index,
      e.sound_summary, e.is_electronic, e.needs_review,
      e.listing_count,
      ls.platforms,                                                 -- display names of every live source, best first
      ls.sources,                                                   -- [{source,name,url}] every live listing's link
      o.cheapest_price,                                             -- min price over offers not known to be unavailable
      coalesce(so.verdict, o.all_unavailable) as sold_out,          -- ticketers' own verdict; else every offer unavailable
      coalesce(gc.n, 0)                        as going_count,
      e.updated_at,
      e.city, e.tz                                                  -- 0011: multi-city
    from event e
    left join venue v   on v.venue_id = e.venue_id
    left join venue fam on fam.venue_id = coalesce(v.parent_venue_id, v.venue_id)
    left join genre g   on g.code = e.primary_genre
    left join going_count gc on gc.event_id = e.event_id
    left join lateral (
      -- left join: a code the taxonomy no longer knows keeps its position (label null) instead of shifting the others
      select array_agg(gg.label order by u.ord) filter (where gg.label is not null)            as labels,
             jsonb_agg(jsonb_build_object('code', u.code, 'label', gg.label) order by u.ord) as tags
      from unnest(e.genre_codes) with ordinality u(code, ord) left join genre gg on gg.code = u.code
    ) gl on true
    left join lateral (
      select jsonb_agg(jsonb_build_object('code', vv.code, 'label', vv.label, 'glyph', vv.glyph, 'kind', vv.kind) order by u.ord) as vibes
      from unnest(e.vibe_codes) with ordinality u(code, ord) join vibe vv on vv.code = u.code
    ) vb on true
    left join lateral (
      select array_agg(q.display_name order by q.priority desc) as platforms,
             jsonb_agg(jsonb_build_object('source', q.source_key, 'name', q.display_name, 'url', q.source_url) order by q.priority desc) as sources
      from (
        select distinct on (l.source_key) l.source_key, l.source_url, s.display_name, s.priority
        from listing l join source s on s.source_key = l.source_key
        where l.event_id = e.event_id and l.gone_at is null
        order by l.source_key, l.first_seen_at
      ) q
    ) ls on true
    left join lateral (
      select min(x.price) filter (where x.available is not false) as cheapest_price,
             coalesce(bool_and(x.available is false), false)       as all_unavailable
      from event_offer x where x.event_id = e.event_id
    ) o on true
    left join lateral (
      -- sold out only when every live ticketing listing WITH an opinion says so. RA marks expired tiers
      -- NOLONGERONSALE (available = false) while door sales may remain, so "every offer unavailable" would call
      -- those nights sold out against RA's own verdict; it is only the fallback when no listing states sold_out.
      select bool_and(l.sold_out) as verdict
      from listing l join source s on s.source_key = l.source_key
      where l.event_id = e.event_id and l.gone_at is null and s.is_ticketer and l.sold_out is not null
    ) so on true
    where e.merged_into is null and e.status <> 'removed'
  $v$;
begin
  begin
    execute 'create view event_offer with (security_invoker = true) as ' || offer_sql;
    execute 'create view event_feed  with (security_invoker = true) as ' || feed_sql;
  exception when invalid_parameter_value then
    -- PostgreSQL < 15 (local dev): no security_invoker option; owner-privilege views with the same shape
    raise notice 'security_invoker unsupported on this server; creating plain views (local dev only)';
    execute 'drop view if exists event_feed';
    execute 'drop view if exists event_offer';
    execute 'create view event_offer as ' || offer_sql;
    execute 'create view event_feed  as ' || feed_sql;
  end;
end $$;


comment on view event_offer is 'Live ticket offers per event (ticketing sources only), available-first cheapest-first. security_invoker on Supabase.';
comment on view event_feed  is 'Canonical events with venue family, enrichment, offer summary, city and tz; excludes merged and removed events. security_invoker on Supabase.';
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant select on event_feed, event_offer to anon, authenticated';
  end if;
end $$;
