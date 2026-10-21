# Legacy NFL baselines: per-game predictions from EdgeDesk's current model

`legacy_v1_predictions.csv` holds 5,524 rows, one for each completed NFL game from 2006 through 2026 week 6. That covers the regular season and postseason (REG, WC, DIV, CON, SB). The data was pulled on 2026-10-20. `game_id` is the nflverse id. `home_team` and `away_team` are the raw `games.csv` codes, so they include STL, SD and OAK for older seasons. All margins are home minus away, so a positive value means the home team is favoured, the same convention as `games.csv` `result` and `spread_line`. Every row has every column, so the file has no NaN values.

No tracked repo file was modified. The original scripts were run as they are, and the only edits went into copies in `scripts/`.

## Columns

### A. `trained_*`: the old model as trained (python research pipeline)

```
bash football/research/fetch_nfl_data.sh legacy/data           # games.csv + stw/spw 1999-2025
curl stats_team_week_2026.csv / stats_player_week_2026.csv     # -> data/nfl/stw_2026.csv, spw_2026.csv
python3 -I football/research/build_features.py data out/canon --nfl-only   # ORIGINAL script; it has a --nfl-only flag, so no CFB patch was needed
python3 -I football/research/train_nfl.py out/canon                        # ORIGINAL script
python3 -I scripts/build_features_2026.py data out/ext2026 --nfl-only      # copy patched to include 2026
python3 -I scripts/train_nfl_2026.py out/ext2026                           # copy patched to include 2026 and write totals
```

- **`trained_margin`** is `model_spread` from `<out>/nfl_oos.csv`. It equals `pred` (koerner spread ridge, lam=60) plus `ctx_adj` (stuckey context ridge, lam=200, fitted on the koerner residual). `train_nfl.py` builds this in its OOS frame `sp2` and writes it to `nfl_oos.csv`, so the ctx layer is already there and nothing had to be reconstructed. Both ridges are refit before each season on prior-season OOS rows only, and the hyperparameters were tuned on seasons up to 2015. The frozen hyperparameters are the same ones `params.js` ships (alpha 0.10, carry 0.80, alpha_qb 0.18).
  - **2006 caveat:** in 2006, `ctx_adj` is 0, so `trained_margin` is koerner only. The ctx walk-forward needs 4 prior seasons of OOS rows, and OOS rows start in 2003, so ctx first applies in 2007. This is how `train_nfl.py` itself behaves.
- **`trained_win_prob`** is `Phi(trained_margin / 10.7)`, computed with the exact `math.erf`. 10.7 is `params.js` `sigma_margin`, and the retrain also gets 10.7.
- **`trained_total`** is `model_total` (sharp_total ridge, lam=60, walk-forward) from the `to` frame. `train_nfl.py` never writes this frame to disk, so the patched copy writes it to `nfl_oos_total.csv`.
- **2026 rows:** the 2026-extended copies change only three things: `NFL_SEASONS` runs to 2026, the season filter in `build_features` runs to 2026, and the season filter in `train_nfl` runs to 2026. They also add one line that writes the totals CSV. Every prediction for 2025 and earlier is identical to the unmodified canonical run, with a max absolute difference of 0. The 2026 rows are fitted on 2003–2025 OOS rows, so they are truly out of sample.
- **Data vintage check:** the canonical retrain reproduces the shipped `params.js` closely. `w_spread`, `w_ctx` and `w_total` agree to about 1e-3 or better, sigma is 10.7 / 13.49, and the seed ratings differ by at most 1e-5.

### B. `shipped_*`: the old model as shipped (`football/engine.js` cold JS replay)

Script: `scripts/replay_shipped.js <data/nfl> out/shipped.csv`. It loads params with `global.EDFootballParams = require('.../football/params.js')` and the engine with `require('.../football/engine.js')`. Each step follows `app.html` `fbLoadNfl`:

- It uses the same CSV and number parsing as `fbCsv` and `fbNum`, where `''` and `NA` both become null.
- Rows are built with `teamGameFromStw` (offensive fields only) plus `pts_for` and `pts_against`.
- Games are absorbed with `absorbGame(st, [[home,hr],[away,ar]], [])`, so no QB starts are passed.
- `seasonBreak` is called once at each new season.
- Games are sorted by `gameday`, then `game_id`.
- Each game request carries home/away rest, roof, surface, div_game, week, temp, wind and both QB ids, with `neutral = location==='Neutral'`.

The replay starts cold in 2006: `st.team = st.ngames = st.teamQb = st.qb = {}`, with the shipped league means and hyperparameters kept. For each game it makes a pregame prediction from the state before that game, then absorbs the game.

- **`shipped_margin`** is `E.nfl.predict(st, req).model_spread`, which is koerner plus ctx. It is the same number `E.predictGame(...).model.fair_spread` returns, and I checked every game: 0 mismatches and 0 BLOCKED.
- **`shipped_win_prob`** is `E.dist.winProb('nfl', shipped_margin)`.
- **`shipped_total`** is `sharp_total`.

### C. `shipped_deffix_*`: B with the defense fixed

