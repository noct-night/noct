-- NOCT 0001: extensions.
-- Supabase installs extensions into the "extensions" schema and puts it on every role's search_path.
-- Locally, scripts/db-local.sh sets the database search_path to "public, extensions" so the trigram
-- operators (%, <%) resolve the same way.
create schema if not exists extensions;
create extension if not exists pg_trgm       with schema extensions;   -- fuzzy title / venue / artist matching
create extension if not exists unaccent      with schema extensions;   -- "Ijó" -> "Ijo"
create extension if not exists fuzzystrmatch with schema extensions;   -- dmetaphone blocking for artist names
create extension if not exists btree_gist    with schema extensions;
create extension if not exists citext        with schema extensions;
create extension if not exists pgcrypto      with schema extensions;   -- gen_random_uuid() on older builds

-- Scheduler extensions. New Supabase projects ship pg_cron / pg_net available but NOT enabled; enable them
-- here (before 0008 registers jobs). Guarded so a local Postgres without them applies cleanly.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    execute 'create extension if not exists pg_cron with schema pg_catalog';
    execute 'grant usage on schema cron to postgres';
    execute 'grant all privileges on all tables in schema cron to postgres';
  else
    raise notice 'pg_cron not available on this server; schedules in 0008 will be skipped';
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    execute 'create extension if not exists pg_net with schema extensions';
  else
    raise notice 'pg_net not available on this server; noct_call() will be a no-op';
  end if;
end $$;
