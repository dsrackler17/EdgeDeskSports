# CFB weekly model report: 2026 week 9

Generated 2026-11-01T01:31:56Z. Served version **2.0.0** (SERVED; promoted by preregistered-rule on 2026-10-21).

## What changed

**Nothing promoted.** 8 candidates were tested; none cleared the full-backtest rule (both MAE ≤ −0.003 and log loss ≤ −0.0002 over 2014–2026, and no worse on 2025). v2.0.0 keeps serving.

## Accuracy against the closing line (walk-forward, out of sample)

| Window | n | Model MAE | Close MAE | Log loss | Close log loss |
|---|---|---|---|---|---|
| 2026 to date, all | 508 | 11.8567 | 11.1998 | 0.47571 | 0.4491 |
| 2026 to date, FBS vs FBS | 435 | 11.5899 | 11.1126 | 0.53863 | 0.51268 |
| 2026 to date, FBS vs FCS | 73 | 13.4469 | 11.7192 | 0.1008 | 0.07023 |
| 2025 | 934 | 12.1191 | 11.8969 | 0.47301 | 0.47257 |
| 2014–2026 | 10206 | 12.7392 | 12.2612 | 0.47874 | 0.47171 |

## The published record (pregame numbers as they were served)

| Window | n | Model MAE | Close MAE | \|model − close\| | Brier | Log loss | CLV (pts, n) | ATS vs close | Flags |
|---|---|---|---|---|---|---|---|---|---|
| Week 9 | 42 | 13.255 | 12.286 | 3.347 | 0.1757 | 0.5185 | 0.458 (42) | {'loss': 21, 'win': 19, 'push': 2} | 3 |
| Season to date | 95 | 11.969 | 11.374 | 2.687 | 0.2064 | 0.5944 | 0.471 (94) | {'loss': 50, 'win': 43, 'push': 2} | 5 |

### FBS games where the model differed from the close by 8+ points

| Game | Model | Close | Result | Drivers |
|---|---|---|---|---|
| Marshall @ Old Dominion | Old Dominion -5.2 | Old Dominion +3.0 | -13 | rush_def +3.83; pass_def +3.56; qb +0.91 |
| Colorado State @ Utah State | Utah State -0.7 | Utah State -9.5 | +17 | rush_off -6.86; pass_off -2.56 |
| Nevada @ UCLA | UCLA -31.0 | UCLA -22.5 | +27 | pass_off +5.59; rush_def +5.06; pass_def +3.75; rush_off +2.31 |

## Head to head with the board's number (same games, pregame)

| Window | n | Model loop MAE | Board MAE | Close MAE | Model loop log loss | Board log loss | Model loop Brier | Board Brier |
|---|---|---|---|---|---|---|---|---|
| Last week | 42 | 13.255 | 12.809 | 12.286 | 0.5185 | 0.5088 | 0.1757 | 0.164 |
| Season to date | 95 | 11.969 | 11.992 | 11.374 | 0.5944 | 0.6111 | 0.2064 | 0.2082 |

One season is not enough to rank two models; this table is the running record, and the full backtest decides promotions.


## Where the misses concentrate (this season and last, walk-forward)

Line bias = model minus close (home side); outcome bias = result minus model. |t| ≥ 2 pulls the matching candidates forward.

| Pattern | n | Line bias | t | Outcome bias | t | Close beats model by (pts) |
|---|---|---|---|---|---|---|
| home | 1442 | +0.41 | 3.58 | +0.64 | 1.61 | +0.38 |
| early_season | 542 | +0.63 | 2.82 | +0.50 | 0.77 | +0.29 |
| big_favourites | 521 | +0.39 | 1.7 | +1.14 | 1.69 | +0.42 |
| fcs | 199 | +1.90 | 3.86 | +0.65 | 0.59 | +0.47 |
| neutral | 69 | -0.70 | -1.28 | +2.38 | 1.37 | +1.21 |
| qb_change | 302 | +0.26 | 0.95 | +0.70 | 0.78 | +0.41 |
| home_dogs | 466 | +0.99 | 5.84 | -0.90 | -1.24 | +0.28 |
| postseason | 46 | -0.47 | -0.64 | +2.75 | 1.22 | +1.68 |

## This season's largest misses against the close, by component

