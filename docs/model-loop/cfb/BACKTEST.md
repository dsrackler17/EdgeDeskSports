# CFB v2: walk-forward backtest against the current engine (cfb_p4) and the closing line

Generated 2026-10-21T02:49:32Z by `model_loop/adapters/cfb/backtest.py report`; preregistration sha256 `203ef60b30188e4ce860b87224cf0f73e0e1d06241f8a2b479d8d6811dbe9e73` (`docs/model-loop/cfb/prereg.json`, committed before tuning).

## Decision

**Preregistered rule: cleared.** clears every condition.

Rule: v2 may replace cfb_p4 v1.0.1 on the card only if, on the 2025 holdout (all games), it has lower margin MAE AND lower log loss than the cfb_p4 replay on the same games, AND it is not worse on the full 2014-2025 backtest. Otherwise cfb_p4 stays and v2 remains EXPERIMENTAL. Beating the close is reported, not required.

**Served:** v2.0.0 (SERVED, promoted by owner 2026-10-21). Owner decision 2026-10-21: ship every sport's model loop and let it learn weekly. The preregistered rule is also cleared: v2 beats the cfb_p4 replay on MAE and log loss on the 2014-2025 backtest and on the 2025 holdout. Full 2014-2025 backtest, all games: v2 MAE 12.7853 vs cfb_p4 13.2703 vs close 12.3168; log loss 0.47891 vs 0.49449. 2025 holdout: MAE 12.1215 vs 12.4794; log loss 0.4731 vs 0.47651. Beats cfb_p4 on the full backtest: yes; on the holdout: yes. Neither model beats the closing line over all games (close MAE 12.3168 on the backtest, 11.8969 on the holdout).

## v2 vs cfb_p4 vs the close (same games, paired)

