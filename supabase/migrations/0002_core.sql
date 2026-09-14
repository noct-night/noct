-- NOCT 0002: core ingestion + entity-resolution schema.
-- Two layers: per-source `listing` rows (raw + normalised, keyed UNIQUE(source_key, source_id)) and the
-- canonical `event` each listing resolves to. Venues and artists are canonicalised with alias tables.
-- Everything is idempotent so the file can be re-applied.
set search_path = public, extensions;

------------------------------------------------------------------------------
-- 1. Normalisation primitives
------------------------------------------------------------------------------
-- unaccent(text) is STABLE; the 2-arg regdictionary form can be wrapped IMMUTABLE for generated columns/indexes.
create or replace function imm_unaccent(t text) returns text
language sql immutable parallel safe strict
as $$ select extensions.unaccent('extensions.unaccent'::regdictionary, t) $$;

-- light normalisation: lower, strip accents, collapse non-alphanumerics to single spaces
create or replace function norm_text(t text) returns text
language sql immutable parallel safe strict
as $$
  select nullif(trim(regexp_replace(regexp_replace(lower(imm_unaccent(t)), '[^a-z0-9]+', ' ', 'g'), '\s+', ' ', 'g')), '')
$$;

-- aggressive title normalisation used ONLY as similarity input (never for uniqueness)
create or replace function norm_title(t text) returns text
language sql immutable parallel safe strict
as $$
  select norm_text(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(lower(imm_unaccent(t)),
            '\s*[\(\[][^\)\]]*[\)\]]', ' ', 'g'),                      -- "(Day & Night)", "[CANCELLED]"
          '\s*(\+|&|and|,)\s*(many\s+)?more\M.*$', ' ', 'g'),          -- "+ more", ", and many more"
        '\s+(@|at)\s+[^,:]+$', ' ', 'g'),                            -- trailing " at Knockdown Center"
      '\m(presents?|pres|w|with|feat|ft|featuring|invites?|tickets?|official|the|a|an|nyc|new york|brooklyn|queens|manhattan)\M', ' ', 'g')
  )
$$;

-- flags carried in titles by RA/promoters: "[CANCELLED] ...", "POSTPONED: ..."
create or replace function title_status_flag(t text) returns text
language sql immutable parallel safe strict
as $$
  select case
    when t ~* '\m(cancell?ed|canceled)\M' then 'cancelled'
    when t ~* '\m(postponed|rescheduled|new date)\M' then 'postponed'
    else null end
$$;

-- lineup item -> one row per artist ("A b2b B" -> 2 rows sharing group_pos)
create or replace function parse_lineup_item(item text)
returns table(name_display text, name_norm text, is_live boolean, disambig text, group_pos int, split_from_group boolean)
language sql immutable parallel safe strict
as $$
  with parts as (
    select p, ord::int as ord, count(*) over () as n
    from regexp_split_to_table(item, '\s+(?:b2b|b3b|b4b|vs\.?|versus)\s+', 'i') with ordinality as t(p, ord)
  ),
  c as (
    select
      p, ord, n,
      p ~* '\((live|hybrid( set)?|live set|live pa)\)|\m(live|live set|hybrid set)\M\s*$' as is_live,
      upper((regexp_match(p, '\((us|uk|de|fr|it|es|nl|be|jp|au|ca|br|mx|ar|cl|co|za|ie|pt|pl|se|no|dk|fi|ch|at|ru|il|tr|kr|cn|in|nz|gr|cz|hu|ro|ua|lt|lv|ee|ge|am|az)\)', 'i'))[1]) as disambig,
      trim(regexp_replace(regexp_replace(p,
             '\s*\([^)]*\)', ' ', 'g'),
             '\s*\m(all night( long)?|all day( long)?|extended set|open to close|dj set|hybrid set|live set|live|closing set|opening set|b2b)\M\s*$', ' ', 'gi')) as display
    from parts
  )
  select display, norm_text(display), is_live, disambig, ord, n > 1 from c where norm_text(display) is not null
$$;

create or replace function arr_jaccard(a text[], b text[]) returns real
language sql immutable parallel safe
as $$
  select case when coalesce(cardinality(a),0)=0 or coalesce(cardinality(b),0)=0 then 0::real
    else (select count(*) from (select unnest(a) intersect select unnest(b)) i)::real
       / (select count(*) from (select unnest(a) union select unnest(b)) u)::real end