| Game | Model | Close | Result | Gap | Largest components |
|---|---|---|---|---|---|
| Illinois State @ Northern Illinois | +16.0 | -2.5 | -4 | +18.5 | rush_def +3.86; pass_off +2.87; home_field +2.66; market +2.45; pass_def +1.97 |
| Prairie View A&M @ Baylor | +52.7 | +37.5 | +41 | +15.2 | market +26.16; rush_def +11.48; pass_def +4.74; pass_off +4.70; rush_off +3.80 |
| Howard @ Indiana | +72.4 | +57.5 | +55 | +14.9 | market +35.77; rush_def +11.09; pass_off +9.33; pass_def +5.54; rush_off +4.70 |
| Montana State @ Nevada | +9.8 | -4.5 | -13 | +14.3 | market -6.16; rush_off +5.87; rush_def +4.86; home_field +2.66; pass_def +2.43 |
| Delaware State @ South Florida | +50.7 | +37.5 | +42 | +13.2 | market +24.29; rush_def +10.95; pass_off +5.84; pass_def +3.81; rush_off +3.68 |
| North Dakota @ Nebraska | +40.1 | +27.5 | +27 | +12.6 | market +15.92; rush_def +7.43; rush_off +5.40; pass_off +4.71; pass_def +4.38 |
| Mercyhurst @ Western Kentucky | +27.2 | +39.5 | +45 | -12.3 | market +14.98; rush_def +4.95; home_field +2.66; rush_off +2.05; pass_def +2.01 |
| Fordham @ Coastal Carolina | +24.3 | +36.5 | +38 | -12.2 | rush_def +7.78; market +7.59; pass_off +3.51; home_field +2.66; rush_off +2.53 |

## Every candidate tried this week

| Candidate | Change | Full ΔMAE | Full Δlog loss | Prior-season ΔMAE | Prior-season Δlog loss | Decision |
|---|---|---|---|---|---|---|
| era_shorter | `model.hl_season` ['set', 3.0] | 0.0045 | 0.00074 | 0.0096 | 0.00143 | FAIL: full-backtest MAE change +0.0045 does not clear -0.003; full-backtest log loss change +0.00074 does not clear -0.0002; worse on 2025 MAE (+0.0096); worse on 2025 log loss (+0.00143) |
| hfa_shrink_on | `model.hfa_prior_games` ['set', 300.0] | 0.0 | 0.0 | 0.0 | 0.0 | FAIL: full-backtest MAE change +0.0000 does not clear -0.003; full-backtest log loss change +0.00000 does not clear -0.0002 |
| fcs_prior_weaker | `rating.lam.lower` ['mul', 0.5] | -0.014 | -0.00013 | -0.0037 | 0.00031 | FAIL: full-backtest log loss change -0.00013 does not clear -0.0002; worse on 2025 log loss (+0.00031) |
| fcs_prior_stronger | `rating.lam.lower` ['mul', 2.0] | 0.0152 | 0.00023 | 0.0065 | 3e-05 | FAIL: full-backtest MAE change +0.0152 does not clear -0.003; full-backtest log loss change +0.00023 does not clear -0.0002; worse on 2025 MAE (+0.0065); worse on 2025 log loss (+0.00003) |
| era_longer | `model.hl_season` ['set', 10.0] | 0.0003 | 0.00021 | 0.0002 | 0.00038 | FAIL: full-backtest MAE change +0.0003 does not clear -0.003; full-backtest log loss change +0.00021 does not clear -0.0002; worse on 2025 MAE (+0.0002); worse on 2025 log loss (+0.00038) |
| recency_faster | `rating.hl_week` ['mul', 0.5] | — | — | — | — | SKIPPED: no change from the served configuration |
| pass_off_prior_weaker | `rating.lam.pass_off` ['mul', 0.5] | 0.0055 | 0.00016 | 0.0065 | 0.00014 | FAIL: full-backtest MAE change +0.0055 does not clear -0.003; full-backtest log loss change +0.00016 does not clear -0.0002; worse on 2025 MAE (+0.0065); worse on 2025 log loss (+0.00014) |
| talent_def_more | `rating.talent.def` ['add', 0.015] | 0.0017 | 0.00024 | 0.0211 | 0.0011 | FAIL: full-backtest MAE change +0.0017 does not clear -0.003; full-backtest log loss change +0.00024 does not clear -0.0002; worse on 2025 MAE (+0.0211); worse on 2025 log loss (+0.00110) |
| retprod_more | `rating.retprod` ['add', 0.5] | -0.0013 | 5e-05 | 0.0039 | 0.00013 | FAIL: full-backtest MAE change -0.0013 does not clear -0.003; full-backtest log loss change +0.00005 does not clear -0.0002; worse on 2025 MAE (+0.0039); worse on 2025 log loss (+0.00013) |
| market_faster | `rating.market.hl_week` ['mul', 0.5] | — | — | — | — | SKIPPED: no change from the served configuration |

Every candidate ever tried is in `docs/model-loop/cfb/candidates.jsonl`; the version history in `docs/model-loop/cfb/versions.json`.
