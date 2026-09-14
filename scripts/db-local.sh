#!/usr/bin/env bash
# Create (or refresh) a local Postgres database and apply every migration in order.
# Usage: scripts/db-local.sh [dbname]      (default: $NOCT_TEST_DB or noct_local)
# Requires a running local Postgres with contrib extensions (pg_trgm, unaccent, fuzzystrmatch, btree_gist, citext).
# pg_cron / pg_net / vector migrations are guarded and skip themselves when the extension is unavailable.
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${1:-${NOCT_TEST_DB:-noct_local}}"
PSQL="psql -v ON_ERROR_STOP=1 -q"
if ! psql -d postgres -Atc "select 1 from pg_database where datname='${DB}'" | grep -q 1; then
  createdb "${DB}"
fi
$PSQL -d "${DB}" -c "alter database \"${DB}\" set search_path = public, extensions;"
for f in supabase/migrations/*.sql; do
  echo ">> ${f}"
  $PSQL -d "${DB}" -f "${f}"
done
echo "ok: DATABASE_URL=postgresql://localhost:5432/${DB}"
