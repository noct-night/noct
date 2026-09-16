-- NOCT 0024: the promoter's track, and distance between rooms.
--
-- 1. event_feed.track. The DICE partner payload carries, per event, spotify_tracks[] and apple_music_tracks[]
--    -- {title, open_url, preview_url}, the platform's own 30-second clip for a track the promoter chose for
--    the night. The adapter stripped both from `raw` as bulk; from this commit it keeps them, and the view
--    surfaces ONE per event (Spotify first, then Apple Music, first with a preview). This is the honest form of
--    "hear the night before you go": no NOCT-chosen drop, no timestamp, no per-artist audio we do not have, and
--    the platform is named and linked next to its clip -- the attribution the platforms ask of their own
--    integrations (whether those terms bind a clip that reaches NOCT through DICE is unconfirmed; the text-only
--    credit is the conservative choice). Only DICE-backed nights (DICE or SILO listings) can carry it.
--    Owner decision 2026-09-15, recorded in docs/DATA_SOURCES.md.
--
-- 2. haversine_km(). "After this, nearby" on the event sheet lists rooms within a few kilometres whose listed
--    close is two hours or more after this one's. Straight-line distance, in SQL, so the rule is one place and
--    testable; no routing, no minutes -- Directions opens Maps for that.
--
-- The view is re-created from 0021's text with the one lateral added; nothing else in it changes.
set search_path = public, extensions;

------------------------------------------------------------------------------
-- 2. Distance
------------------------------------------------------------------------------
create or replace function haversine_km(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision
language sql immutable parallel safe
as $$
  select 2 * 6371.0088 * asin(least(1.0, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  )))
$$;
comment on function haversine_km(double precision, double precision, double precision, double precision) is
  'Great-circle distance in kilometres between two WGS84 points. Straight line: a river in between is the reader''s problem, and Directions knows about it.';

------------------------------------------------------------------------------
-- 1. event_feed with `track`
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
      e.age_min,
      -- refresh_event() rebuilds e.lineup from listings on every ingest, so the model's reading lives in
      -- its own column and is used only where the sources gave nothing.
      coalesce(nullif(e.lineup, '{}'), e.lineup_model) as lineup,
      e.description, e.image_url, e.interested_count,
      e.genres, e.genre_source,                                     -- raw source labels + which sources tagged
      e.primary_genre, g.label as primary_genre_label,
      e.genre_codes, gl.labels as genre_labels, gl.tags as genre_tags, e.genre_confidence,   -- tags: [{code,label}] in genre_codes order
      e.vibe_codes, vb.vibes,                                       -- [{code,label,glyph,kind}] in vibe_codes order
      e.energy, e.darkness, e.crowd_size, e.start_lateness, e.end_lateness, e.price_tier, e.underground_index,
      e.sound_summary, e.is_electronic, e.needs_review,
      e.listing_count,
      ls.platforms,                                                 -- display names of every live source, best first
      ls.sources,                                                   -- [{source,name,url}] every live listing's link
      coalesce(o.cheapest_price, lp.price) as cheapest_price,       -- ticketer offers first, else any live listing's price
      coalesce(so.verdict, o.all_unavailable) as sold_out,          -- ticketers' own verdict; else every offer unavailable
      coalesce(gc.n, 0)                        as going_count,
      e.updated_at,
      e.city, e.tz,                                                 -- 0011: multi-city
      tr.track                                                      -- 0024: the promoter's track for the night (DICE), else null
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
      -- What the night costs according to a source that cannot sell you a ticket. 19hz is a community list,
      -- not a ticketer, so s.is_ticketer keeps it out of event_offer -- correctly, since "buy here" would be a
      -- lie. Throwing its PRICE away with it was not correct: 96 Chicago nights showed no price at all while
      -- their 19hz listing knew it. The Tickets section still lists ticketers only; this is the label.
      select min(l.price_min) as price
      from listing l where l.event_id = e.event_id and l.gone_at is null and l.price_min is not null
    ) lp on true
    left join lateral (
      -- sold out only when every live ticketing listing WITH an opinion says so. RA marks expired tiers
      -- NOLONGERONSALE (available = false) while door sales may remain, so "every offer unavailable" would call
      -- those nights sold out against RA's own verdict; it is only the fallback when no listing states sold_out.
      select bool_and(l.sold_out) as verdict
      from listing l join source s on s.source_key = l.source_key
      where l.event_id = e.event_id and l.gone_at is null and s.is_ticketer and l.sold_out is not null
    ) so on true
    left join lateral (
      -- The track attached to the DICE listing, as DICE sends it: {title, open_url, preview_url}. Spotify first,
      -- then Apple Music, the first entry that carries a preview. Read from a live DICE listing, or SILO's (the
      -- venue site serves the same DICE payload); listing.raw is rewritten on every upsert, so a track added
      -- later arrives with the next run and a listing that goes away takes its track with it. Nothing here
      -- chooses a timestamp or calls it representative: it is one track from the listing, playable on the
      -- platform's own clip.
      select jsonb_build_object('platform', t.platform, 'title', t.title, 'url', t.url, 'preview', t.preview) as track
      from (
        select 'spotify' as platform, x->>'title' as title, x->>'open_url' as url, x->>'preview_url' as preview,
               case l.source_key when 'dice' then 0 else 1 end as src_pri, 1 as pri, l.listing_id, a.ord
        from listing l
        cross join lateral jsonb_array_elements(case when jsonb_typeof(l.raw->'spotify_tracks') = 'array' then l.raw->'spotify_tracks' else '[]'::jsonb end) with ordinality a(x, ord)
        where l.event_id = e.event_id and l.source_key in ('dice', 'silo') and l.gone_at is null
        union all
        select 'apple', x->>'title', x->>'open_url', x->>'preview_url',
               case l.source_key when 'dice' then 0 else 1 end, 2, l.listing_id, a.ord
        from listing l
        cross join lateral jsonb_array_elements(case when jsonb_typeof(l.raw->'apple_music_tracks') = 'array' then l.raw->'apple_music_tracks' else '[]'::jsonb end) with ordinality a(x, ord)
        where l.event_id = e.event_id and l.source_key in ('dice', 'silo') and l.gone_at is null
      ) t
      where t.preview like 'https://%' and t.title is not null
      -- DICE's own listing before SILO's copy of the same payload; then Spotify before Apple; then a fixed
      -- listing (an event can hold two live DICE listings -- a day ticket and a weekend pass -- and without the
      -- listing_id tiebreak the pick would depend on scan order); then DICE's own order
      order by t.src_pri, t.pri, t.listing_id, t.ord
      limit 1
    ) tr on true
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
comment on view event_feed  is 'Canonical events with venue family, enrichment, offer summary, city, tz and the promoter''s track (0024); excludes merged and removed events. security_invoker on Supabase.';
-- dropping the views dropped their grants (0011 pattern)
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant select on event_feed, event_offer to anon, authenticated';
  end if;
end $$;
-- Supabase's default privileges hand anon/authenticated full DML on every new object; a read model is read-only
revoke insert, update, delete, truncate, references, trigger on event_feed, event_offer from public, anon, authenticated;
