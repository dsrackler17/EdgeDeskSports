#!/bin/sh
# Full verification for the odds layer. Requires a local Postgres and Node 22+.
#
#   sh tests/collective/run_all.sh
#
# 1. artifact: the pasted-into-the-dashboard bundles match their sources
# 2. schema: fixture + migration + behavioural tests on a scratch database
# 3. adapters: pure unit tests for each vendor normalizer
# 4. pipeline: fixture -> real adapter -> real SQL, end to end
# 5. components: the browser renderers
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
MIG=supabase/migrations/20260821090000_nfl_odds.sql
MIG2=supabase/migrations/20260821140000_odds_provider_credits.sql

# Every node stage below used to be piped straight into grep to strip Node's
# ExperimentalWarning noise. That makes the PIPELINE's status grep's status,
# so a test could print FAIL, exit 1, and the suite still reported success --
# the same hole that hid a failing schema stage. Output goes through a file
# instead, and the real exit code is checked.
node_test() {
  _out=$(mktemp)
  _rc=0
  # `|| _rc=$?` and not a bare call: under `set -e` a bare failing command
  # exits the shell right here, and the test's output -- the only thing that
  # says WHICH assertion failed -- is still sitting in the temp file unread.
  node "$@" > "$_out" 2>&1 || _rc=$?
  grep -vE "ExperimentalWarning|trace-warnings|^NOTICE:" "$_out" || true
  rm -f "$_out"
  if [ "$_rc" -ne 0 ]; then
    echo "FAILED: node $*" >&2
    exit 1
  fi
}

py_test() {
  python3 "$@" || { echo "FAILED: python3 $*" >&2; exit 1; }
}

# The bundles under _bundles/ are what actually gets deployed: the docs say
# paste them into the dashboard. The split sources are never deployed. So a
# fix that lands in _shared/ and is not regenerated ships as nothing at all,
# and every source-level test here would still pass while production runs the
# old code. That failure is invisible to every other check, so it goes first.
echo "== 1/5 deploy artifact matches source =="
py_test tools/collective/bundle_functions.py --check
echo
py_test tests/collective/config_matches_bundles.py

echo
echo "== 2/5 schema =="
su postgres -c "psql -q -c 'drop database if exists oddstest;' -c 'create database oddstest;'" >/dev/null 2>&1
su postgres -c "psql -q -d oddstest -v ON_ERROR_STOP=1 -f $ROOT/tests/collective/odds_schema_fixture.sql" >/dev/null
su postgres -c "psql -q -d oddstest -v ON_ERROR_STOP=1 -f $ROOT/$MIG" >/dev/null
su postgres -c "psql -q -d oddstest -v ON_ERROR_STOP=1 -f $ROOT/$MIG2" >/dev/null
# The result goes through a file rather than straight into a pipe: piping into
# grep makes the PIPELINE's status that of the last command, so a FAIL printed
# by the test still exited 0 and the whole suite reported success.
SCHEMA_OUT=$(mktemp)
su postgres -c "psql -q -d oddstest -v ON_ERROR_STOP=1 -f $ROOT/tests/collective/odds_schema_test.sql" > "$SCHEMA_OUT" 2>&1 || true
grep -E "pass:|FAIL|ERROR|PASSED" "$SCHEMA_OUT" | sed 's/^psql:[^ ]* //;s/^NOTICE:  //'
if grep -qE "FAIL|ERROR:" "$SCHEMA_OUT"; then
  rm -f "$SCHEMA_OUT"
  echo "schema stage failed" >&2
  exit 1
fi
rm -f "$SCHEMA_OUT"

echo
echo "== 3/5 adapters =="
node_test --experimental-strip-types tests/collective/oddsblaze_normalize.test.mjs
echo
node_test --experimental-strip-types tests/collective/theoddsapi_normalize.test.mjs

echo
echo "== 4/5 pipeline end to end =="
su postgres -c "psql -q -c 'drop database if exists oddspipe;' -c 'create database oddspipe;'" >/dev/null 2>&1
su postgres -c "psql -q -d oddspipe -v ON_ERROR_STOP=1 -f $ROOT/tests/collective/odds_schema_fixture.sql" >/dev/null
su postgres -c "psql -q -d oddspipe -v ON_ERROR_STOP=1 -f $ROOT/$MIG" >/dev/null
su postgres -c "psql -q -d oddspipe -v ON_ERROR_STOP=1 -f $ROOT/$MIG2" >/dev/null
PGDATABASE=oddspipe node_test --experimental-strip-types tests/collective/pipeline_e2e.test.mjs

echo
echo "== 5/5 browser components =="
node_test tests/collective/odds_js.test.mjs

echo
echo "== slate uploader (in-page) =="
node_test tests/collective/slate_upload.test.mjs

echo
echo "== slate upload, real file end to end =="
node_test tests/collective/slate_endtoend.test.mjs

echo
echo "== slate CSV mapper =="
py_test tests/collective/submit_csv_test.py

echo
echo "== NFL model preflight =="
node_test tests/collective/nfl_preflight.test.mjs

echo
echo "== model_predictions -> upload CSV =="
node_test tests/collective/model_to_csv.test.mjs

echo
echo "== inline page scripts =="
node_test tools/collective/check_html_js.mjs
