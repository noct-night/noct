-- NOCT 0005: app tables behind the prototype's sign-in / going / saved / follow.
-- The frontend is not wired to Supabase Auth yet (docs/FRONTEND.md); this file only makes the storage and the
-- security model exist so the wiring is a client-side change. Idempotent.
--
-- Local Postgres has no `auth` schema and no PostgREST roles, so everything that names auth.users, auth.uid()
-- or the anon/authenticated roles is done conditionally: tables + the going_count view apply everywhere, the
-- foreign keys and per-user policies apply on Supabase.
set search_path = public, extensions;

------------------------------------------------------------------------------
-- 0. PostgREST roles. Supabase ships anon / authenticated; a plain local Postgres does not, and every grant and
--    policy in 0005/0007 names them. Create them NOLOGIN when absent so one file applies identically everywhere.
--    (Roles are cluster-wide; the exception guard covers two databases being set up at the same time.)
------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    begin execute 'create role anon nologin'; exception when duplicate_object then null; end;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    begin execute 'create role authenticated nologin'; exception when duplicate_object then null; end;
  end if;
end $$;

------------------------------------------------------------------------------
-- 1. Tables
------------------------------------------------------------------------------
-- One row per signed-in user. ig_handle is the public identity on guest lists; visibility is the reciprocal
-- rule from the prototype: 'count' = only add to the number, 'mutuals' = handle shown to people I follow,
-- 'public' = handle shown to anyone on the event.
create table if not exists profile (
  user_id    uuid primary key,
  ig_handle  citext unique,
  visibility text not null default 'count' check (visibility in ('count','mutuals','public')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists going (
  user_id    uuid not null,
  event_id   uuid not null references event(event_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, event_id)
);
create index if not exists going_event_idx on going (event_id);

create table if not exists saved (
  user_id    uuid not null,
  event_id   uuid not null references event(event_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, event_id)
);
create index if not exists saved_event_idx on saved (event_id);

-- Who follows whom, for the 'mutuals' visibility rule (A sees B's handle when B is set to mutuals and B follows A).
create table if not exists follow (
  user_id         uuid not null,
  follows_user_id uuid not null,
  created_at      timestamptz not null default now(),
  primary key (user_id, follows_user_id),
  check (user_id <> follows_user_id)
);
create index if not exists follow_target_idx on follow (follows_user_id);

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists profile_touch on profile;
create trigger profile_touch before update on profile for each row execute function touch_updated_at();

------------------------------------------------------------------------------
-- 2. Foreign keys to auth.users — Supabase only (local Postgres has no auth schema)
------------------------------------------------------------------------------
do $$
declare
  fk record;
begin
  if to_regclass('auth.users') is null then
    raise notice 'auth.users not present: user_id foreign keys skipped (local Postgres)';
    return;
  end if;
  for fk in
    select * from (values
      ('profile', 'user_id',         'profile_user_fk'),
      ('going',   'user_id',         'going_user_fk'),
      ('saved',   'user_id',         'saved_user_fk'),
      ('follow',  'user_id',         'follow_user_fk'),
      ('follow',  'follows_user_id', 'follow_target_fk')
    ) as t(tbl, col, con)
  loop
    if not exists (select 1 from pg_constraint where conname = fk.con) then
      execute format('alter table %I add constraint %I foreign key (%I) references auth.users(id) on delete cascade', fk.tbl, fk.con, fk.col);
    end if;
  end loop;
end $$;

------------------------------------------------------------------------------
-- 3. Row level security: users read and write only their own rows.
--    auth.uid() exists only on Supabase, so the policies are created there; locally the tables stay enabled
--    with no policies, i.e. closed to everyone but the owner — which is what the tests and the ingest use.
------------------------------------------------------------------------------
alter table profile enable row level security;
alter table going   enable row level security;
alter table saved   enable row level security;
alter table follow  enable row level security;

do $$
begin
  if to_regprocedure('auth.uid()') is null then
    raise notice 'auth.uid() not present: per-user policies skipped (local Postgres)';
    return;
  end if;
  execute 'drop policy if exists profile_own on profile';
  execute 'create policy profile_own on profile for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())';
  execute 'drop policy if exists going_own on going';
  execute 'create policy going_own on going for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())';
  execute 'drop policy if exists saved_own on saved';
  execute 'create policy saved_own on saved for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())';
  execute 'drop policy if exists follow_own on follow';
  execute 'create policy follow_own on follow for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())';
end $$;

-- Signed-in users act on their own rows through PostgREST; anon gets nothing on these tables (0007 re-asserts this).
revoke all on profile, going, saved, follow from anon, authenticated;
grant select, insert, update, delete on profile, going, saved, follow to authenticated;

------------------------------------------------------------------------------
-- 4. going_count: the one thing everybody may read about `going`.
--    Deliberately NOT security_invoker: it aggregates over rows the viewer is not allowed to see one by one and
--    exposes only (event_id, n). It runs with the owner's privileges, so keep it exactly this narrow.
------------------------------------------------------------------------------
create or replace view going_count as
  select event_id, count(*)::int as n from going group by event_id;
comment on view going_count is 'Public per-event count of users marked going. Owner-privilege view on purpose: exposes a count, never a row.';
grant select on going_count to anon, authenticated;
