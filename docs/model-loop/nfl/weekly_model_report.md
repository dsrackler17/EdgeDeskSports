# NFL weekly model report: 2026 week 6

Generated 2026-10-21T01:44:52Z. Served version **2.0.0** (SERVED; promoted by owner on 2026-10-21).

## What changed

**Nothing promoted.** 14 candidates were tested over 2 runs; none cleared the full-backtest rule (both MAE ≤ −0.003 and log loss ≤ −0.0002 over 2011–2026, and no worse on 2025). v2.0.0 keeps serving.

## Accuracy against the closing line (walk-forward, out of sample)

| Window | n | Model MAE | Close MAE | Log loss | Close log loss |
|---|---|---|---|---|---|
| 2026 to date | 93 | 9.5504 | 9.3065 | 0.65632 | 0.66145 |
| 2025 | 285 | 10.0584 | 9.6702 | 0.63899 | 0.60699 |
| 2011–2026 | 4189 | 10.1972 | 9.993 | 0.62297 | 0.60926 |

*The published record starts with the first week this version served; nothing it published has settled yet.*


## Where the misses concentrate (this season and last, walk-forward)

Line bias = model minus close (home side); outcome bias = result minus model. |t| ≥ 2 pulls the matching candidates forward.

| Pattern | n | Line bias | t | Outcome bias | t | Close beats model by (pts) |
|---|---|---|---|---|---|---|
| home | 378 | +0.54 | 3.79 | -0.46 | -0.72 | +0.35 |
| early_season | 128 | +0.79 | 3.61 | +0.30 | 0.27 | +0.41 |
| big_favourites | 107 | +0.39 | 1.2 | +0.65 | 0.51 | +0.54 |
| rest | 25 | +1.27 | 1.73 | -1.93 | -0.66 | +0.84 |
| bye | 34 | +0.84 | 2.46 | -1.43 | -0.77 | -0.52 |
| division | 127 | +0.92 | 3.34 | -0.73 | -0.63 | +0.42 |
| travel | 40 | +0.34 | 0.76 | +0.45 | 0.22 | -0.41 |
| qb_change | 70 | +0.89 | 1.86 | -2.38 | -1.29 | +0.52 |
| home_dogs | 157 | +1.33 | 6.25 | -1.59 | -1.55 | +0.56 |

## This season's largest misses against the close, by component

| Game | Model | Close | Result | Gap | Largest components |
|---|---|---|---|---|---|
| 2026_02_CAR_ATL | +5.2 | -2.5 | -31 | +7.7 | home_field +2.15; rush_def +1.02; timezone +0.76; pass_def +0.59; qb +0.57 |
| 2026_05_CHI_GB | +6.1 | -1.5 | +24 | +7.6 | qb +3.05; home_field +2.15; market +1.50; timezone +0.76; pass_def -0.63 |
| 2026_02_MIA_SF | +6.3 | +12.5 | +22 | -6.2 | home_field +2.15; timezone -1.59; qb +1.47; rush_off +0.98; travel +0.90 |
| 2026_03_SEA_WAS | -2.5 | -8.5 | +2 | +6.0 | market -2.18; home_field +2.15; timezone -1.59; rush_def -1.45; pass_def -0.91 |
| 2026_05_PHI_JAX | +1.6 | +7.5 | +2 | -5.9 | qb +1.82; travel -0.41; market -0.38; rush_def +0.30; pass_off +0.26 |
| 2026_02_JAX_DEN | -2.8 | +2.5 | +7 | -5.3 | home_field +2.15; qb -1.91; market -1.29; timezone -0.81; rush_def -0.52 |
| 2026_04_IND_WAS | +0.1 | -4.5 | -17 | +4.6 | market -1.09; qb +0.90; rush_def +0.66; rush_off -0.54; travel +0.19 |
| 2026_03_KC_MIA | -5.4 | -10.0 | -14 | +4.6 | market -4.30; home_field +2.15; qb -1.92; rush_off -0.91; pass_def -0.60 |

## Every candidate tried this week