This uses the same script with `--deffix`. Before absorbing, each side's offensive fields are copied into the opponent's defensive fields: `off_epa_play→def_epa_play`, `pass_epa_db→def_pass_epa_db`, `rush_epa_att→def_rush_epa_att`, `expl_pass→def_expl_pass`, `expl_rush→def_expl_rush`, `sack_rate_all→sack_rate_made`. That is the same mapping `build_features.py` uses. Without it, every `def_*` rating in B stays at 0 for the whole replay.

## Deviations and things to know

1. **Franchise codes (B and C).** `stats_team_week_*.csv` labels every season with the current codes (LA, LAC, LV), while `games.csv` uses the code of the day (STL, SD, OAK). Without a fix, the `x.team === home_team` lookup finds no team-week rows for those clubs' games, and **542 games (2006–2019) are never absorbed**. My replay maps STL→LA, SD→LAC and OAK→LV, the same `FRANCHISE` map `build_features.py` uses, before the lookup and for the rating keys. The live board never meets this problem, because it absorbs only current-season games.
   - **This is a bug in `tools/football/validate_pricing.js`.** Its committed `football/validation/pricing_nfl.json` reports `without_team_week_rows: 542`. With `--raw-codes --no-neutral` (no neutral flag, as `validate_pricing.js` passes none), my replay reproduces that file exactly: on 2016–2025 with both clubs at 8 or more games (n=2658), spread MAE is 10.382 vs close 9.803 and total MAE is 10.659 vs 10.419.
2. **The cold replay is not exactly the live board.**
   - Live starts from seeds trained through 2025. Its defensive ratings therefore sit at 0.8× their 2025-end seed values and never update, and its QB layer is frozen at the seeds.
   - Cold B has defense at 0, and the QB layer is effectively off. With no starts, every QB is at `qb_prior` and `teamQb` is 0, so `qb_adj_diff` is about 0.
   - In 2006 the B and C ratings start at zero, so the early-2006 rows are close to intercept plus ctx. The trained ratings are warm from 1999. For comparisons, use 2007 or later.
3. **The coefficients in B and C are not out of sample for 2006–2025.** The ratings in B and C are leak-free, but `w_spread`, `w_ctx`, `w_total` and `sigma` in `params.js` were fitted on all OOS rows from 2003–2025. Only the hyperparameters were frozen on seasons up to 2015. In column A every coefficient is walk-forward. The 2026 rows are out of sample in all three columns.
4. **Neutral sites.** The engine drops the home-field intercept when `neutral` is true (90 games since 2006, 46 of them in the 2016–2025 regular season). The python trainer has no neutral handling, so column A is as trained. International venues that the feed does not mark Neutral are not treated as neutral, per the spec. The board would also check its venue table.
5. **erf.** Column A uses the exact `erf`. B and C use the engine's A&S approximation, whose error is at most 1.5e-7.

## Sanity numbers: MAE in points, each against the actual result on the same games

Spread figures compare the model margin with `result`, and the close is `spread_line`. Total figures compare the model total with the actual total, and the close is `total_line`.

| window | n | trained | shipped | shipped_deffix | close |
|---|---|---|---|---|---|
| **2016–2025 REG, spread** | 2639 | **10.231** | 10.394 | 10.225 | **9.788** |
| 2016–2025 all types, spread | 2761 | 10.200 | 10.354 | 10.194 | 9.777 |
| 2006–2015 REG, spread | 2560 | 10.911 | 11.130 | 10.916 | 10.754 |
| 2026 wk 1–6, spread | 93 | 9.727 | 9.704 | 9.636 | 9.306 |
| 2016–2025 REG, total | 2639 | 10.704 | 10.666 | 10.652 | 10.416 |

All three baselines and the close are scored on the same games in every row.

**Published figures.** The 2016–2025 all-types row reproduces the published `params.js` `validation_summary` exactly: spread 10.200 vs close 9.777, and total 10.706 vs close 10.438 (that total row is not shown in the table above). The published window includes the postseason. On the regular season alone, the figures are 10.231 vs 9.788.

**Win-prob Brier, 2016–2025 REG, excluding ties:** trained 0.2235, shipped 0.2290, deffix 0.2236.

**Margin correlations, 2016–2025 REG:**

| pair | correlation |
|---|---|
| trained ~ deffix | 0.990 |
| trained ~ shipped | 0.806 |
| trained ~ close | 0.853 |
| shipped ~ close | 0.687 |
| deffix ~ close | 0.848 |

The defense omission costs the shipped engine about 0.16–0.17 points of MAE. With the defense fixed, the shipped engine matches the trained model.

## Files

- `legacy_predictions.csv`: the deliverable.
- `out/sanity.json`: the full sanity numbers.
- `scripts/replay_shipped.js`: the replay for B and C, with the flags `--deffix`, `--raw-codes` and `--no-neutral`.
- `scripts/assemble.py`: joins the baselines and computes the sanity numbers.
- `scripts/*_2026.py`: the patched copies of the pipeline scripts.
- `out/canon/`: the unmodified pipeline run. It contains `nfl_oos.csv`, `report_nfl.json` and `params_nfl.json`.
- `out/ext2026/`: the 2026-extended run.
- `out/shipped*.csv`: the raw replay outputs. They also hold koerner, ctx, `known` and the predictGame status.
- `data/nfl/`: the downloaded nflverse files.