Margin MAE against the final score; log loss of the home win probability (ties excluded). *Close* is the median closing line across books in the cfbfastR archive (2026: the record's DraftKings close). The close's log loss uses the no-vig closing moneyline where the archive has one, else the same distribution centred on the closing spread. cfb_p4 is the current card engine replayed cold (its coefficients were trained on 2001–2025, so before 2026 it is partly in sample).

| Slice | Window | n | v2 MAE | cfb_p4 MAE | Close MAE | v2 log loss | cfb_p4 log loss | Close log loss |
|---|---|---|---|---|---|---|---|---|
| All games with an FBS side | Tune 2014–2020 | 5262 | 12.948 | 13.416 | 12.469 | 0.4711 | 0.4867 | 0.4637 |
| All games with an FBS side | Validation 2021–2024 | 3502 | 12.718 | 13.262 | 12.200 | 0.4921 | 0.5110 | 0.4867 |
| All games with an FBS side | **Holdout 2025** | 934 | 12.121 | 12.479 | 11.897 | 0.4731 | 0.4765 | 0.4726 |
| All games with an FBS side | Live 2026 (to date) | 410 | 11.856 | 12.785 | 11.139 | 0.4465 | 0.4705 | 0.4182 |
| All games with an FBS side | Full backtest 2014–2025 | 9698 | 12.785 | 13.270 | 12.317 | 0.4789 | 0.4945 | 0.4729 |
| FBS vs FBS | Tune 2014–2020 | 4671 | 12.796 | 13.130 | 12.448 | 0.5048 | 0.5187 | 0.4979 |
| FBS vs FBS | Validation 2021–2024 | 3048 | 12.550 | 12.959 | 12.188 | 0.5372 | 0.5559 | 0.5345 |
| FBS vs FBS | **Holdout 2025** | 808 | 12.123 | 12.280 | 11.822 | 0.5256 | 0.5306 | 0.5250 |
| FBS vs FBS | Live 2026 (to date) | 337 | 11.509 | 12.093 | 11.013 | 0.5216 | 0.5398 | 0.4936 |
| FBS vs FBS | Full backtest 2014–2025 | 8527 | 12.645 | 12.988 | 12.296 | 0.5184 | 0.5331 | 0.5135 |
| FBS vs FCS / lower division | Tune 2014–2020 | 591 | 14.145 | 15.678 | 12.637 | 0.2046 | 0.2338 | 0.1936 |
| FBS vs FCS / lower division | Validation 2021–2024 | 454 | 13.847 | 15.296 | 12.282 | 0.1894 | 0.2101 | 0.1663 |
| FBS vs FCS / lower division | **Holdout 2025** | 126 | 12.110 | 13.770 | 12.375 | 0.1364 | 0.1272 | 0.1363 |
| FBS vs FCS / lower division | Live 2026 (to date) | 73 | 13.459 | 15.977 | 11.719 | 0.0995 | 0.1505 | 0.0702 |
| FBS vs FCS / lower division | Full backtest 2014–2025 | 1171 | 13.811 | 15.326 | 12.471 | 0.1914 | 0.2132 | 0.1769 |

## What was built, item by item

| Item | What was built, and what the backtest says |
|---|---|
| Opponent-adjusted EPA ratings: pass O / pass D / rush O / rush D, per-week penalized fit with priors | Built (`ratings.py`, core `penalized_wls`): a fit before every slate on that season's plays only. Line influence over 2014–2025 (SD of points): passing 4.56 (offense incl. QB 3.54, defense 2.26) vs rushing 4.85; market rating 8.39. Separate offense/defense coefficients: removing it changes validation MAE by +0.0106 and log loss by +0.00100: **active (adds value)**. |
| Garbage-time weight | Plays with naive win probability outside 10–90% count 0.25 of a play (fixed, not tuned; the naive model reads no spread). removing it changes validation MAE by +0.0319 and log loss by +0.00089: **active (adds value)**. |
| Recency half-life | Tuned off on 2014–2020: every earlier week of the season counts equally (the grid offered 3, 6 and 12 slates); last season fades through the prior strengths instead. inactive (tuned off). |
| Separate prior strengths for offense and defense | Tuned on 2014–2020, in plays of evidence: pass O 50, pass D 50, rush O 50, rush D 150, QB 150. Share of base strength that is prior, by week: wk 1 100%, wk 2 50%, wk 3 42%, wk 4 36%, wk 5 31%, wk 6 27%, wk 8 24%, wk 10 21%, wk 12 18%, wk 14 18%. |
| Season carryover, fitted | Carry tuned: offense 0.6, defense 0.8, QB 0.6 (×0.8 per season missed), FCS teams 0.9, market 1.0. removing it changes validation MAE by +0.6394 and log loss by +0.01830: **active (adds value)**. |
| Priors: conference, talent, returning production | Conference mean weight 0.5: removing it changes validation MAE by +0.0520 and log loss by +0.00252: **active (adds value)**. 247 talent composite (0.06 off / 0.0 def EPA/play per SD): removing it changes validation MAE by +0.0598 and log loss by +0.00133: **active (adds value)**. Returning-production carry slope 0.0: inactive (tuned off). Both feeds have history in sportsdataverse-data (talent 2008+, returning production 2004+), contrary to the brief's premise; they carry no publication timestamp, so they are measured, not assumed point-in-time. |
| FCS opponents: no single floor | Every FCS / lower-division team in the play-by-play is its own parameter around its division's FITTED mean (prior strength 200 plays, carry 0.9). One fitted level per division instead (the ablation): removing it changes validation MAE by +0.0384 and log loss by +0.00090: **active (adds value)**. A learned lower-division row on top of the ratings (-0.31 pts for 2026): removing it changes validation MAE by -0.0015 and log loss by +0.00005: **active (adds value)**. |
| Quarterback carried with the player | Each passer is a parameter (ESPN athlete id) that follows him through transfers; a debut QB starts at his division's debut mean from earlier seasons. removing it changes validation MAE by +0.0410 and log loss by +0.00290: **active (adds value)**. QB line influence SD 1.82 pts. |
| Market rating from prior weeks' closes | Refitted every slate on earlier closes (no in-season decay, prior 0.25 games of evidence, last season carried ×1.0, FCS division means fitted). removing it changes validation MAE by +0.3605 and log loss by +0.01365: **active (adds value)**. |
| Home field fitted from recent seasons, neutral sites honoured | Walk-forward on every earlier season since 2010 equally (era weighting, half-lives 3 and 6, was tuned off on 2014–2020): 2.66 pts for 2026 (the market-implied ~2.6 in the audit; cfb_p4 shipped 4.08 until 2026-10-18, now 2.8). A neutral site gets none. Era weighting: inactive (tuned off). Shrinkage: inactive (tuned off). 2020 no-crowd row: removing it changes validation MAE by -0.0015 and log loss by +0.00004: **active (adds value)**. Rest / bye / short week: removing it changes validation MAE by +0.0208 and log loss by +0.00010: **active (adds value)**. Travel and time zones: not built (venue geography not ingested), inactive. |
| Key-number distribution, CFB's own sigma and multipliers, range centred | core `KeyNumberMargin` refitted each season on earlier seasons (support ±100; 2026: sigma 16.5). Pushes at closing lines of 3 / 7 / 14: predicted 6.0%, 5.8%, 3.7% vs observed 6.5%, 8.5%, 3.7% (plain normal 2.3%, 2.3%, 2.3%). Three-way cover log loss at the close 0.85102 vs 0.86166 flat. The 80% range is the symmetric interval around the projection (centred by construction; the cfb_p4 range sat −1.0 off centre). |
| Calibration | Distribution width fitted by likelihood on earlier seasons only (ECE 0.0157). Platt on top: log loss 0.48332 → 0.48295; isotonic → 0.48768. |
| Components sum exactly to the fair line | Linear model: every card row is coefficient × input and the rows sum to the fair line (tests hold the residual to 1e-9, FBS and FCS games alike). |
| Totals | Intercept + both pass matchups + both rush matchups + market total rating, walk-forward like the margin. |

## Every window: All games with an FBS side

| Window | n | Model | Margin MAE | Close MAE | Log loss | Close log loss | Brier | \|model − close\| | ≥3 pts from close | Total MAE | Close total MAE |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Tune 2014–2020 | 5262 | v2 (model loop) | 12.948 | 12.469 | 0.4711 | 0.4637 | 0.1556 | 3.59 | 47.2% | 13.549 | 13.195 |
| Tune 2014–2020 | 5253 | cfb_p4 v1.0.1 (replay) | 13.416 | 12.466 | 0.4867 | 0.4637 | 0.1619 | 4.37 | 54.8% | 13.678 | 13.210 |
| Validation 2021–2024 | 3502 | v2 (model loop) | 12.718 | 12.200 | 0.4921 | 0.4867 | 0.1648 | 3.65 | 48.3% | 12.811 | 12.446 |
| Validation 2021–2024 | 3498 | cfb_p4 v1.0.1 (replay) | 13.262 | 12.198 | 0.5110 | 0.4869 | 0.1716 | 4.51 | 54.2% | 12.878 | 12.501 |
| **Holdout 2025** | 934 | v2 (model loop) | 12.121 | 11.897 | 0.4731 | 0.4726 | 0.1583 | 3.34 | 44.9% | 12.670 | 12.418 |
| **Holdout 2025** | 932 | cfb_p4 v1.0.1 (replay) | 12.479 | 11.884 | 0.4765 | 0.4735 | 0.1593 | 4.10 | 52.9% | 12.877 | 12.536 |
| Live 2026 (to date) | 410 | v2 (model loop) | 11.856 | 11.139 | 0.4465 | 0.4182 | 0.1488 | 3.60 | 49.0% | 12.214 | 12.098 |
| Live 2026 (to date) | 410 | cfb_p4 v1.0.1 (replay) | 12.785 | 11.139 | 0.4705 | 0.4182 | 0.1569 | 4.96 | 58.1% | 12.682 | 12.230 |
| Full backtest 2014–2025 | 9698 | v2 (model loop) | 12.785 | 12.317 | 0.4789 | 0.4729 | 0.1592 | 3.59 | 47.4% | 13.197 | 12.849 |
| Full backtest 2014–2025 | 9683 | cfb_p4 v1.0.1 (replay) | 13.270 | 12.313 | 0.4945 | 0.4731 | 0.1652 | 4.39 | 54.4% | 13.316 | 12.892 |
| Live 2026 (to date) | 410 | cfb_p4 as published (record) | 12.599 | 11.139 | 0.4946 | 0.4538 | 0.1655 | 5.04 | 60.0% | 12.683 | 12.230 |

## Every window: FBS vs FBS

| Window | n | Model | Margin MAE | Close MAE | Log loss | Close log loss | Brier | \|model − close\| | ≥3 pts from close | Total MAE | Close total MAE |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Tune 2014–2020 | 4671 | v2 (model loop) | 12.796 | 12.448 | 0.5048 | 0.4979 | 0.1680 | 3.24 | 44.3% | 13.547 | 13.196 |
| Tune 2014–2020 | 4663 | cfb_p4 v1.0.1 (replay) | 13.130 | 12.444 | 0.5187 | 0.4979 | 0.1743 | 3.79 | 51.8% | 13.665 | 13.198 |
| Validation 2021–2024 | 3048 | v2 (model loop) | 12.550 | 12.188 | 0.5372 | 0.5345 | 0.1812 | 3.25 | 44.5% | 12.824 | 12.505 |
| Validation 2021–2024 | 3044 | cfb_p4 v1.0.1 (replay) | 12.959 | 12.186 | 0.5559 | 0.5348 | 0.1887 | 3.90 | 50.6% | 12.878 | 12.499 |
| **Holdout 2025** | 808 | v2 (model loop) | 12.123 | 11.822 | 0.5256 | 0.5250 | 0.1777 | 3.03 | 42.0% | 12.777 | 12.540 |
| **Holdout 2025** | 807 | cfb_p4 v1.0.1 (replay) | 12.280 | 11.808 | 0.5306 | 0.5256 | 0.1794 | 3.62 | 49.3% | 12.861 | 12.523 |
| Live 2026 (to date) | 337 | v2 (model loop) | 11.509 | 11.013 | 0.5216 | 0.4936 | 0.1748 | 2.99 | 42.4% | 12.446 | 12.230 |
| Live 2026 (to date) | 337 | cfb_p4 v1.0.1 (replay) | 12.093 | 11.013 | 0.5398 | 0.4936 | 0.1827 | 3.85 | 52.5% | 12.682 | 12.230 |
| Full backtest 2014–2025 | 8527 | v2 (model loop) | 12.645 | 12.296 | 0.5184 | 0.5135 | 0.1737 | 3.23 | 44.1% | 13.215 | 12.887 |
| Full backtest 2014–2025 | 8514 | cfb_p4 v1.0.1 (replay) | 12.988 | 12.291 | 0.5331 | 0.5137 | 0.1799 | 3.82 | 51.1% | 13.308 | 12.884 |
| Live 2026 (to date) | 337 | cfb_p4 as published (record) | 11.962 | 11.013 | 0.5454 | 0.5037 | 0.1837 | 4.04 | 55.5% | 12.683 | 12.230 |

## Every window: FBS vs FCS / lower division

| Window | n | Model | Margin MAE | Close MAE | Log loss | Close log loss | Brier | \|model − close\| | ≥3 pts from close | Total MAE | Close total MAE |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Tune 2014–2020 | 591 | v2 (model loop) | 14.145 | 12.637 | 0.2046 | 0.1936 | 0.0577 | 6.32 | 69.9% | 13.562 | 13.189 |
| Tune 2014–2020 | 590 | cfb_p4 v1.0.1 (replay) | 15.678 | 12.639 | 0.2338 | 0.1938 | 0.0640 | 8.92 | 78.1% | 28.567 | 26.500 |
| Validation 2021–2024 | 454 | v2 (model loop) | 13.847 | 12.282 | 0.1894 | 0.1663 | 0.0539 | 6.33 | 73.8% | 12.726 | 12.047 |
| Validation 2021–2024 | 454 | cfb_p4 v1.0.1 (replay) | 15.296 | 12.282 | 0.2101 | 0.1663 | 0.0567 | 8.57 | 78.2% | 12.951 | 13.500 |
| **Holdout 2025** | 126 | v2 (model loop) | 12.110 | 12.375 | 0.1364 | 0.1363 | 0.0336 | 5.33 | 63.5% | 11.981 | 11.637 |
| **Holdout 2025** | 125 | cfb_p4 v1.0.1 (replay) | 13.770 | 12.374 | 0.1272 | 0.1370 | 0.0295 | 7.19 | 76.0% | 19.123 | 17.625 |
| Live 2026 (to date) | 73 | v2 (model loop) | 13.459 | 11.719 | 0.0995 | 0.0702 | 0.0290 | 6.41 | 79.5% | 11.145 | 11.486 |
| Live 2026 (to date) | 73 | cfb_p4 v1.0.1 (replay) | 15.977 | 11.719 | 0.1505 | 0.0702 | 0.0378 | 10.08 | 83.6% | — | — |
| Full backtest 2014–2025 | 1171 | v2 (model loop) | 13.811 | 12.471 | 0.1914 | 0.1769 | 0.0536 | 6.22 | 70.7% | 13.064 | 12.575 |
| Full backtest 2014–2025 | 1169 | cfb_p4 v1.0.1 (replay) | 15.326 | 12.472 | 0.2132 | 0.1771 | 0.0575 | 8.60 | 77.9% | 18.705 | 18.135 |
| Live 2026 (to date) | 73 | cfb_p4 as published (record) | 15.543 | 11.719 | 0.0986 | 0.0650 | 0.0237 | 9.65 | 80.8% | — | — |

## Paired differences (same games; bootstrap 95% intervals)

| Slice | Window | Comparison | n | Δ MAE (neg = first better) | 95% CI | Δ log loss | 95% CI |
|---|---|---|---|---|---|---|---|
| All games with an FBS side | Tune 2014–2020 | v2 − cfb_p4 | 5548 | -0.395 | [-0.549, -0.249] | -0.0140 | [-0.0203, -0.0076] |
| All games with an FBS side | Tune 2014–2020 | v2 − close | 5262 | +0.478 | [+0.362, +0.600] | — | — |
| All games with an FBS side | Tune 2014–2020 | cfb_p4 − close | 5253 | +0.950 | [+0.811, +1.097] | — | — |
| All games with an FBS side | Validation 2021–2024 | v2 − cfb_p4 | 3528 | -0.541 | [-0.728, -0.353] | -0.0185 | [-0.0267, -0.0103] |
| All games with an FBS side | Validation 2021–2024 | v2 − close | 3502 | +0.519 | [+0.373, +0.665] | — | — |
| All games with an FBS side | Validation 2021–2024 | cfb_p4 − close | 3498 | +1.064 | [+0.878, +1.250] | — | — |
| All games with an FBS side | **Holdout 2025** | v2 − cfb_p4 | 932 | -0.372 | [-0.716, -0.031] | -0.0024 | [-0.0152, +0.0108] |
| All games with an FBS side | **Holdout 2025** | v2 − close | 934 | +0.225 | [-0.031, +0.476] | — | — |
| All games with an FBS side | **Holdout 2025** | cfb_p4 − close | 932 | +0.596 | [+0.287, +0.944] | — | — |
| All games with an FBS side | Live 2026 (to date) | v2 − cfb_p4 | 508 | -1.118 | [-1.655, -0.581] | -0.0273 | [-0.0474, -0.0085] |
| All games with an FBS side | Live 2026 (to date) | v2 − close | 410 | +0.717 | [+0.298, +1.147] | — | — |
| All games with an FBS side | Live 2026 (to date) | cfb_p4 − close | 410 | +1.646 | [+1.086, +2.249] | — | — |
| All games with an FBS side | Full backtest 2014–2025 | v2 − cfb_p4 | 10008 | -0.445 | [-0.555, -0.329] | -0.0145 | [-0.0194, -0.0098] |
| All games with an FBS side | Full backtest 2014–2025 | v2 − close | 9698 | +0.469 | [+0.385, +0.557] | — | — |
| All games with an FBS side | Full backtest 2014–2025 | cfb_p4 − close | 9683 | +0.957 | [+0.850, +1.068] | — | — |
| All games with an FBS side | Live 2026 (to date) | v2 − cfb_p4 as published | 410 | -0.743 | [-1.310, -0.172] | — | — |
| FBS vs FBS | Tune 2014–2020 | v2 − cfb_p4 | 4865 | -0.272 | [-0.416, -0.121] | -0.0125 | [-0.0196, -0.0057] |
| FBS vs FBS | Tune 2014–2020 | v2 − close | 4671 | +0.348 | [+0.240, +0.457] | — | — |
| FBS vs FBS | Tune 2014–2020 | cfb_p4 − close | 4663 | +0.686 | [+0.556, +0.820] | — | — |
| FBS vs FBS | Validation 2021–2024 | v2 − cfb_p4 | 3052 | -0.416 | [-0.602, -0.221] | -0.0184 | [-0.0278, -0.0097] |
| FBS vs FBS | Validation 2021–2024 | v2 − close | 3048 | +0.363 | [+0.230, +0.503] | — | — |
| FBS vs FBS | Validation 2021–2024 | cfb_p4 − close | 3044 | +0.773 | [+0.607, +0.949] | — | — |
| FBS vs FBS | **Holdout 2025** | v2 − cfb_p4 | 807 | -0.168 | [-0.476, +0.143] | -0.0044 | [-0.0194, +0.0100] |
| FBS vs FBS | **Holdout 2025** | v2 − close | 808 | +0.301 | [+0.053, +0.550] | — | — |
| FBS vs FBS | **Holdout 2025** | cfb_p4 − close | 807 | +0.472 | [+0.179, +0.755] | — | — |
| FBS vs FBS | Live 2026 (to date) | v2 − cfb_p4 | 386 | -0.705 | [-1.181, -0.241] | -0.0233 | [-0.0478, -0.0007] |
| FBS vs FBS | Live 2026 (to date) | v2 − close | 337 | +0.496 | [+0.115, +0.874] | — | — |
| FBS vs FBS | Live 2026 (to date) | cfb_p4 − close | 337 | +1.080 | [+0.619, +1.546] | — | — |
| FBS vs FBS | Full backtest 2014–2025 | v2 − cfb_p4 | 8724 | -0.313 | [-0.425, -0.202] | -0.0138 | [-0.0189, -0.0085] |
| FBS vs FBS | Full backtest 2014–2025 | v2 − close | 8527 | +0.349 | [+0.268, +0.433] | — | — |
| FBS vs FBS | Full backtest 2014–2025 | cfb_p4 − close | 8514 | +0.697 | [+0.594, +0.790] | — | — |
| FBS vs FBS | Live 2026 (to date) | v2 − cfb_p4 as published | 337 | -0.453 | [-1.004, +0.080] | — | — |
| FBS vs FCS / lower division | Tune 2014–2020 | v2 − cfb_p4 | 683 | -1.272 | [-1.869, -0.638] | -0.0249 | [-0.0439, -0.0073] |
| FBS vs FCS / lower division | Tune 2014–2020 | v2 − close | 591 | +1.509 | [+0.909, +2.085] | — | — |
| FBS vs FCS / lower division | Tune 2014–2020 | cfb_p4 − close | 590 | +3.039 | [+2.271, +3.813] | — | — |
| FBS vs FCS / lower division | Validation 2021–2024 | v2 − cfb_p4 | 476 | -1.342 | [-1.968, -0.712] | -0.0189 | [-0.0407, +0.0003] |
| FBS vs FCS / lower division | Validation 2021–2024 | v2 − close | 454 | +1.565 | [+0.917, +2.193] | — | — |
| FBS vs FCS / lower division | Validation 2021–2024 | cfb_p4 − close | 454 | +3.014 | [+2.195, +3.859] | — | — |
| FBS vs FCS / lower division | **Holdout 2025** | v2 − cfb_p4 | 125 | -1.685 | [-3.014, -0.351] | +0.0101 | [-0.0118, +0.0323] |
| FBS vs FCS / lower division | **Holdout 2025** | v2 − close | 126 | -0.265 | [-1.295, +0.727] | — | — |
| FBS vs FCS / lower division | **Holdout 2025** | cfb_p4 − close | 125 | +1.396 | [+0.029, +2.820] | — | — |
| FBS vs FCS / lower division | Live 2026 (to date) | v2 − cfb_p4 | 122 | -2.423 | [-4.105, -0.885] | -0.0398 | [-0.0804, -0.0088] |
| FBS vs FCS / lower division | Live 2026 (to date) | v2 − close | 73 | +1.740 | [+0.086, +3.449] | — | — |
| FBS vs FCS / lower division | Live 2026 (to date) | cfb_p4 − close | 73 | +4.258 | [+2.008, +6.681] | — | — |
| FBS vs FCS / lower division | Full backtest 2014–2025 | v2 − cfb_p4 | 1284 | -1.338 | [-1.779, -0.933] | -0.0193 | [-0.0314, -0.0081] |
| FBS vs FCS / lower division | Full backtest 2014–2025 | v2 − close | 1171 | +1.340 | [+0.935, +1.717] | — | — |
| FBS vs FCS / lower division | Full backtest 2014–2025 | cfb_p4 − close | 1169 | +2.854 | [+2.333, +3.360] | — | — |
| FBS vs FCS / lower division | Live 2026 (to date) | v2 − cfb_p4 as published | 73 | -2.084 | [-4.299, +0.071] | — | — |

## Incremental-value bar: each component removed, scored on VALIDATION (2021–2024) only

A component stays active only if removing it makes validation margin MAE or log loss (all games with a close) worse; the rule keeps a component on either metric, so a row whose removal moves both by less than the noise (division row, 2020 row) stays active on a log-loss gain of ~0.00005 and is, in effect, neutral. The FBS / FCS columns are every game with a result (with or without a close). The holdout was not consulted.

| Component | Validation MAE without it (with) | Δ MAE if removed | Δ log loss if removed | FBS: MAE with → without | FCS: MAE with → without | Paired Δ\|err\| 95% CI | Status |
|---|---|---|---|---|---|---|---|
| garbage_time_filter | 12.7503 (12.7184) | +0.0319 | +0.00089 | 12.576 → 12.595 | 13.738 → 13.800 | [-0.083, +0.038] | active (adds value) |
| in_season_recency | — | — | — | — | — | — | inactive (tuned off) |
| qb_layer | 12.7594 (12.7184) | +0.0410 | +0.00290 | 12.576 → 12.599 | 13.738 → 13.908 | [-0.087, +0.005] | active (adds value) |
| market_rating | 13.0789 (12.7184) | +0.3605 | +0.01365 | 12.576 → 12.912 | 13.738 → 14.259 | [-0.473, -0.247] | active (adds value) |
| last_season_carryover | 13.3578 (12.7184) | +0.6394 | +0.01830 | 12.576 → 13.107 | 13.738 → 15.002 | [-0.773, -0.465] | active (adds value) |
| conference_prior | 12.7704 (12.7184) | +0.0520 | +0.00252 | 12.576 → 12.626 | 13.738 → 13.775 | [-0.080, -0.014] | active (adds value) |
| talent_prior | 12.7782 (12.7184) | +0.0598 | +0.00133 | 12.576 → 12.648 | 13.738 → 13.702 | [-0.098, -0.014] | active (adds value) |
| returning_production | — | — | — | — | — | — | inactive (tuned off) |
| fcs_team_ratings | 12.7568 (12.7184) | +0.0384 | +0.00090 | 12.576 → 12.594 | 13.738 → 13.878 | [-0.061, -0.004] | active (adds value) |
| division_offset | 12.7169 (12.7184) | -0.0015 | +0.00005 | 12.576 → 12.574 | 13.738 → 13.748 | [-0.003, +0.005] | active (adds value) |
| offense_defense_split | 12.7290 (12.7184) | +0.0106 | +0.00100 | 12.576 → 12.589 | 13.738 → 13.743 | [-0.033, +0.010] | active (adds value) |
| rest_bye_short | 12.7392 (12.7184) | +0.0208 | +0.00010 | 12.576 → 12.601 | 13.738 → 13.733 | [-0.039, -0.003] | active (adds value) |
| covid_2020 | 12.7169 (12.7184) | -0.0015 | +0.00004 | 12.576 → 12.575 | 13.738 → 13.735 | [-0.001, +0.005] | active (adds value) |
| hfa_shrinkage | — | — | — | — | — | — | inactive (tuned off) |
| era_weighting | — | — | — | — | — | — | inactive (tuned off) |

## Calibration of the win probability

### Holdout 2025 (all games)

| Predicted bin | n | Mean predicted | Observed |
|---|---|---|---|
| 0.0-0.1 | 15 | 0.064 | 0.067 |
| 0.1-0.2 | 36 | 0.150 | 0.111 |
| 0.2-0.3 | 66 | 0.259 | 0.242 |
| 0.3-0.4 | 77 | 0.351 | 0.377 |
| 0.4-0.5 | 104 | 0.456 | 0.385 |
| 0.5-0.6 | 115 | 0.551 | 0.626 |
| 0.6-0.7 | 138 | 0.647 | 0.688 |
| 0.7-0.8 | 106 | 0.748 | 0.755 |
| 0.8-0.9 | 95 | 0.850 | 0.926 |
| 0.9-1.0 | 182 | 0.964 | 0.978 |

Expected calibration error: **0.0394**

### Full backtest 2014–2025 (all games)

| Predicted bin | n | Mean predicted | Observed |
|---|---|---|---|
| 0.0-0.1 | 218 | 0.064 | 0.069 |
| 0.1-0.2 | 474 | 0.154 | 0.112 |
| 0.2-0.3 | 716 | 0.252 | 0.246 |
| 0.3-0.4 | 901 | 0.352 | 0.334 |
| 0.4-0.5 | 983 | 0.451 | 0.424 |
| 0.5-0.6 | 1048 | 0.550 | 0.561 |
| 0.6-0.7 | 1142 | 0.650 | 0.665 |
| 0.7-0.8 | 1176 | 0.750 | 0.779 |
| 0.8-0.9 | 1232 | 0.850 | 0.869 |
| 0.9-1.0 | 1808 | 0.960 | 0.967 |

Expected calibration error: **0.0172**

The same projections priced from a plain normal: full-backtest log loss 0.47870 vs 0.47891 (key-number).

## Against the closing line, side by side (full backtest 2014–2025, FBS vs FBS)

Taking each model's side whenever it disagrees with the close by at least the threshold (descriptive, not a preregistered test):

v2:

| Gap vs close ≥ | n | Model side wins | Win % | One-sided p |
|---|---|---|---|---|
| 1 pt | 6675 | 3419 | 51.2% | 0.0237 |
| 2 pt | 5079 | 2620 | 51.6% | 0.0124 |
| 3 pt | 3701 | 1923 | 52.0% | 0.0090 |

cfb_p4:

| Gap vs close ≥ | n | Model side wins | Win % | One-sided p |
|---|---|---|---|---|
| 1 pt | 6859 | 3366 | 49.1% | 0.9389 |
| 2 pt | 5441 | 2653 | 48.8% | 0.9674 |
| 3 pt | 4274 | 2083 | 48.7% | 0.9523 |

## Did the market move toward the model? (archive openers → closes, 2014–2025)

- **v2**: n 8961, mean +0.465 pts toward the model's side; 4482 toward / 3355 away / 1124 flat
- **cfb_p4**: n 8946, mean +0.310 pts toward the model's side; 4161 toward / 3663 away / 1122 flat

## Fitted coefficients by season priced (walk-forward: each fitted only on earlier seasons)

| Season priced | Home field | 2020 no-crowd | Pass O | QB | Pass D | Rush O | Rush D | Market | Lower-division row | Rest (per 7 days) | Bye |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2012 | 2.95 | 0.00 | 8.6 | 27.3 | 7.6 | 18.1 | 30.5 | 0.700 | -0.90 | 1.09 | -0.20 |
| 2013 | 3.09 | 0.00 | 11.3 | 26.2 | 11.9 | 19.6 | 30.8 | 0.599 | 0.16 | 2.21 | -0.59 |
| 2014 | 3.12 | 0.00 | 12.2 | 29.0 | 11.4 | 21.6 | 31.3 | 0.591 | -0.62 | 3.51 | -1.93 |
| 2015 | 2.94 | 0.00 | 12.8 | 24.9 | 11.4 | 20.7 | 30.5 | 0.587 | -0.23 | 2.84 | -1.18 |
| 2016 | 2.80 | 0.00 | 11.2 | 28.7 | 11.4 | 21.9 | 30.3 | 0.589 | 0.05 | 2.39 | -0.59 |
| 2017 | 2.77 | 0.00 | 11.6 | 29.1 | 11.8 | 21.6 | 31.2 | 0.571 | -0.14 | 1.98 | -0.05 |
| 2018 | 2.75 | 0.00 | 12.7 | 28.0 | 12.1 | 22.3 | 32.6 | 0.546 | -0.54 | 1.93 | -0.10 |
| 2019 | 2.70 | 0.00 | 12.6 | 26.7 | 12.6 | 22.7 | 33.0 | 0.533 | -0.29 | 1.46 | 0.23 |
| 2020 | 2.74 | 0.00 | 14.0 | 25.2 | 13.0 | 22.6 | 31.7 | 0.528 | -0.50 | 1.30 | 0.25 |
| 2021 | 2.75 | -1.81 | 14.0 | 26.1 | 13.3 | 22.2 | 31.7 | 0.526 | -0.57 | 0.04 | 1.48 |
| 2022 | 2.68 | -1.73 | 13.8 | 27.7 | 13.2 | 22.0 | 32.4 | 0.520 | -0.53 | 0.30 | 1.12 |
| 2023 | 2.63 | -1.68 | 12.8 | 28.2 | 12.4 | 21.3 | 31.4 | 0.534 | -0.28 | 0.27 | 1.13 |
| 2024 | 2.60 | -1.63 | 12.8 | 28.2 | 11.9 | 21.0 | 30.5 | 0.542 | -0.34 | 0.04 | 1.41 |
| 2025 | 2.63 | -1.66 | 13.2 | 26.5 | 11.9 | 21.2 | 31.2 | 0.534 | -0.33 | 0.20 | 1.25 |
| 2026 | 2.66 | -1.70 | 13.5 | 26.8 | 12.3 | 20.8 | 31.6 | 0.530 | -0.31 | 0.13 | 1.12 |

Rating terms are points per 1.0 EPA/play of rating difference; the market rating is points per point of prior-close rating; the lower-division row is points when only the away side is outside FBS (negative when only the home side is).

## Configuration

Tuned on 2014–2020 only, by two-pass coordinate descent over the preregistered grid. **110 variants evaluated, 30 accepted**; every one is in `docs/model-loop/cfb/tuning_log.jsonl` with its tune-window MAE.

```json
{
 "rating": {
  "garbage_floor": 0.25,
  "hl_week": null,
  "lam": {
   "pass_off": 50,
   "pass_def": 50,
   "rush_off": 50,
   "rush_def": 150,
   "qb": 150,
   "mu": 100.0,
   "home": 3000.0,
   "lower": 200,
   "group": 50.0
  },
  "carry": {
   "off": 0.6,
   "def": 0.8,
   "qb": 0.6,
   "qb_gap": 0.8,
   "lower": 0.9
  },
  "conf_w": 0.5,
  "talent": {
   "off": 0.06,
   "def": 0.0
  },
  "retprod": 0.0,
  "qb_layer": true,
  "fcs_teams": true,
  "market": {
   "on": true,
   "hl_week": null,
   "lam": 0.25,
   "carry": 1.0,
   "lam_hfa": 20.0,
   "lam_group": 3.0
  },
  "totals_market": {
   "on": true,
   "hl_week": 8.0,
   "lam": 0.5,
   "carry": 0.9,
   "lam_group": 3.0
  }
 },
 "model": {
  "components": {
   "qb": true,
   "market": true,
   "rest": true,
   "division": true,
   "covid": true,
   "pass_split": true,
   "rush": true
  },
  "hl_season": null,
  "ridge_lam": 8,
  "hfa_prior_games": 0,
  "first_train": 2010,
  "min_train_seasons": 2,
  "calibration": "none",
  "total_market": true
 }
}
```

## Current cards (65 games, generated 2026-10-21T03:06:13Z)

**NC State @ Stanford** (week 8): fair line **Stanford +16.0**, win probability 16.8%, fair moneyline +497 / -497, 80% range -37.0 to +5.1 (centred on -15.98). Quarterbacks priced: Davis Warren (board starter: Davis Warren — started the last game; no announcement for this one.) vs CJ Bailey (board starter: CJ Bailey — started the last game; no announcement for this one.).

| Group | Component | Points (home +) | From the prior | From 2026 |
|---|---|---|---|---|
| environment | Home field | +2.66 | — | — |
| base strength | Pass offense (team, excluding QB) | -2.59 | -0.16 | -2.43 |
| base strength | Quarterback | -2.56 | -0.85 | -1.71 |
| base strength | Pass defense | +0.34 | +0.08 | +0.26 |
| base strength | Rush offense | -2.97 | -0.52 | -2.45 |
| base strength | Rush defense | -5.02 | +0.52 | -5.54 |
| base strength | Market rating (prior weeks' closing lines) | -4.59 | -0.26 | -4.32 |
| rest travel | Rest days | -0.13 | — | — |
| rest travel | Off a bye | -1.12 | — | — |
| | **Sum = fair margin** | **-15.98** | | |

Unattributed: 0.0e+00. Market reference: 7.5.

**FLAG: Model disagrees with market by 8.5** (toward the away side). Driving components: Rush defense -5.02; Rush offense -2.97; Pass offense (team, excluding QB) -2.59; Quarterback -2.56.

| Game | v2 fair line | Win prob | Market reference | Gap | Flag |
|---|---|---|---|---|---|
| Middle Tennessee @ Florida International | Florida International -11.0 | 75% | Florida International -10.5 | +0.5 |  |
| Missouri State @ Delaware | Delaware -3.6 | 59% | Delaware -3.0 | +0.6 |  |
| South Alabama @ Marshall | Marshall +5.2 | 37% | Marshall +3.5 | -1.7 |  |
| New Mexico State @ Sam Houston | Sam Houston +2.7 | 43% | Sam Houston +2.5 | -0.2 |  |
| James Madison @ App State | App State +7.7 | 32% | App State +10.5 | +2.8 |  |
| Liberty @ Kennesaw State | Kennesaw State +5.7 | 36% | Kennesaw State +9.5 | +3.8 |  |
| East Carolina @ Memphis | Memphis -11.4 | 76% | Memphis -9.5 | +1.9 |  |
| Duke @ Virginia | Virginia -0.2 | 51% | Virginia -2.5 | -2.3 |  |
| Massachusetts @ UConn | UConn -12.0 | 77% | UConn -16.5 | -4.5 |  |
| Army @ Tulsa | Tulsa -3.0 | 57% | Tulsa -1.5 | +1.5 |  |
| Air Force @ Wyoming | Wyoming +6.2 | 35% | Wyoming +7.5 | +1.3 |  |
| NC State @ Stanford | Stanford +16.0 | 17% | Stanford +7.5 | -8.5 | FLAG |
| Baylor @ Kansas | Kansas -0.8 | 52% | — | — |  |
| BYU @ UCF | UCF +10.9 | 25% | UCF +7.5 | -3.4 |  |
| Colorado @ Oklahoma State | Oklahoma State -3.2 | 58% | — | — |  |
| Houston @ Utah | Utah -7.0 | 67% | Utah -6.5 | +0.5 |  |
| Iowa State @ Arizona | Arizona -10.8 | 74% | Arizona -10.0 | +0.8 |  |
| Kansas State @ Arizona State | Arizona State +3.3 | 42% | — | — |  |
| Texas Tech @ Cincinnati | Cincinnati +10.6 | 26% | Cincinnati +11.5 | +0.9 |  |
| Virginia Tech @ Clemson | Clemson +2.0 | 45% | Clemson +1.5 | -0.5 |  |
| Oregon @ Illinois | Illinois +9.7 | 28% | — | — |  |
| Iowa @ Minnesota | Minnesota +8.5 | 30% | Minnesota +5.5 | -3.0 |  |
| Michigan State @ UCLA | UCLA -15.5 | 82% | UCLA -13.5 | +2.0 |  |
| LSU @ Auburn | Auburn +7.1 | 33% | Auburn +5.5 | -1.6 |  |
| West Virginia @ TCU | TCU -5.5 | 63% | — | — |  |
| California @ SMU | SMU -19.1 | 87% | — | — |  |
| Pittsburgh @ Miami | Miami -22.5 | 91% | Miami -23.5 | -1.0 |  |
| Indiana @ Michigan | Michigan +9.4 | 28% | Michigan +8.5 | -0.9 |  |
| Rutgers @ Northwestern | Northwestern -13.7 | 80% | Northwestern -16.5 | -2.8 |  |
| Rice @ Florida Atlantic | Florida Atlantic -6.3 | 65% | — | — |  |
| Western Michigan @ Toledo | Toledo -5.6 | 63% | — | — |  |
| Akron @ Kent State | Kent State -3.3 | 58% | — | — |  |
| Miami (OH) @ Central Michigan | Central Michigan +1.1 | 47% | — | — |  |
| Texas A&M @ Alabama | Alabama -15.7 | 83% | Alabama -15.5 | +0.2 |  |
| Oklahoma @ Mississippi State | Mississippi State +4.1 | 40% | — | — |  |
| Tennessee @ South Carolina | South Carolina +2.1 | 45% | South Carolina +3.0 | +0.9 |  |
| Boston College @ Georgia Tech | Georgia Tech -2.2 | 55% | — | — |  |
| North Texas @ Navy | Navy +1.0 | 47% | — | — |  |
| Hawai'i @ Northern Illinois | Northern Illinois +2.8 | 43% | — | — |  |
| Sacramento State @ Ball State | Ball State -11.8 | 76% | — | — |  |
| Bowling Green @ Buffalo | Buffalo -3.0 | 57% | — | — |  |
| Eastern Michigan @ Ohio | Ohio -9.1 | 71% | — | — |  |
| UL Monroe @ Troy | Troy -16.8 | 84% | — | — |  |
| San José State @ Nevada | Nevada -2.9 | 57% | — | — |  |
| Louisiana @ Southern Miss | Southern Miss +10.4 | 26% | — | — |  |
| Old Dominion @ Louisiana Tech | Louisiana Tech -13.2 | 79% | — | — |  |
| Boise State @ Washington State | Washington State +14.6 | 19% | — | — |  |
| San Diego State @ Colorado State | Colorado State +1.7 | 46% | — | — |  |
| Georgia State @ Arkansas State | Arkansas State +1.2 | 47% | — | — |  |
| Vanderbilt @ Kentucky | Kentucky -12.3 | 77% | Kentucky -11.5 | +0.8 |  |
| Ole Miss @ Texas | Texas -7.1 | 67% | Texas -3.0 | +4.1 |  |
| Syracuse @ North Carolina | North Carolina -11.2 | 75% | — | — |  |
| USC @ Wisconsin | Wisconsin +2.1 | 45% | Wisconsin +2.5 | +0.4 |  |
| Utah State @ Texas State | Texas State -16.3 | 84% | — | — |  |
| UTSA @ Tulane | Tulane +2.7 | 43% | — | — |  |
| North Dakota State @ New Mexico | New Mexico -3.0 | 57% | New Mexico -4.5 | -1.5 |  |
| Delaware @ Western Kentucky | Western Kentucky -4.4 | 61% | — | — |  |
| Sam Houston @ Missouri State | Missouri State -4.1 | 60% | — | — |  |
| Kennesaw State @ Middle Tennessee | Middle Tennessee +1.0 | 48% | — | — |  |
| Jacksonville State @ New Mexico State | New Mexico State +1.7 | 46% | — | — |  |
| Florida Atlantic @ North Texas | North Texas -11.8 | 76% | — | — |  |
| Troy @ James Madison | James Madison -14.1 | 80% | — | — |  |
| Tulane @ Charlotte | Charlotte +10.4 | 26% | — | — |  |
| Baylor @ UCF | UCF +1.0 | 48% | — | — |  |
| Kent State @ Sacramento State | Sacramento State +7.5 | 32% | — | — |  |

## Inactive, and why

- **in_season_recency**: inactive (tuned off)
- **returning_production**: inactive (tuned off)
- **hfa_shrinkage**: inactive (tuned off)
- **era_weighting**: inactive (tuned off)
- coaching change / tenure (the feed's coaching series starts 2015 and carries no publication date; not built)
- historical QB starter announcements (the backtest prices the QB who took the most dropbacks)
- historical injury / availability
- historical weather
- Pinnacle closes after 2019 (the benchmark is the median across books)
- travel distance / time zones (venue geography not ingested in this round)

## Disclosures

- During development one smoke test of a first, untuned configuration (market prior 3 games of evidence, half-life 4, carry 0.6; unit priors 300/600 plays) was scored on every window including the 2025 holdout (all games: v2 MAE 13.12 vs close 11.90; FBS 12.99 vs 11.82). A diagnostic of that market rating's compression (close regressed on the market rating, by week) was run on 2014-2024, which includes the validation window: the market rating was shrunk ~1.5x. Four market settings and then the full model with the defaults committed here were scored on the TUNE window only (2014-2020: all games MAE 13.21 vs close 12.47; FBS 13.02 vs 12.45), and the defaults and the market grid were set from those. No setting was changed in response to the holdout. The cfb_p4 replay was scored on 2014-2025 to check it reproduces the published numbers.
- no intercept (neutral = 0); offense and defense separate coefficients; QB as its own rating parameter carried with the player through transfers; every FCS / lower-division team in the play-by-play rated, around a fitted division mean; per-slate snapshots (a midweek game is not absorbed before that week's Saturday games); the postseason in weekly slates.
- Talent (247 composite) and returning production come from sportsdataverse-data releases that carry no publication timestamp; for past seasons they are reconstructions from that season's roster, so their contribution is measured by ablation, not assumed point-in-time clean.
- The 2013 play-by-play feed files almost no sacks (53 vs ~3,500 a season), so 2013 pass ratings are rosier; 2013 is a burn-in season for the tune window's priors only.
- Garbage time uses the provider's NAIVE win probability (game state only); its wp_before reads the pregame spread and is not used.
- Tuned values at the edge of the preregistered grid: `rating.market.hl_week` = None, `rating.market.carry` = 1.0, `rating.hl_week` = None, `rating.lam.pass_off` = 50, `rating.lam.pass_def` = 50, `rating.lam.rush_off` = 50, `rating.lam.lower` = 200, `rating.carry.off` = 0.6, `rating.carry.qb` = 0.6, `rating.carry.lower` = 0.9, `rating.conf_w` = 0.5, `rating.talent.off` = 0.06, `rating.talent.def` = 0.0, `rating.retprod` = 0.0, `model.hl_season` = None, `model.hfa_prior_games` = 0, `model.ridge_lam` = 8. A wider grid is a weekly-loop candidate, not a change made here.
- Components removed by the validation bar make the final model's VALIDATION numbers mildly optimistic; the holdout and 2026 numbers are not affected.
- Starters in the backtest are the quarterbacks who took the most dropbacks (known pregame in nearly every case); live cards price the board's starter (announced, or the last game's) and say so.
- The cfb_p4 replay omits its team-game efficiency (matchup) term and the 2026-only regime cut; it reproduces the published 2022–2025 FBS MAE (12.72 vs 12.77 published for v1.0.0 with efficiency).
- ATS-vs-close tables are descriptive; no betting claim follows from them.
