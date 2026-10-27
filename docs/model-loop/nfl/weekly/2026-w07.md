# NFL weekly model report: 2026 week 7

Generated 2026-10-27T19:28:42Z. Served version **2.0.0** (SERVED; promoted by owner on 2026-10-21).

## What changed

**Nothing promoted.** 10 candidates were tested; none cleared the full-backtest rule (both MAE ≤ −0.003 and log loss ≤ −0.0002 over 2011–2026, and no worse on 2025). v2.0.0 keeps serving.

## Accuracy against the closing line (walk-forward, out of sample)

| Window | n | Model MAE | Close MAE | Log loss | Close log loss |
|---|---|---|---|---|---|
| 2026 to date | 107 | 9.7997 | 9.4065 | 0.66588 | 0.66159 |
| 2025 | 285 | 10.0584 | 9.6702 | 0.63899 | 0.60699 |
| 2011–2026 | 4203 | 10.2014 | 9.9932 | 0.62333 | 0.60944 |

## The published record (pregame numbers as they were served)

| Window | n | Model MAE | Close MAE | \|model − close\| | Brier | Log loss | CLV (pts, n) | ATS vs close | Flags ≥3 |
|---|---|---|---|---|---|---|---|---|---|
| Week 7 | 14 | 11.341 | 10.071 | 1.871 | 0.2607 | 0.7235 | 1.5 (14) | {'loss': 11, 'win': 3} | 2 |
| Season to date | 14 | 11.341 | 10.071 | 1.871 | 0.2607 | 0.7235 | 1.5 (14) | {'loss': 11, 'win': 3} | 2 |

### Games where the model differed from the close by 3+ points

| Game | Model | Close | Result | Drivers |
|---|---|---|---|---|
| TB @ CAR | CAR -7.6 | CAR -3.0 | -30 | qb +3.90; timezone +0.76 |
| KC @ SEA | SEA +0.3 | SEA -3.0 | +17 | qb -3.55; rush_off -1.68; timezone -0.81 |

## Head to head with the board's number (same games, pregame)

| Window | n | Model loop MAE | Board MAE | Close MAE | Model loop log loss | Board log loss | Model loop Brier | Board Brier |
|---|---|---|---|---|---|---|---|---|
| Last week | 14 | 11.341 | 11.08 | 10.071 | 0.7235 | 0.6847 | 0.2607 | 0.2398 |
| Season to date | 14 | 11.341 | 11.08 | 10.071 | 0.7235 | 0.6847 | 0.2607 | 0.2398 |

One season is not enough to rank two models; this table is the running record, and the full backtest decides promotions.


## Where the misses concentrate (this season and last, walk-forward)

Line bias = model minus close (home side); outcome bias = result minus model. |t| ≥ 2 pulls the matching candidates forward.

| Pattern | n | Line bias | t | Outcome bias | t | Close beats model by (pts) |
|---|---|---|---|---|---|---|
| home | 392 | +0.54 | 3.86 | -0.68 | -1.06 | +0.39 |
| early_season | 128 | +0.79 | 3.61 | +0.30 | 0.27 | +0.41 |
| big_favourites | 108 | +0.39 | 1.22 | +0.49 | 0.38 | +0.54 |
| rest | 26 | +1.18 | 1.66 | -1.70 | -0.61 | +0.85 |
| bye | 38 | +0.87 | 2.77 | -2.10 | -1.2 | -0.32 |
| division | 132 | +1.00 | 3.7 | -1.35 | -1.16 | +0.51 |
| travel | 42 | +0.32 | 0.74 | +0.63 | 0.33 | -0.31 |
| qb_change | 74 | +0.92 | 2.0 | -2.98 | -1.61 | +0.67 |
| home_dogs | 164 | +1.30 | 6.26 | -1.82 | -1.82 | +0.59 |

## This season's largest misses against the close, by component