$$;

-- overlap coefficient: |A∩B| / min(|A|,|B|). Robust when one source lists headliners only.
create or replace function lineup_sim(a text[], b text[]) returns real
language sql immutable parallel safe
as $$
  select case when coalesce(cardinality(a),0)=0 or coalesce(cardinality(b),0)=0 then 0::real
    else (select count(*) from unnest(a) x
          where exists (select 1 from unnest(b) y where x = y or extensions.similarity(x, y) >= 0.8))::real
         / least(cardinality(a), cardinality(b))::real end
$$;

-- "nightlife date": anything before 06:00 local belongs to the previous calendar night
create or replace function night_date(ts timestamptz, tz text default 'America/New_York') returns date
language sql stable parallel safe
as $$ select ((ts at time zone tz) - interval '6 hours')::date $$;

------------------------------------------------------------------------------
-- 2. Reference tables
------------------------------------------------------------------------------
create table if not exists source (
  source_key   text primary key,              -- 'ra','dice','edmtrain','ticketmaster','elsewhere','goodroom','publicrecords'
  display_name text not null,
  kind         text not null check (kind in ('api','scrape','feed','manual')),
  priority     int  not null default 50,      -- higher wins when choosing canonical title/time/venue
  fees_included_default boolean not null default false,
  is_ticketer  boolean not null default true, -- false for aggregators whose link is not a ticket offer (EDMTrain)
  tos_notes    text,
  enabled      boolean not null default true
);

insert into source (source_key, display_name, kind, priority, fees_included_default, is_ticketer, tos_notes) values
  ('ra',            'Resident Advisor', 'api',    90, true,  true,  'Undocumented public GraphQL endpoint used by ra.co. RA Terms 4.4(a)/(f) restrict automated extraction without written agreement.'),
  ('dice',          'DICE',             'api',    80, true,  true,  'DICE Events API v2 with a DICE-issued x-api-key. US Terms 8.4 restrict automated crawling; key must come from DICE.'),
  ('elsewhere',     'Elsewhere',        'feed',   70, true,  true,  'Venue-owned Next.js page data (events.json). Tickets on Eventbrite.'),
  ('publicrecords', 'Public Records',   'scrape', 65, false, false, 'Venue homepage listing; tickets via DICE short links.'),
  ('goodroom',      'Good Room',        'feed',   60, false, false, 'Venue WordPress RSS + homepage; tickets on RA/DICE/Eventbrite.'),
  ('ticketmaster',  'Ticketmaster',     'api',    50, false, true,  'Official Discovery API v2 (free key, 5000 calls/day). No long-term caching per terms.'),
  ('edmtrain',      'EDMTrain',         'api',    40, false, false, 'Official API (client key). Terms forbid combining with other sources in a competing discovery service; disabled unless licensed.')
on conflict (source_key) do update set display_name = excluded.display_name, kind = excluded.kind, priority = excluded.priority,
  fees_included_default = excluded.fees_included_default, is_ticketer = excluded.is_ticketer, tos_notes = excluded.tos_notes;

