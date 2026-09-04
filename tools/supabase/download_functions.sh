#!/usr/bin/env bash
# ===========================================================================
# Pull every deployed Edge Function into the repo.
#
# 63 of the 68 deployed functions have never been committed here: they exist
# only as deployed artifacts. Until they are in the repo they cannot be
# reviewed, diffed, tested, or rewritten — and if the project is ever lost,
# neither are they.
#
# Run this from the repo root, on a machine logged into Supabase:
#
#   npm i -g supabase          # or: brew install supabase/tap/supabase
#   supabase login             # opens a browser
#   supabase link --project-ref iattxbkbufslbauoumga
#   bash tools/supabase/download_functions.sh
#
# It writes each function to supabase/functions/<name>/index.ts, skips the
# ones already committed unless --force, and scans everything it pulled for
# anything that looks like a secret BEFORE you commit.
# ===========================================================================
set -uo pipefail

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

command -v supabase >/dev/null 2>&1 || {
  echo "supabase CLI not found. Install it first:"
  echo "  npm i -g supabase        # or  brew install supabase/tap/supabase"
  exit 1
}

FUNCTIONS=(
  bullpen_sync capture capture_boards capture_golf capture_news
  capture_players capture_players_espn capture_stats
  cfb_close cfb_explain cfb_flag cfb_ingest cfbd_probe cfbd_rankings
  close close_backfill
  collective_admin collective_billing collective_embed collective_ingest
  collective_join collective_odds collective_odds_ingest collective_public
  edgedesk_ai game_stats grade_faults grade_model_golf grade_props
  healthcheck ingest_mlb ingest_multisport ingest_nfl_features
  ingest_pitcher_season learn mark_provider_exhausted market_residual
  mlb_sync model_conf_grade model_conf_odds model_golf model_grade
  model_predict model_props model_ratings odds park_bearings_sync
  project_game rankings_standings recalibrate resolver run_slate
  scores_diag settle stripe_webhook team_brief tennis_ingest
  ufc_fighters_sync ufc_live ufc_live_stats ufcstats_sync
  venue_weather weather_sync
  wta_close wta_elo wta_ingest wta_odds wta_research
)

ok=0; skipped=0; failed=0; failed_names=()
pulled=()

for f in "${FUNCTIONS[@]}"; do
  if [ -f "supabase/functions/$f/index.ts" ] && [ "$FORCE" -eq 0 ]; then
    printf '  %-24s already in the repo (use --force to overwrite)\n' "$f"
    skipped=$((skipped+1)); continue
  fi
  if supabase functions download "$f" >/dev/null 2>&1; then
    printf '  %-24s pulled\n' "$f"
    ok=$((ok+1)); pulled+=("$f")
  else
    printf '  %-24s FAILED\n' "$f"
    failed=$((failed+1)); failed_names+=("$f")
  fi
done

echo
echo "pulled $ok · skipped $skipped · failed $failed"
[ "$failed" -gt 0 ] && echo "failed: ${failed_names[*]}"

# ---------------------------------------------------------------------------
# SECRET SCAN. Edge functions are supposed to read secrets from Deno.env, but
# "supposed to" is not "verified", and this is the moment before they enter
# git history — where a mistake is permanent. Anything this prints must be
# fixed in the function and rotated BEFORE you commit.
# ---------------------------------------------------------------------------
echo
echo "scanning what was pulled for anything that looks like a secret…"
HITS=$(grep -rInE \
  "(sk-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})" \
  supabase/functions/ 2>/dev/null | grep -v '^supabase/functions/[a-z_]*/index.ts:[0-9]*: *//' || true)

if [ -n "$HITS" ]; then
  echo
  echo "  ⚠  POSSIBLE SECRETS — do NOT commit until these are fixed and rotated:"
  echo "$HITS" | sed 's/^/     /' | cut -c1-160
  echo
  echo "  A service-role JWT or a live Stripe key in source is a rotate-now event,"
  echo "  not a cleanup task. Replace with Deno.env.get(...) and rotate the key."
  exit 2
fi
echo "  none found."
echo
echo "next:"
echo "  git add supabase/functions && git status --short"
echo "  # review the diff, then commit"
