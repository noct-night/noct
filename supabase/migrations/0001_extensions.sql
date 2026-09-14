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
