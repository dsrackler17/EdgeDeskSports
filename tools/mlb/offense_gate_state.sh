#!/usr/bin/env bash
# Which offensive promote gate does the database at $PGURL run? Read only.
#   FIXED    one grouped pass over the two grains (supabase/fix_slow_promote_mlb.sql)
#   OLD      the grain check that joins staging to an aggregate of staging, the
#            plan that times out (57014) when staging's statistics are stale
#   MISSING  no mlbhist.promote_offense_import (supabase/mlb_offense_history.sql first)
# The FIXED pattern is the one the fix's own report checks (row 3).
set -euo pipefail
state=$(psql "$PGURL" -X -q -t -A -v ON_ERROR_STOP=1 -c "
  with gate as (
    select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'mlbhist' and p.proname = 'promote_offense_import')
  select case
    when not exists (select 1 from gate) then 'MISSING'
    when (select prosrc from gate) ~* 'bool_or\(g\.combined\)[[:space:]]+and[[:space:]]+bool_or\(not g\.combined\)' then 'FIXED'
    else 'OLD' end;")
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "**MLB offensive gate:** $state" >> "$GITHUB_STEP_SUMMARY"
case "$state" in
  FIXED)   echo "production runs the fixed gate (one grouped pass over the two grains)";;
  OLD)     echo "::warning::production runs the OLD gate: its grain check joins staging to an aggregate of staging, the plan that times out (57014). Run Deploy MLB offensive gate fix with apply checked.";;
  MISSING) echo "::error::mlbhist.promote_offense_import does not exist: the offensive archive is not installed (supabase/mlb_offense_history.sql comes first)"; exit 1;;
  *)       echo "::error::unexpected answer: $state"; exit 1;;
esac
