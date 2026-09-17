-- NOCT 0036: a ticket link is a ticket link, whoever carried it -- and it is named after where it goes.
--
-- event_offer only ever admitted listings from sources flagged is_ticketer (RA, DICE, SILO, Ticketmaster,
-- EDMTrain excluded). A 19hz row is an aggregator's row, so it was never an offer -- even when its URL went
-- straight to axs.com, tixr.com or ticketmaster.com with a price. Then shapeSrcs() shows offers when there are
-- any, so the AXS link vanished from the event sheet the moment RA also listed the night, and when nothing else
-- did, the sheet read "19hz · See listing". On 2026-09-17 that hid 61 AXS links, 41 Tixr, 41 Eventbrite,
-- 37 Ticketmaster, 34 Posh and a dozen smaller platforms.
--
-- Now a listing is an offer when its source is a ticketer OR its link resolves to a known ticketing platform
-- (ticket_platform_name(), over platform_host() from 0028), and the row is named after that platform -- "AXS
-- · $18", not "19hz". Links to Facebook, Instagram, Partiful, bit.ly and the like are still not offers.
-- Collapsing by host (collapseOffersByHost) keeps RA's own rows over a 19hz link to ra.co, as before.
set search_path = public, extensions;

-- The platforms a link can sell a ticket on, by platform_host(). Null means "not a place to buy" (a Facebook
-- event, an Instagram post, an RSVP form), which keeps the row a source and not an offer.
create or replace function ticket_platform_name(p_host text) returns text
language sql immutable parallel safe as $$
  select case lower(coalesce(p_host, ''))
    when 'ra.co'                  then 'Resident Advisor'
    when 'dice.fm'                then 'DICE'
    when 'axs.com'                then 'AXS'
    when 'ticketmaster.com'       then 'Ticketmaster'
    when 'ticketmaster.evyy.net'  then 'Ticketmaster'
    when 'eventbrite.com'         then 'Eventbrite'
    when 'tixr.com'               then 'Tixr'
    when 'posh.vip'               then 'Posh'
    when 'eventim.us'             then 'Eventim'
    when 'wl.eventim.us'          then 'Eventim'
    when 'etix.com'               then 'Etix'
    when 'ticketweb.com'          then 'TicketWeb'
    when 'shotgun.live'           then 'Shotgun'
    when 'seetickets.us'          then 'See Tickets'
    when 'insomniac.frontgatetickets.com' then 'Front Gate'
    when 'frontgatetickets.com'   then 'Front Gate'
    when 'ticketfairy.com'        then 'Ticket Fairy'
    when 'speakeasygo.com'        then 'SpeakEasy'
    when 'stageglo.me'            then 'StageGlo'
    when 'events.leapevents.com'  then 'Leap'
    when 'hive.co'                then 'Hive'
    when 'secrettunnel.app'       then 'Secret Tunnel'
    when 'theticketing.co'        then 'The Ticketing'
    when 'events.ticketleap.com'  then 'TicketLeap'
    when 'universe.com'           then 'Universe'
    when 'showclix.com'           then 'ShowClix'
    when 'eventvesta.com'         then 'Vesta'
    when 'feverup.com'            then 'Fever'
    when 'tickets.taogroup.com'   then 'Tao Group'
    when 'eventsta.com'           then 'Eventsta'
    else null
  end
$$;
comment on function ticket_platform_name(text) is
  'The ticketing platform a host sells on, or null when the link is not a place to buy (Facebook, Instagram, Partiful, a short link).';

-- event_offer, as 0011 defined it, with the one changed clause and the platform name that follows the link.
-- CREATE OR REPLACE keeps event_feed (which reads this view) intact: same columns, same types, same order.
do $$
declare
  offer_sql text := $v$
    select
      l.event_id,
      l.listing_id,
      l.source_key            as platform,
      case when s.is_ticketer then s.display_name
           else coalesce(ticket_platform_name(platform_host(l.source_key, l.source_url)), s.display_name) end as platform_name,
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
      -- a ticketer's row, or anyone's row whose link is a place to buy (0036)
      and (s.is_ticketer or ticket_platform_name(platform_host(l.source_key, l.source_url)) is not null)
    order by l.event_id, (t.available is not false) desc, t.price nulls last, s.priority desc
  $v$;
begin
  begin
    execute 'create or replace view event_offer with (security_invoker = true) as ' || offer_sql;
  exception when invalid_parameter_value then
    raise notice 'security_invoker unsupported on this server; replacing the plain view (local dev only)';
    execute 'create or replace view event_offer as ' || offer_sql;
  end;
end $$;
comment on view event_offer is 'Live ticket offers per event: ticketing sources, plus any listing whose link is a known ticketing platform, named after the platform (0036). Available-first cheapest-first. security_invoker on Supabase.';
