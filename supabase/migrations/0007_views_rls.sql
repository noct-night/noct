-- NOCT 0007: read models + security.
--
-- Read models: event_offer (one row per live ticket offer per event) and event_feed (one row per canonical event
-- with venue, enrichment and offer summaries) — what /api/feed and any PostgREST client read.
--
-- Security model (Supabase): every table has RLS on; anon/authenticated lose every table privilege, then get
-- SELECT back only on the read models, the reference tables (venue, genre, vibe, event_tag, source display
-- columns) and the columns of event / listing / listing_price the read models need. The views are created WITH
-- (security_invoker = true): they run as the caller, so RLS on the underlying tables applies and a view can never
-- leak more than its policies allow. Functions in public lose EXECUTE for the same two roles (section 5).
-- ON SUPABASE (PG15+) THE VIEWS MUST STAY security_invoker. Local Postgres 14 does not know the option; the DO
-- blocks below fall back to plain views there (same columns, owner privileges), which is fine for tests because
-- RLS never applies to the owner anyway.
--
-- going_count (0005) is the one deliberate owner-privilege view: it exposes a count over rows nobody may read.
-- Idempotent; safe to re-apply.
set search_path = public, extensions;

------------------------------------------------------------------------------
-- 1. Views
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
      e.updated_at
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
comment on view event_feed  is 'Canonical events with venue family, enrichment and offer summary; excludes merged and removed events. security_invoker on Supabase.';

------------------------------------------------------------------------------
-- 2. RLS on every table + default deny for the PostgREST roles.
--    Sweeps every table in public that exists at this point (0001-0006, and 0004 if present) so a table nobody
--    thought about is closed rather than open (Supabase's default privileges would otherwise hand anon full access).
------------------------------------------------------------------------------
do $$
declare
  t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

------------------------------------------------------------------------------
-- 3. Read policies. The row rules live here, the column rules in the grants below.
------------------------------------------------------------------------------
do $$
declare
  p record;
begin
  for p in
    select * from (values
      ('source',        'source_public_read',        'true'),
      ('venue',         'venue_public_read',         'true'),
      ('genre',         'genre_public_read',         'true'),
      ('vibe',          'vibe_public_read',          'true'),
      ('event_tag',     'event_tag_public_read',     'true'),
      ('listing_price', 'listing_price_public_read', 'true'),
      -- only canonical, still-listed events; merged duplicates and tombstoned events never reach a client
      ('event',         'event_public_read',         $q$merged_into is null and status <> 'removed'$q$),
      -- only listings a source still shows
      ('listing',       'listing_public_read',       'gone_at is null')
    ) as x(tbl, pol, cond)
  loop
    execute format('drop policy if exists %I on %I', p.pol, p.tbl);
    execute format('create policy %I on %I for select to anon, authenticated using (%s)', p.pol, p.tbl, p.cond);
  end loop;
end $$;

------------------------------------------------------------------------------
-- 4. Grants: what the two roles may actually read.
------------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

-- read models
grant select on event_feed, event_offer, going_count to anon, authenticated;

-- reference tables (curated, public by nature)
grant select on venue, genre, vibe, event_tag to anon, authenticated;

-- source: display columns only (tos_notes is documentation, not a secret)
grant select (source_key, display_name, kind, priority, fees_included_default, is_ticketer, tos_notes, enabled) on source to anon, authenticated;

-- event: the canonical record is public; RLS above hides merged/removed rows
grant select on event to anon, authenticated;

-- listing: the columns event_feed / event_offer read plus the human-facing ones. NOT raw (third-party payloads are
-- not redistributed wholesale), not the matching/bookkeeping columns.
grant select (listing_id, source_key, source_id, source_url, title, status, starts_at, ends_at, has_time, night,
              venue_name_raw, venue_id, lineup_raw, price_min, price_max, currency, fees_included, price_note, sold_out,
              age_min, genres, promoters, description, image_url, interested_count,
              first_seen_at, last_seen_at, last_changed_at, gone_at, event_id)
  on listing to anon, authenticated;
grant select on listing_price to anon, authenticated;

-- app tables (0005): signed-in users on their own rows, enforced by the auth.uid() policies created there
grant select, insert, update, delete on profile, going, saved, follow to authenticated;

------------------------------------------------------------------------------
-- 5. Functions. PostgREST exposes every function a role may EXECUTE as POST /rest/v1/rpc/<name>, and Postgres
--    grants EXECUTE to PUBLIC by default. Nothing in public is meant for clients — the write path (upsert_listing,
--    resolve_pending, refresh_event, tombstone_sweep, ...) belongs to the runner connecting as postgres — so the
--    PostgREST roles lose it (they would fail on table privileges anyway; this keeps the RPC surface empty even if
--    a SECURITY DEFINER function appears later). Triggers still fire for authenticated (touch_updated_at on
--    profile): EXECUTE is checked when a trigger is created, not when it runs. service_role keeps its access.
--    Functions created by later migrations must revoke for themselves (0008 does for noct_call).
------------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on all functions in schema public to service_role';
  end if;
end $$;
