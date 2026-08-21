#!/usr/bin/env bash
# Applies every Collective migration to a throwaway local database and runs
# the behavioral smoke suite. Any failure exits nonzero.
#
# Usage: PGHOST=/var/run/postgresql PGPORT=5445 ./test_migrations.sh
# Defaults target a local socket cluster; point PGHOST/PGPORT elsewhere to
# test against any Postgres 15+.

set -euo pipefail
cd "$(dirname "$0")/../.."

export PGHOST="${PGHOST:-/var/run/postgresql}"
export PGPORT="${PGPORT:-5445}"
export PGUSER="${PGUSER:-postgres}"
DB="${COLLECTIVE_TEST_DB:-collective_test}"

echo "== recreate $DB"
psql -d postgres -v ON_ERROR_STOP=1 -q -c "drop database if exists $DB;"
psql -d postgres -v ON_ERROR_STOP=1 -q -c "create database $DB;"

echo "== ensure Supabase-shaped roles"
psql -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
SQL

echo "== apply migrations"
for f in supabase/migrations/*.sql; do
  echo "   $f"
  psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f"
done

echo "== behavioral smoke"
psql -d "$DB" -v ON_ERROR_STOP=1 -q -f tools/collective/smoke_migrations.sql

echo "== ALL GREEN"
