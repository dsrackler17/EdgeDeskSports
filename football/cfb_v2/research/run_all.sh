#!/usr/bin/env bash
# EdgeDesk CFB V2 — end-to-end commands.
#
#   ./run_all.sh live      weekly/daily shadow refresh: current-season features,
#                          frozen artifacts, write-once snapshots (no refit)
#   ./run_all.sh retrain   offseason retrain + full walk-forward backtest,
#                          ablation, report, export (a NEW model_version)
#
# Environment: CFB_V2_DATA (raw data dir), CFB_V2_OUT (work dir). Both default
# to ./data and ./out. Single-threaded BLAS keeps every run deterministic and
# avoids oversubscription.
set -euo pipefail
MODE="${1:-live}"
HERE="$(cd "$(dirname "$0")" && pwd)"
export CFB_V2_DATA="${CFB_V2_DATA:-$HERE/data}" CFB_V2_OUT="${CFB_V2_OUT:-$HERE/out}"
export OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
SEASON="${CFB_V2_SEASON:-$(date -u +%Y)}"
cd "$HERE"

bash fetch_v2.sh "$CFB_V2_DATA" 2009 "$SEASON"
python3 -m v2.plays $(seq 2009 "$SEASON")
python3 -m v2.games

if [ "$MODE" = "live" ]; then
  python3 -m v2.build_ratings "$SEASON"      # priors + weekly posteriors for the live season
  python3 -m v2.qb "$SEASON"
  python3 -m v2.elo
  python3 -m v2.snapshots "$SEASON"
  python3 -m v2.tests_leakage
  python3 -m v2.predict_live --season "$SEASON"
  exit 0
fi

# ---------------------------------------------------------------- retrain
# V1's market builder turns the multi-book archive into one row per game
# (opening + closing, margin convention) and V1's replay supplies the
# champion's per-game predictions for the comparison.
V1R="$HERE/../../cfb_p4/research"
V1DATA="$CFB_V2_DATA/v1"
mkdir -p "$V1DATA/out"
( cd "$V1R" && bash fetch_data.sh "$V1DATA" && CFB_P4_DATA="$V1DATA" python3 build_market.py "$V1DATA/out" \
  && node backtest_engine.js --data "$V1DATA" --from 2014 --to $((SEASON - 1)) --replay-from 2004 \
       --records "$V1DATA/out/v1_records.json" )
export CFB_V2_V1_MARKET="$V1DATA/out/market.csv" CFB_V2_V1_RECORDS="$V1DATA/out/v1_records.json"
python3 -m v2.games
python3 -m v2.tune_ratings            # rating knobs (dev seasons only)
python3 -m v2.build_ratings
python3 -m v2.qb
python3 -m v2.elo
python3 -m v2.snapshots
python3 -m v2.tests_leakage
python3 -m v2.ablation                # dev seasons only
python3 -m v2.tune_models all         # dev seasons only
python3 -m v2.pipeline                # walk-forward, market layer, dev-selected rule, holdout scored once
python3 -m v2.report
python3 -m v2.export
