#!/bin/sh
# Full verification for the odds layer. Requires a local Postgres and Node 22+.
#
#   sh tests/collective/run_all.sh
#
# 1. schema: fixture + migration + behavioural tests on a scratch database
# 2. adapter: pure unit tests for the vendor normalizer
# 3. pipeline: fixture -> real adapter -> real SQL, end to end
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
MIG=supabase/migrations/20260821090000_nfl_odds.sql

echo "== 1/3 schema =="
su postgres -c "psql -q -c 'drop database if exists oddstest;' -c 'create database oddstest;'" >/dev/null 2>&1
su postgres -c "psql -q -d oddstest -v ON_ERROR_STOP=1 -f $ROOT/tests/collective/odds_schema_fixture.sql" >/dev/null
su postgres -c "psql -q -d oddstest -v ON_ERROR_STOP=1 -f $ROOT/$MIG" >/dev/null
su postgres -c "psql -q -d oddstest -v ON_ERROR_STOP=1 -f $ROOT/tests/collective/odds_schema_test.sql" 2>&1 \
  | grep -E "pass:|FAIL|ERROR|PASSED" | sed 's/^psql:[^ ]* //;s/^NOTICE:  //'

echo
echo "== 2/3 adapter =="
node --experimental-strip-types tests/collective/oddsblaze_normalize.test.mjs 2>&1 | grep -v ExperimentalWarning | grep -v "trace-warnings"

echo
echo "== 3/3 pipeline end to end =="
su postgres -c "psql -q -c 'drop database if exists oddspipe;' -c 'create database oddspipe;'" >/dev/null 2>&1
su postgres -c "psql -q -d oddspipe -v ON_ERROR_STOP=1 -f $ROOT/tests/collective/odds_schema_fixture.sql" >/dev/null
su postgres -c "psql -q -d oddspipe -v ON_ERROR_STOP=1 -f $ROOT/$MIG" >/dev/null
PGDATABASE=oddspipe node --experimental-strip-types tests/collective/pipeline_e2e.test.mjs 2>&1 | grep -v ExperimentalWarning | grep -v "trace-warnings"
