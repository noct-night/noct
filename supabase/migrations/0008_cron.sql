-- NOCT 0008: scheduler. pg_cron (Supabase) -> pg_net -> Vercel /api/ingest/<source> and /api/enrich.
-- Guarded so it applies cleanly on a local Postgres without pg_cron / pg_net (notices only) and does the
-- real thing on Supabase once app_setting holds vercel_base_url + cron_secret (docs/OPERATIONS.md).
-- Idempotent: re-running replaces every noct-* job.
set search_path = public, extensions;

------------------------------------------------------------------------------
-- 1. Operator settings (service role only)
------------------------------------------------------------------------------
create table if not exists app_setting (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
comment on table app_setting is 'Operator settings read by SQL jobs: vercel_base_url, cron_secret. RLS on, no policies: service role / postgres only.';
alter table app_setting enable row level security;

-- PostgREST roles exist only on Supabase; keep them away from the secret even if a policy is added later by mistake.
do $do$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table app_setting from anon, authenticated;
  end if;
end $do$;

------------------------------------------------------------------------------
-- 2. noct_call(path): POST <vercel_base_url><path> with the cron bearer token through pg_net
------------------------------------------------------------------------------
create or replace function noct_call(path text) returns bigint
language plpgsql
as $fn$
declare
  v_base   text;
  v_secret text;
  v_id     bigint;
begin
  select value into v_base   from public.app_setting where key = 'vercel_base_url';
  select value into v_secret from public.app_setting where key = 'cron_secret';
  if v_base is null or v_secret is null then
    raise notice 'noct_call(%): app_setting vercel_base_url / cron_secret not set; nothing called', path;
    return null;
  end if;
  -- pg_net signature: http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds int)
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise notice 'noct_call(%): pg_net not installed; nothing called', path;
    return null;
  end if;
  -- EXECUTE keeps this body compilable where the net schema does not exist (local Postgres).
  -- pg_net is fire-and-forget: the 8 s timeout bounds the wait for a response, not the ingest itself,
  -- which keeps running on Vercel; read ingest_run / /api/health for the outcome.
  execute format(
    'select net.http_post(url := %L, body := %L::jsonb, headers := %L::jsonb, timeout_milliseconds := 8000)',
    rtrim(v_base, '/') || path,
    '{}',
    jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret, 'x-noct-trigger', 'pg_cron')::text
  ) into v_id;
  return v_id;
end $fn$;
comment on function noct_call(text) is 'POST <vercel_base_url><path> with Authorization: Bearer <cron_secret> via pg_net; returns the net request id (see net._http_response). NULL when unconfigured.';

revoke execute on function noct_call(text) from public;
do $do$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function noct_call(text) from anon, authenticated;
  end if;
end $do$;

------------------------------------------------------------------------------
-- 3. Schedules (UTC). Minutes are staggered so sources never start together; the runner also refuses to
--    open a second concurrent run for the same source, which covers the daily overlap with Vercel Cron.
------------------------------------------------------------------------------
do $do$
declare
  j record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed; skipping schedules';
    return;
  end if;
  for j in select jobid from cron.job where jobname like 'noct-%' loop
    perform cron.unschedule(j.jobid);
  end loop;
  perform cron.schedule('noct-ingest-ra',                   '17 */3 * * *', $c$select public.noct_call('/api/ingest/ra')$c$);
  perform cron.schedule('noct-ingest-dice',                 '29 */6 * * *', $c$select public.noct_call('/api/ingest/dice')$c$);
  perform cron.schedule('noct-ingest-venues-elsewhere',     '5 9 * * *',    $c$select public.noct_call('/api/ingest/elsewhere')$c$);
  perform cron.schedule('noct-ingest-venues-goodroom',      '12 9 * * *',   $c$select public.noct_call('/api/ingest/goodroom')$c$);
  perform cron.schedule('noct-ingest-venues-publicrecords', '19 9 * * *',   $c$select public.noct_call('/api/ingest/publicrecords')$c$);
  perform cron.schedule('noct-ingest-keyed-ticketmaster',   '33 10 * * *',  $c$select public.noct_call('/api/ingest/ticketmaster')$c$);
  perform cron.schedule('noct-ingest-keyed-edmtrain',       '41 10 * * *',  $c$select public.noct_call('/api/ingest/edmtrain')$c$);
  perform cron.schedule('noct-enrich',                      '40 * * * *',   $c$select public.noct_call('/api/enrich?limit=60')$c$);
  raise notice 'noct-* schedules installed';
end $do$;