| Game | Model | Close | Result | Gap | Largest components |
|---|---|---|---|---|---|
| 2026_02_CAR_ATL | +5.2 | -2.5 | -31 | +7.7 | home_field +2.15; rush_def +1.02; timezone +0.76; pass_def +0.59; qb +0.57 |
| 2026_05_CHI_GB | +6.1 | -1.5 | +24 | +7.6 | qb +3.05; home_field +2.15; market +1.50; timezone +0.76; pass_def -0.63 |
| 2026_02_MIA_SF | +6.3 | +12.5 | +22 | -6.2 | home_field +2.15; timezone -1.59; qb +1.47; rush_off +0.98; travel +0.90 |
| 2026_03_SEA_WAS | -2.5 | -8.5 | +2 | +6.0 | market -2.18; home_field +2.15; timezone -1.59; rush_def -1.45; pass_def -0.91 |
| 2026_05_PHI_JAX | +1.6 | +7.5 | +2 | -5.9 | qb +1.82; travel -0.41; market -0.38; rush_def +0.30; pass_off +0.26 |
| 2026_02_JAX_DEN | -2.8 | +2.5 | +7 | -5.3 | home_field +2.15; qb -1.91; market -1.29; timezone -0.81; rush_def -0.52 |
| 2026_07_DAL_PHI | +0.1 | -4.5 | -17 | +4.6 | home_field +2.15; market -2.11; qb -1.64; pass_def +1.13; rush_def +0.69 |
| 2026_04_IND_WAS | +0.1 | -4.5 | -17 | +4.6 | market -1.09; qb +0.90; rush_def +0.66; rush_off -0.54; travel +0.19 |

## Every candidate tried this week

| Candidate | Change | Full ΔMAE | Full Δlog loss | Prior-season ΔMAE | Prior-season Δlog loss | Decision |
|---|---|---|---|---|---|---|
| hfa_recent_era | `multi` ['multi', [['model.hfa_target', ['set', 'recent']], ['model.hfa_prior_games', ['set', 300.0]]]] | -0.0007 | -5e-05 | -0.0002 | -2e-05 | FAIL: full-backtest MAE change -0.0007 does not clear -0.003; full-backtest log loss change -0.00005 does not clear -0.0002 |
| hfa_recent_era_strong | `multi` ['multi', [['model.hfa_target', ['set', 'recent']], ['model.hfa_prior_games', ['set', 3000.0]]]] | -0.0027 | -0.00017 | -0.001 | -8e-05 | FAIL: full-backtest MAE change -0.0027 does not clear -0.003; full-backtest log loss change -0.00017 does not clear -0.0002 |
| market_hfa_looser | `rating.market.lam_hfa` ['mul', 0.25] | -0.0004 | -3e-05 | 0.0011 | 0.0002 | FAIL: full-backtest MAE change -0.0004 does not clear -0.003; full-backtest log loss change -0.00003 does not clear -0.0002; worse on 2025 MAE (+0.0011); worse on 2025 log loss (+0.00020) |
| era_shorter | `model.hl_season` ['set', 3.0] | 0.0009 | 0.00032 | 0.019 | 0.00151 | FAIL: full-backtest MAE change +0.0009 does not clear -0.003; full-backtest log loss change +0.00032 does not clear -0.0002; worse on 2025 MAE (+0.0190); worse on 2025 log loss (+0.00151) |
| division_on | `model.components.division` ['set', True] | -0.001 | -6e-05 | 0.0173 | 0.0006 | FAIL: full-backtest MAE change -0.0010 does not clear -0.003; full-backtest log loss change -0.00006 does not clear -0.0002; worse on 2025 MAE (+0.0173); worse on 2025 log loss (+0.00060) |
| recency_faster | `rating.hl_week` ['mul', 0.5] | -0.0006 | -0.00037 | -0.031 | -0.00214 | FAIL: full-backtest MAE change -0.0006 does not clear -0.003 |
| pass_off_prior_weaker | `rating.lam.pass_off` ['mul', 0.5] | -0.0007 | -3e-05 | -0.0051 | 9e-05 | FAIL: full-backtest MAE change -0.0007 does not clear -0.003; full-backtest log loss change -0.00003 does not clear -0.0002; worse on 2025 log loss (+0.00009) |
| travel_off | `model.components.travel` ['set', False] | -0.0122 | -0.00049 | -0.0043 | 0.00044 | FAIL: worse on 2025 log loss (+0.00044) |
| recency_slower | `rating.hl_week` ['mul', 2.0] | 0.0011 | 0.00036 | 0.0193 | 0.00117 | FAIL: full-backtest MAE change +0.0011 does not clear -0.003; full-backtest log loss change +0.00036 does not clear -0.0002; worse on 2025 MAE (+0.0193); worse on 2025 log loss (+0.00117) |
| pass_off_prior_stronger | `rating.lam.pass_off` ['mul', 2.0] | 0.0014 | 6e-05 | 0.0027 | -0.00016 | FAIL: full-backtest MAE change +0.0014 does not clear -0.003; full-backtest log loss change +0.00006 does not clear -0.0002; worse on 2025 MAE (+0.0027) |

Every candidate ever tried is in `docs/model-loop/nfl/candidates.jsonl`; the version history in `docs/model-loop/nfl/versions.json`.