create table if not exists venue (
  venue_id         uuid primary key default gen_random_uuid(),
  slug             text unique,
  name             text not null,
  name_norm        text generated always as (norm_text(name)) stored,
  kind             text not null default 'venue' check (kind in ('venue','complex','room','outdoor','tba','secret')),
  parent_venue_id  uuid references venue(venue_id),        -- room -> complex (Great Hall -> Avant Gardner)
  address          text,
  postal_code      text,
  borough          text check (borough in ('Manhattan','Brooklyn','Queens','Bronx','Staten Island','New Jersey','Other')),
  neighborhood     text,
  nta2020          text,
  lat              double precision,
  lng              double precision,
  geocode_source   text,
  geocode_conf     real,
  website          text,
  instagram        text,
  ra_url           text,
  dice_url         text,
  capacity         int,
  needs_review     boolean not null default false,
  verified         boolean not null default false,          -- address/handle confirmed by a human
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists venue_name_trgm on venue using gin (name_norm extensions.gin_trgm_ops);
create index if not exists venue_parent_idx on venue (parent_venue_id);

create table if not exists venue_alias (
  alias_norm  text primary key,                -- norm_text(alias)
  alias       text not null,
  venue_id    uuid not null references venue(venue_id) on delete cascade,
  kind        text not null default 'alias' check (kind in ('official','room','former_name','abbrev','source_label','alias')),
  source_key  text references source(source_key)
);
create index if not exists venue_alias_trgm on venue_alias using gin (alias_norm extensions.gin_trgm_ops);
create index if not exists venue_alias_venue_idx on venue_alias (venue_id);

create table if not exists venue_external_id (
  source_key  text not null references source(source_key),
  source_id   text not null,                   -- RA club id '69401', DICE venue id, EDMTrain venue.id, TM venue id
  venue_id    uuid not null references venue(venue_id) on delete cascade,
  primary key (source_key, source_id)
);

create table if not exists artist (
  artist_id      uuid primary key default gen_random_uuid(),
  name           text not null,
  name_norm      text generated always as (norm_text(name)) stored,
  disambig       text,
  dmeta          text generated always as (extensions.dmetaphone(norm_text(name))) stored,
  mbid           uuid,
  ra_artist_id   text,
  needs_review   boolean not null default false,
  created_at     timestamptz not null default now()
);
create index if not exists artist_name_trgm on artist using gin (name_norm extensions.gin_trgm_ops);
create index if not exists artist_dmeta_idx on artist (dmeta);
create unique index if not exists artist_name_disambig_uq on artist (name_norm, coalesce(disambig,''));

create table if not exists artist_alias (
  alias_norm text primary key,
  artist_id  uuid not null references artist(artist_id) on delete cascade,
  kind       text not null default 'alias'
);
create table if not exists artist_external_id (
  source_key text not null references source(source_key),
  source_id  text not null,
  artist_id  uuid not null references artist(artist_id) on delete cascade,
  primary key (source_key, source_id)
);

------------------------------------------------------------------------------
-- 3. Ingestion runs + per-source listings (the raw layer)
------------------------------------------------------------------------------
create table if not exists ingest_run (
  run_id        bigint generated always as identity primary key,
  source_key    text not null references source(source_key),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running' check (status in ('running','ok','partial','failed','skipped')),
  window_start  date, window_end date,           -- the date range this run fully enumerated (for tombstoning)
  listings_seen int default 0, listings_new int default 0, listings_changed int default 0, listings_resolved int default 0,
  warnings      text[] not null default '{}',
  error         text,
  trigger       text                              -- 'cron' | 'pg_cron' | 'manual' | 'cli'
);
create index if not exists ingest_run_source_idx on ingest_run (source_key, started_at desc);

create table if not exists event (
  event_id        uuid primary key default gen_random_uuid(),
  title           text not null,
  title_norm      text generated always as (norm_text(title)) stored,
  title_sim_key   text generated always as (norm_title(title)) stored,
  venue_id        uuid references venue(venue_id),
  starts_at       timestamptz,
  ends_at         timestamptz,
  has_time        boolean not null default false,
  night           date not null,                   -- night_date(starts_at) or source date
  status          text not null default 'scheduled' check (status in ('scheduled','cancelled','postponed','rescheduled','removed')),
  prev_starts_at  timestamptz,
  age_min         smallint,
  genres          text[] not null default '{}',    -- raw source genre labels (union); enrichment writes the taxonomy
  genre_source    text,
  lineup_norm     text[] not null default '{}',
  lineup          text[] not null default '{}',    -- display names, best source first
  description     text,
  image_url       text,
  interested_count int,
  source_tags     jsonb not null default '{}',     -- {"ra": {...}, "dice": {...}} merged per source
  external_refs   jsonb not null default '[]',
  merged_into     uuid references event(event_id),
  listing_count   int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists event_night_venue_idx on event (night, venue_id) where merged_into is null;
create index if not exists event_night_idx on event (night) where merged_into is null;
create index if not exists event_title_trgm on event using gin (title_sim_key extensions.gin_trgm_ops);
create index if not exists event_refs_gin on event using gin (external_refs jsonb_path_ops);
create unique index if not exists event_dupe_guard on event (venue_id, night, title_norm) where merged_into is null and venue_id is not null;

create table if not exists listing (
  listing_id      bigint generated always as identity primary key,
  source_key      text not null references source(source_key),
  source_id       text not null,
  source_url      text,
  raw             jsonb not null,
  content_hash    text not null,                 -- md5 of the normalised business fields (NOT of raw, which carries volatile counters)
  title           text not null,
  title_norm      text generated always as (norm_text(title)) stored,
  title_sim_key   text generated always as (norm_title(title)) stored,
  status_flag     text generated always as (title_status_flag(title)) stored,
  status          text not null default 'scheduled' check (status in ('scheduled','cancelled','postponed','rescheduled','unknown')),
  starts_at       timestamptz,
  ends_at         timestamptz,
  has_time        boolean not null default true,
  night           date not null,
  venue_name_raw  text,
  venue_addr_raw  text,
  venue_source_id text,
  venue_lat_raw   double precision,
  venue_lng_raw   double precision,
  venue_id        uuid references venue(venue_id),
  lineup_raw      text[] not null default '{}',
  lineup_norm     text[] not null default '{}',
  artist_ids      uuid[] not null default '{}',
  price_min       numeric(8,2), price_max numeric(8,2), currency char(3) not null default 'USD',
  fees_included   boolean,
  price_note      text,
  sold_out        boolean,
  age_min         smallint,
  genres          text[] not null default '{}',
  promoters       text[] not null default '{}',
  description     text,
  image_url       text,
  interested_count int,
  source_tags     jsonb not null default '{}',
  external_refs   jsonb not null default '[]',
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  last_changed_at timestamptz not null default now(),
  seen_in_run_id  bigint references ingest_run(run_id),
  miss_count      int not null default 0,
  gone_at         timestamptz,
  event_id        uuid references event(event_id),
  match_score     real,
  match_method    text check (match_method in ('external_ref','exact','fuzzy','manual','new')),
  matched_at      timestamptz,
  unique (source_key, source_id)
);
create index if not exists listing_event_idx  on listing (event_id);
create index if not exists listing_live_idx   on listing (source_key, night) where gone_at is null;
create index if not exists listing_title_trgm on listing using gin (title_sim_key extensions.gin_trgm_ops);
create index if not exists listing_unresolved on listing (listing_id) where event_id is null and gone_at is null;
create index if not exists listing_refs_gin   on listing using gin (external_refs jsonb_path_ops);

create table if not exists listing_price (
  listing_id    bigint not null references listing(listing_id) on delete cascade,
  tier          text not null,
  price         numeric(8,2),
  fees_included boolean,
  available     boolean,
  note          text,
  primary key (listing_id, tier)
);

create table if not exists listing_version (
  listing_id   bigint not null references listing(listing_id) on delete cascade,
  observed_at  timestamptz not null default now(),
  content_hash text not null,
  snapshot     jsonb not null,
  primary key (listing_id, observed_at)
);

create table if not exists event_artist (
  event_id   uuid not null references event(event_id) on delete cascade,
  artist_id  uuid not null references artist(artist_id),
  position   int  not null,
  group_pos  int,
  is_live    boolean not null default false,
  primary key (event_id, artist_id)
);

create table if not exists match_candidate (
  listing_id  bigint not null references listing(listing_id) on delete cascade,
  event_id    uuid   not null references event(event_id) on delete cascade,
  score       real   not null,
  features    jsonb  not null,
  decision    text   not null default 'pending' check (decision in ('pending','auto_merged','auto_rejected','human_merged','human_rejected')),
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  primary key (listing_id, event_id)
);
create index if not exists match_candidate_pending on match_candidate (created_at) where decision = 'pending';

create table if not exists event_merge_log (
  from_event_id uuid not null,
  into_event_id uuid not null,
  reason        text,
  merged_at     timestamptz not null default now()
);

------------------------------------------------------------------------------
-- 4. Triggers: derive night/lineup_norm, keep history, resurrect tombstones
------------------------------------------------------------------------------
create or replace function listing_biu() returns trigger language plpgsql as $$
declare v_norm text[];
begin
  if new.starts_at is not null then
    new.night := night_date(new.starts_at);
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

create or replace function listing_history_aiu() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.content_hash is distinct from old.content_hash then
    insert into listing_version(listing_id, content_hash, snapshot)
    values (new.listing_id, new.content_hash, jsonb_build_object(
      'title', new.title, 'starts_at', new.starts_at, 'ends_at', new.ends_at, 'venue_name_raw', new.venue_name_raw,
      'lineup_raw', new.lineup_raw, 'price_min', new.price_min, 'price_max', new.price_max,
      'sold_out', new.sold_out, 'status', new.status))
    on conflict do nothing;
  end if;
  return null;
end $$;
drop trigger if exists listing_history_aiu on listing;
create trigger listing_history_aiu after insert or update on listing for each row execute function listing_history_aiu();

------------------------------------------------------------------------------
-- 5. Venue resolution
------------------------------------------------------------------------------
create or replace function venue_family(v uuid) returns uuid
language sql stable as $$ select coalesce((select parent_venue_id from venue where venue_id = v), v) $$;

-- Order: external id -> exact alias -> exact name -> trigram (>= 0.55) -> null
create or replace function resolve_venue(p_source_key text, p_source_venue_id text, p_name text)
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
  return query select a.venue_id, 'alias_exact'::text, 1.0::real from venue_alias a where a.alias_norm = n limit 1;
  if found then return; end if;
  return query select v.venue_id, 'name_exact'::text, 1.0::real from venue v where v.name_norm = n limit 1;
  if found then return; end if;
  if length(n) < 4 then return; end if;
  return query
    select s.venue_id, 'trgm'::text, s.sim::real from (
      select a.venue_id, greatest(extensions.similarity(a.alias_norm, n), extensions.word_similarity(a.alias_norm, n) * 0.95) as sim
      from venue_alias a where a.alias_norm % n or a.alias_norm <% n
      union all
      select v.venue_id, greatest(extensions.similarity(v.name_norm, n), extensions.word_similarity(v.name_norm, n) * 0.95)
      from venue v where v.name_norm % n or v.name_norm <% n
    ) s where s.sim >= 0.55 order by s.sim desc limit 1;
end $$;

-- Learn a source's venue id / label once a listing has been resolved to a venue (idempotent).
create or replace function learn_venue_ref(p_source_key text, p_source_venue_id text, p_label text, p_venue_id uuid) returns void
language plpgsql as $$
begin
  if p_venue_id is null then return; end if;
  if p_source_venue_id is not null then
    insert into venue_external_id(source_key, source_id, venue_id) values (p_source_key, p_source_venue_id, p_venue_id)
    on conflict do nothing;
  end if;
  if norm_text(p_label) is not null then
    insert into venue_alias(alias_norm, alias, venue_id, kind, source_key) values (norm_text(p_label), p_label, p_venue_id, 'source_label', p_source_key)
    on conflict do nothing;
  end if;
end $$;

-- Create a provisional venue from a source's label when nothing resolves. Borough is guessed from the
-- address text; coordinates are kept when the source had real ones. 'TBA'/'secret' labels become tba rows.
create or replace function create_provisional_venue(p_source_key text, p_source_venue_id text, p_name text, p_addr text,
                                                    p_lat double precision, p_lng double precision) returns uuid
language plpgsql as $$
declare v_id uuid; v_kind text := 'venue'; v_boro text; v_slug text;
begin
  if p_name ~* '\m(tba|to be announced|secret location|location tba|venue tba)\M' then v_kind := 'tba'; end if;
  v_boro := case
    when p_addr ~* '\m(brooklyn|bushwick|williamsburg|greenpoint|bed-?stuy|gowanus|red hook|sunset park|ridgewood, ny 112)' then 'Brooklyn'
    when p_addr ~* '\m(queens|ridgewood|maspeth|long island city|astoria|flushing|jamaica, ny|rockaway)' then 'Queens'
    when p_addr ~* '\m(bronx)\M' then 'Bronx'
    when p_addr ~* '\m(staten island)\M' then 'Staten Island'
    when p_addr ~* '\m(new york, ny 100|manhattan|new york, ny 101|new york, ny 102)' then 'Manhattan'
    when p_addr ~* '\m(nj|new jersey|jersey city|newark|hoboken)\M' then 'New Jersey'
    else null end;
  v_slug := left(regexp_replace(norm_text(p_name), '\s+', '-', 'g'), 60) || '-' || left(md5(coalesce(p_source_key,'') || ':' || coalesce(p_source_venue_id, norm_text(p_name))), 6);
  insert into venue (slug, name, kind, address, borough, lat, lng, geocode_source, needs_review)
  values (v_slug, trim(p_name), v_kind, nullif(trim(p_addr), ''), v_boro,
          case when p_lat is not null and p_lng is not null and (p_lat <> 0 or p_lng <> 0) then p_lat end,
          case when p_lat is not null and p_lng is not null and (p_lat <> 0 or p_lng <> 0) then p_lng end,
          case when p_lat is not null then 'source:' || p_source_key end, true)
  on conflict (slug) do update set updated_at = now()
  returning venue_id into v_id;
  perform learn_venue_ref(p_source_key, p_source_venue_id, p_name, v_id);
  return v_id;
end $$;

------------------------------------------------------------------------------
-- 6. Pairwise scoring
------------------------------------------------------------------------------
create or replace function date_sim(a_start timestamptz, a_has_time bool, a_night date,
                                    b_start timestamptz, b_has_time bool, b_night date) returns real
language sql immutable parallel safe as $$
  select case
    when a_has_time and b_has_time and a_start is not null and b_start is not null then
      case when abs(extract(epoch from (a_start - b_start))) <= 3*3600 then 1.0
           when abs(extract(epoch from (a_start - b_start))) <= 8*3600 then 0.8
           when a_night = b_night then 0.5
           else 0 end
    when a_night = b_night then 0.9
    when abs(a_night - b_night) = 1 then 0.6
    else 0 end::real
$$;

create or replace function venue_sim(a uuid, b uuid) returns real
language plpgsql stable as $$
declare ka text; kb text;
begin
  if a is null and b is null then return 0.5; end if;
  select kind into ka from venue where venue_id = a;
  select kind into kb from venue where venue_id = b;
  if a is null or b is null or ka in ('tba','secret') or kb in ('tba','secret') then return 0.4; end if;
  if a = b then return 1.0; end if;
  if venue_family(a) = venue_family(b) then return 0.9; end if;
  return 0;
end $$;

create or replace function title_sim(a text, b text) returns real
language sql immutable parallel safe as $$
  select case when a is null or b is null then 0
    else greatest(extensions.similarity(a, b),
                  extensions.word_similarity(case when length(a) <= length(b) then a else b end,
                                             case when length(a) <= length(b) then b else a end) * 0.9) end::real
$$;

create or replace function score_listing_event(p_listing_id bigint, p_event_id uuid)
returns table(score real, features jsonb)
language plpgsql stable as $$
declare l listing%rowtype; e event%rowtype;
        s_venue real; s_date real; s_title real; s_lineup real; hard boolean; w_v real; w_t real; w_l real; w_d real; s real;
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
  end if;
  return query select s::real, jsonb_build_object('hard_link', hard, 'date', s_date, 'venue', s_venue, 'title', s_title, 'lineup', s_lineup,
                                                  'l_lineup_n', cardinality(l.lineup_norm), 'e_lineup_n', cardinality(e.lineup_norm));
end $$;

------------------------------------------------------------------------------
-- 7. Canonical refresh + resolution driver
------------------------------------------------------------------------------
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
    updated_at = now()
  where e.event_id = p_event_id;
  update event e set night = night_date(e.starts_at) where e.event_id = p_event_id and e.starts_at is not null and e.has_time;
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
                        description, image_url, interested_count, external_refs)
      values (l.title, l.venue_id, l.starts_at, l.ends_at, l.has_time, l.night, l.status, l.age_min, l.genres, l.source_key, l.lineup_norm, l.lineup_raw,
              l.description, l.image_url, l.interested_count,
              l.external_refs || jsonb_build_array(jsonb_build_object('source', l.source_key, 'id', l.source_id)))
      returning event.event_id into v_event;
      v_method := 'new';
    end if;
  end if;

  update listing set event_id = v_event, match_score = coalesce(best.score, 1.0), match_method = v_method, matched_at = now()
  where listing_id = l.listing_id;
  perform refresh_event(v_event);
  return query select v_event, v_method, coalesce(best.score, 1.0)::real;
end $$;

-- Resolve every unresolved live listing for a source (or all). Returns how many were linked/created.
create or replace function resolve_pending(p_source_key text default null, p_limit int default 5000) returns int
language plpgsql as $$
declare r record; n int := 0;
begin
  for r in select listing_id from listing
           where event_id is null and gone_at is null and (p_source_key is null or source_key = p_source_key)
           order by night, listing_id limit p_limit
  loop
    perform resolve_listing(r.listing_id);
    n := n + 1;
  end loop;
  return n;
end $$;

------------------------------------------------------------------------------
-- 8. Tombstone sweep (call after each run with status='ok' and a fully enumerated window)
------------------------------------------------------------------------------
create or replace function tombstone_sweep(p_run_id bigint, p_miss_limit int default 2) returns int
language plpgsql as $$
declare r ingest_run%rowtype; n int;
begin
  select * into r from ingest_run where run_id = p_run_id;
  if r.status <> 'ok' or r.window_start is null then return 0; end if;
  update listing set miss_count = miss_count + 1
  where source_key = r.source_key and gone_at is null
    and night between r.window_start and r.window_end
    and (seen_in_run_id is distinct from p_run_id);
  update listing set gone_at = now()
  where source_key = r.source_key and gone_at is null and miss_count >= p_miss_limit;
  get diagnostics n = row_count;
  perform refresh_event(e.event_id) from (select distinct event_id from listing where source_key = r.source_key and gone_at is not null and event_id is not null) e;
  return n;
end $$;

------------------------------------------------------------------------------
-- 9. Idempotent upsert entry point used by every ingester
------------------------------------------------------------------------------
create or replace function upsert_listing(
  p_source_key text, p_source_id text, p_source_url text, p_raw jsonb, p_run_id bigint,
  p_title text, p_starts_at timestamptz, p_ends_at timestamptz, p_has_time boolean, p_night date,
  p_venue_name text, p_venue_addr text, p_venue_source_id text, p_venue_lat double precision, p_venue_lng double precision,
  p_lineup text[], p_price_min numeric, p_price_max numeric, p_fees_included boolean, p_price_note text, p_prices jsonb,
  p_sold_out boolean, p_status text, p_age_min int, p_genres text[], p_promoters text[],
  p_description text, p_image_url text, p_interested_count int, p_source_tags jsonb, p_external_refs jsonb)
returns table(listing_id bigint, is_new boolean, changed boolean, event_id uuid)
language plpgsql as $$
#variable_conflict use_column
declare v_id bigint; v_hash text; v_venue uuid; v_event uuid; v_old_hash text; v_new boolean := false;
begin
  v_hash := md5(concat_ws('|', p_title, p_starts_at, p_ends_at, p_venue_name, array_to_string(p_lineup, ','), p_price_min, p_price_max, p_sold_out, p_status, p_age_min, array_to_string(p_genres, ',')));
  select l.content_hash into v_old_hash from listing l where l.source_key = p_source_key and l.source_id = p_source_id;
  select r.venue_id into v_venue from resolve_venue(p_source_key, p_venue_source_id, p_venue_name) r limit 1;
  -- Unknown venue: create a provisional row so events at new rooms still get a venue family (dupe guard,
  -- cross-source matching). Humans review these later (needs_review); the seed/alias tables absorb them.
  if v_venue is null and norm_text(p_venue_name) is not null then
    v_venue := create_provisional_venue(p_source_key, p_venue_source_id, p_venue_name, p_venue_addr, p_venue_lat, p_venue_lng);
  end if;
  insert into listing (source_key, source_id, source_url, raw, content_hash, title, starts_at, ends_at, has_time, night,
                       venue_name_raw, venue_addr_raw, venue_source_id, venue_lat_raw, venue_lng_raw, venue_id, lineup_raw,
                       price_min, price_max, fees_included, price_note, sold_out, status, age_min, genres, promoters,
                       description, image_url, interested_count, source_tags, external_refs, seen_in_run_id)
  values (p_source_key, p_source_id, p_source_url, p_raw, v_hash, p_title, p_starts_at, p_ends_at, p_has_time,
          coalesce(p_night, night_date(p_starts_at)),
          p_venue_name, p_venue_addr, p_venue_source_id, p_venue_lat, p_venue_lng, v_venue, coalesce(p_lineup,'{}'),
          p_price_min, p_price_max, p_fees_included, p_price_note, p_sold_out, coalesce(p_status,'scheduled'), p_age_min,
          coalesce(p_genres,'{}'), coalesce(p_promoters,'{}'),
          p_description, p_image_url, p_interested_count, coalesce(p_source_tags,'{}'), coalesce(p_external_refs,'[]'), p_run_id)
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
    seen_in_run_id = excluded.seen_in_run_id
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