| Candidate | Change | Full ΔMAE | Full Δlog loss | Prior-season ΔMAE | Prior-season Δlog loss | Decision |
|---|---|---|---|---|---|---|
| era_shorter | `model.hl_season` ['set', 3.0] | 0.0007 | 0.00031 | 0.019 | 0.00151 | FAIL: full-backtest MAE change +0.0007 does not clear -0.003; full-backtest log loss change +0.00031 does not clear -0.0002; worse on 2025 MAE (+0.0190); worse on 2025 log loss (+0.00151) |
| recency_faster | `rating.hl_week` ['mul', 0.5] | -0.0005 | -0.00036 | -0.031 | -0.00214 | FAIL: full-backtest MAE change -0.0005 does not clear -0.003 |
| pass_off_prior_weaker | `rating.lam.pass_off` ['mul', 0.5] | -0.0008 | -3e-05 | -0.0051 | 9e-05 | FAIL: full-backtest MAE change -0.0008 does not clear -0.003; full-backtest log loss change -0.00003 does not clear -0.0002; worse on 2025 log loss (+0.00009) |
| pass_def_prior_weaker | `rating.lam.pass_def` ['mul', 0.5] | 0.0006 | -8e-05 | 0.0065 | 0.00025 | FAIL: full-backtest MAE change +0.0006 does not clear -0.003; full-backtest log loss change -0.00008 does not clear -0.0002; worse on 2025 MAE (+0.0065); worse on 2025 log loss (+0.00025) |
| off_carry_lower | `rating.carry.off` ['add', -0.1] | -0.0007 | -2e-05 | 0.0019 | -0.00025 | FAIL: full-backtest MAE change -0.0007 does not clear -0.003; full-backtest log loss change -0.00002 does not clear -0.0002; worse on 2025 MAE (+0.0019) |
| def_carry_lower | `rating.carry.def` ['add', -0.1] | -0.0016 | 5e-05 | -0.0052 | -0.00019 | FAIL: full-backtest MAE change -0.0016 does not clear -0.003; full-backtest log loss change +0.00005 does not clear -0.0002 |
| market_prior_stronger | `rating.market.lam` ['mul', 2.0] | 0.0082 | 0.00029 | -0.0135 | -0.00106 | FAIL: full-backtest MAE change +0.0082 does not clear -0.003; full-backtest log loss change +0.00029 does not clear -0.0002 |
| market_slower | `rating.market.hl_week` ['mul', 2.0] | 0.0044 | 9e-05 | 0.0483 | 0.00297 | FAIL: full-backtest MAE change +0.0044 does not clear -0.003; full-backtest log loss change +0.00009 does not clear -0.0002; worse on 2025 MAE (+0.0483); worse on 2025 log loss (+0.00297) |
| split_od_on | `model.components.pass_split` ['set', True] | 0.004 | 0.00042 | 0.02 | 0.00138 | FAIL: full-backtest MAE change +0.0040 does not clear -0.003; full-backtest log loss change +0.00042 does not clear -0.0002; worse on 2025 MAE (+0.0200); worse on 2025 log loss (+0.00138) |
| market_carry_higher | `rating.market.carry` ['add', 0.2] | 0.0032 | -0.00015 | 0.0093 | -0.00034 | FAIL: full-backtest MAE change +0.0032 does not clear -0.003; full-backtest log loss change -0.00015 does not clear -0.0002; worse on 2025 MAE (+0.0093) |
| hfa_recent_era | `multi` ['multi', [['model.hfa_target', ['set', 'recent']], ['model.hfa_prior_games', ['set', 300.0]]]] | -0.0007 | -4e-05 | -0.0002 | -2e-05 | FAIL: full-backtest MAE change -0.0007 does not clear -0.003; full-backtest log loss change -0.00004 does not clear -0.0002 |
| hfa_recent_era_strong | `multi` ['multi', [['model.hfa_target', ['set', 'recent']], ['model.hfa_prior_games', ['set', 3000.0]]]] | -0.0026 | -0.00016 | -0.001 | -8e-05 | FAIL: full-backtest MAE change -0.0026 does not clear -0.003; full-backtest log loss change -0.00016 does not clear -0.0002 |
| market_hfa_looser | `rating.market.lam_hfa` ['mul', 0.25] | -0.0004 | -3e-05 | 0.0011 | 0.0002 | FAIL: full-backtest MAE change -0.0004 does not clear -0.003; full-backtest log loss change -0.00003 does not clear -0.0002; worse on 2025 MAE (+0.0011); worse on 2025 log loss (+0.00020) |
| division_on | `model.components.division` ['set', True] | -0.0007 | -4e-05 | 0.0173 | 0.0006 | FAIL: full-backtest MAE change -0.0007 does not clear -0.003; full-backtest log loss change -0.00004 does not clear -0.0002; worse on 2025 MAE (+0.0173); worse on 2025 log loss (+0.00060) |

Every candidate ever tried is in `docs/model-loop/nfl/candidates.jsonl`; the version history in `docs/model-loop/nfl/versions.json`.
