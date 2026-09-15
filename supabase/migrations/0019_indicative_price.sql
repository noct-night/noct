-- NOCT 0019: a price a non-ticketer knows is still a price.
--
-- event_offer is ticketing sources only (`s.is_ticketer`), which is right: 19hz is a community listing site
-- and "buy here" would be a lie. But cheapest_price read ONLY from event_offer, so a 19hz price was discarded
-- along with the offer -- and 19hz is the dominant source outside New York. 96 of Chicago's 250 upcoming
-- nights showed no price while their listing knew it (19hz listings: 495 priced, 0 offers).
--
-- event_feed.cheapest_price now falls back to the cheapest live listing price from any source. event_offer is
-- untouched, so the Tickets section still shows only places that can actually sell you one.
set search_path = public, extensions;

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
      coalesce(o.cheapest_price, lp.price) as cheapest_price,       -- ticketer offers first, else any live listing's price
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
