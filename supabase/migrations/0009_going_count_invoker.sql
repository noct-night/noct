-- NOCT 0009: going_count must run with the caller's privileges like the other read models, so RLS on
-- `going` applies (it only exposes counts, but owner-rights views are a footgun on Supabase).
-- security_invoker exists from PostgreSQL 15; older local servers skip with a notice.
do $$
begin
  if current_setting('server_version_num')::int >= 150000 and to_regclass('public.going_count') is not null then
    execute 'alter view public.going_count set (security_invoker = true)';
  else
    raise notice 'going_count: security_invoker not applied (PG < 15 or view missing)';
  end if;
end $$;
