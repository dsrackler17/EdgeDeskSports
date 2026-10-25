# CFB weekly model report: 2026 week 8

Generated 2026-10-25T00:38:12Z. Served version **2.0.0** (SERVED; promoted by preregistered-rule on 2026-10-21).

## What changed

**Nothing promoted.** 9 candidates were tested; none cleared the full-backtest rule (both MAE ≤ −0.003 and log loss ≤ −0.0002 over 2014–2026, and no worse on 2025). v2.0.0 keeps serving.

## Accuracy against the closing line (walk-forward, out of sample)

| Window | n | Model MAE | Close MAE | Log loss | Close log loss |
|---|---|---|---|---|---|
| 2026 to date, all | 447 | 11.7926 | 11.0984 | 0.4672 | 0.44013 |
| 2026 to date, FBS vs FBS | 374 | 11.4689 | 10.9773 | 0.53895 | 0.51233 |
| 2026 to date, FBS vs FCS | 73 | 13.4508 | 11.7192 | 0.09956 | 0.07023 |
| 2025 | 934 | 12.1218 | 11.8969 | 0.47304 | 0.47257 |
| 2014–2026 | 10145 | 12.7439 | 12.2631 | 0.47845 | 0.47145 |

## The published record (pregame numbers as they were served)

| Window | n | Model MAE | Close MAE | \|model − close\| | Brier | Log loss | CLV (pts, n) | ATS vs close | Flags |
|---|---|---|---|---|---|---|---|---|---|
| Week 8 | 34 | 10.465 | 10.353 | 2.15 | 0.2343 | 0.6638 | 1.778 (18) | {'loss': 17, 'win': 17} | 1 |
| Season to date | 34 | 10.465 | 10.353 | 2.15 | 0.2343 | 0.6638 | 1.778 (18) | {'loss': 17, 'win': 17} | 1 |

### FBS games where the model differed from the close by 8+ points

| Game | Model | Close | Result | Drivers |
|---|---|---|---|---|
| NC State @ Stanford | Stanford +16.0 | Stanford +7.5 | +3 | rush_def -5.02; rush_off -2.97; pass_off -2.59; qb -2.56 |

## Head to head with the board's number (same games, pregame)

| Window | n | Model loop MAE | Board MAE | Close MAE | Model loop log loss | Board log loss | Model loop Brier | Board Brier |
|---|---|---|---|---|---|---|---|---|
| Last week | 34 | 10.465 | 10.921 | 10.353 | 0.6638 | 0.7023 | 0.2343 | 0.2443 |
| Season to date | 34 | 10.465 | 10.921 | 10.353 | 0.6638 | 0.7023 | 0.2343 | 0.2443 |

One season is not enough to rank two models; this table is the running record, and the full backtest decides promotions.


## Where the misses concentrate (this season and last, walk-forward)

Line bias = model minus close (home side); outcome bias = result minus model. |t| ≥ 2 pulls the matching candidates forward.

| Pattern | n | Line bias | t | Outcome bias | t | Close beats model by (pts) |
|---|---|---|---|---|---|---|
| home | 1381 | +0.40 | 3.42 | +0.56 | 1.38 | +0.38 |
| early_season | 542 | +0.62 | 2.78 | +0.51 | 0.78 | +0.32 |
| big_favourites | 508 | +0.34 | 1.45 | +1.29 | 1.88 | +0.46 |
| fcs | 199 | +1.89 | 3.84 | +0.65 | 0.6 | +0.48 |
| neutral | 67 | -0.61 | -1.09 | +2.10 | 1.18 | +1.14 |
| qb_change | 267 | +0.30 | 1.04 | +0.05 | 0.05 | +0.47 |
| home_dogs | 444 | +1.03 | 5.93 | -0.96 | -1.3 | +0.24 |
| postseason | 46 | -0.47 | -0.65 | +2.75 | 1.22 | +1.68 |

## This season's largest misses against the close, by component

