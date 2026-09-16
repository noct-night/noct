-- NOCT 0030: first-party measurement -- a visit row per session, an action row per tap worth counting.
--
-- The question is "is anyone coming, from where, and do they come back", and answering it should not take a
-- third-party script on every page. Two insert-only tables:
--
--   visit   one row when a session starts: the referrer's host, utm tags if the link carried them, how the
--           link arrived (the home page, a shared night ?e=, a plan link ?g=), phone or desktop, whether it
--           runs from the home screen, time zone and language. A session is a tab with less than thirty
--           minutes of quiet; the client keeps that in sessionStorage.
--   action  one row per tap the other tables do not already record: opening a night, playing a preview,
--           sharing, directions, the calendar file, the map, search, picks, "after this". Saves, going,
--           the taste profile, plans and votes already live in saved / going / profile / group_session /
--           group_vote and complete the funnel.
--
-- Nothing here identifies a person beyond the anonymous account every visitor already has: no IP, no query
-- text, no page trail, no user agent string. A client may insert its own rows and read nothing back; the
-- owner reads aggregates through /api/health (traffic) and `npm run noct -- traffic`.
--
-- user_id deliberately has no foreign key to auth.users: Supabase may prune anonymous accounts, and a pruned
-- account should not take the month's traffic with it. The insert policy still binds a row to a live session.
set search_path = public, extensions;

create table if not exists visit (
  visit_id     uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  at           timestamptz not null default now(),
  city         text check (city is null or char_length(city) <= 16),
  ref          text check (ref is null or char_length(ref) <= 120),         -- referrer host, or app.instagram
  utm_source   text check (utm_source is null or char_length(utm_source) <= 80),
  utm_medium   text check (utm_medium is null or char_length(utm_medium) <= 80),
  utm_campaign text check (utm_campaign is null or char_length(utm_campaign) <= 80),
  entry        text not null default 'home' check (entry in ('home', 'event', 'group')),
  device       text check (device in ('phone', 'desktop')),
  standalone   boolean not null default false,                               -- opened from the home screen
  tz           text check (tz is null or char_length(tz) <= 64),
  lang         text check (lang is null or char_length(lang) <= 16)
);
create index if not exists visit_at_idx   on visit (at desc);
create index if not exists visit_user_idx on visit (user_id, at);

create table if not exists action (
  action_id uuid primary key default gen_random_uuid(),
  user_id   uuid not null,
  at        timestamptz not null default now(),
  kind      text not null check (kind ~ '^[a-z][a-z_]{1,31}$'),
  event_id  uuid,                                                            -- no FK: a merged night keeps its count
  city      text check (city is null or char_length(city) <= 16)
);
create index if not exists action_at_idx   on action (at desc);
create index if not exists action_kind_idx on action (kind, at desc);

comment on table visit  is 'One row per session (0030). Insert-only for clients; aggregates via /api/health traffic.';
comment on table action is 'One row per counted tap (0030). Insert-only for clients; the kind is free-form lower_snake.';

------------------------------------------------------------------------------
-- Supabase only: user_id defaults and the insert-only policies
------------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('auth.uid()') is null then
    raise notice 'auth.uid() not present: visit/action defaults and policies skipped (local Postgres)';
    return;
  end if;
  execute 'alter table visit  alter column user_id set default auth.uid()';
  execute 'alter table action alter column user_id set default auth.uid()';
  execute 'drop policy if exists visit_write on visit';
  execute 'create policy visit_write on visit for insert to authenticated with check (user_id = auth.uid())';
  execute 'drop policy if exists action_write on action';
  execute 'create policy action_write on action for insert to authenticated with check (user_id = auth.uid())';
end $$;

alter table visit  enable row level security;
alter table action enable row level security;

-- Supabase's default privileges hand anon/authenticated full DML on new tables; take it back, then allow the
-- one thing a client does here: insert. No select policy exists, so nothing reads back even with a grant.
revoke all on visit, action from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant insert on visit  to authenticated';
    execute 'grant insert on action to authenticated';
  end if;
end $$;
