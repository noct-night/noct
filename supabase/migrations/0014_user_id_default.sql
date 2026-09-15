-- NOCT 0014: default user_id to auth.uid() on the per-user tables.
--
-- 0005 created going/saved/profile/follow with RLS policies `user_id = auth.uid()` but no default, so an
-- insert that omits user_id gets NULL and fails the WITH CHECK. The client could send its own id, but the
-- default is safer: the row is stamped server-side, and the policy still rejects a client that sends
-- somebody else's id. Supabase only — a local Postgres has no auth schema.
set search_path = public, extensions;

do $$
declare t text;
begin
  if to_regprocedure('auth.uid()') is null then
    raise notice 'auth.uid() not present: user_id defaults skipped (local Postgres)';
    return;
  end if;
  foreach t in array array['profile', 'going', 'saved', 'follow'] loop
    execute format('alter table %I alter column user_id set default auth.uid()', t);
  end loop;
end $$;