| Game | Model | Close | Result | Gap | Largest components |
|---|---|---|---|---|---|
| Illinois State @ Northern Illinois | +16.0 | -2.5 | -4 | +18.5 | rush_def +3.94; pass_off +2.82; home_field +2.66; market +2.45; pass_def +2.07 |
| Prairie View A&M @ Baylor | +52.8 | +37.5 | +41 | +15.3 | market +26.16; rush_def +11.54; pass_def +4.83; pass_off +4.67; rush_off +3.74 |
| Howard @ Indiana | +72.4 | +57.5 | +55 | +14.9 | market +35.77; rush_def +11.16; pass_off +9.30; pass_def +5.64; rush_off +4.61 |
| Montana State @ Nevada | +9.9 | -4.5 | -13 | +14.4 | market -6.16; rush_off +5.79; rush_def +4.93; home_field +2.66; pass_def +2.52 |
| Delaware State @ South Florida | +50.8 | +37.5 | +42 | +13.3 | market +24.29; rush_def +10.99; pass_off +5.84; pass_def +3.85; rush_off +3.64 |
| North Dakota @ Nebraska | +40.4 | +27.5 | +27 | +12.9 | market +15.92; rush_def +7.54; rush_off +5.48; pass_off +4.72; pass_def +4.43 |
| East Texas A&M @ Tulsa | +29.1 | +41.5 | +42 | -12.4 | market +10.35; rush_def +9.01; rush_off +4.74; home_field +2.66; pass_def +1.44 |
| Mercyhurst @ Western Kentucky | +27.2 | +39.5 | +45 | -12.3 | market +14.98; rush_def +5.01; home_field +2.66; pass_def +2.03; rush_off +1.96 |

## Every candidate tried this week

| Candidate | Change | Full ΔMAE | Full Δlog loss | Prior-season ΔMAE | Prior-season Δlog loss | Decision |
|---|---|---|---|---|---|---|
| era_shorter | `model.hl_season` ['set', 3.0] | 0.0047 | 0.00075 | 0.0093 | 0.00142 | FAIL: full-backtest MAE change +0.0047 does not clear -0.003; full-backtest log loss change +0.00075 does not clear -0.0002; worse on 2025 MAE (+0.0093); worse on 2025 log loss (+0.00142) |
| hfa_shrink_on | `model.hfa_prior_games` ['set', 300.0] | 0.0 | 0.0 | 0.0 | 0.0 | FAIL: full-backtest MAE change +0.0000 does not clear -0.003; full-backtest log loss change +0.00000 does not clear -0.0002 |
| fcs_prior_weaker | `rating.lam.lower` ['mul', 0.5] | -0.0141 | -0.00014 | -0.0037 | 0.00031 | FAIL: full-backtest log loss change -0.00014 does not clear -0.0002; worse on 2025 log loss (+0.00031) |
| fcs_prior_stronger | `rating.lam.lower` ['mul', 2.0] | 0.0154 | 0.00024 | 0.0065 | 3e-05 | FAIL: full-backtest MAE change +0.0154 does not clear -0.003; full-backtest log loss change +0.00024 does not clear -0.0002; worse on 2025 MAE (+0.0065); worse on 2025 log loss (+0.00003) |
| era_longer | `model.hl_season` ['set', 10.0] | 0.0004 | 0.00021 | 0.0001 | 0.00038 | FAIL: full-backtest MAE change +0.0004 does not clear -0.003; full-backtest log loss change +0.00021 does not clear -0.0002; worse on 2025 MAE (+0.0001); worse on 2025 log loss (+0.00038) |
| recency_faster | `rating.hl_week` ['mul', 0.5] | — | — | — | — | SKIPPED: no change from the served configuration |
| pass_off_prior_weaker | `rating.lam.pass_off` ['mul', 0.5] | 0.0054 | 0.00018 | 0.0063 | 0.00013 | FAIL: full-backtest MAE change +0.0054 does not clear -0.003; full-backtest log loss change +0.00018 does not clear -0.0002; worse on 2025 MAE (+0.0063); worse on 2025 log loss (+0.00013) |
| talent_more | `rating.talent.off` ['add', 0.015] | -0.0012 | 0.00011 | 0.0067 | 0.00046 | FAIL: full-backtest MAE change -0.0012 does not clear -0.003; full-backtest log loss change +0.00011 does not clear -0.0002; worse on 2025 MAE (+0.0067); worse on 2025 log loss (+0.00046) |
| talent_def_more | `rating.talent.def` ['add', 0.015] | 0.0024 | 0.00024 | 0.0214 | 0.0011 | FAIL: full-backtest MAE change +0.0024 does not clear -0.003; full-backtest log loss change +0.00024 does not clear -0.0002; worse on 2025 MAE (+0.0214); worse on 2025 log loss (+0.00110) |
| retprod_more | `rating.retprod` ['add', 0.5] | -0.0015 | 6e-05 | 0.004 | 0.00013 | FAIL: full-backtest MAE change -0.0015 does not clear -0.003; full-backtest log loss change +0.00006 does not clear -0.0002; worse on 2025 MAE (+0.0040); worse on 2025 log loss (+0.00013) |

Every candidate ever tried is in `docs/model-loop/cfb/candidates.jsonl`; the version history in `docs/model-loop/cfb/versions.json`.
