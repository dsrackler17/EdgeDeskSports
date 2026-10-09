# Model performance monitoring (generated)

Generated 2026-10-08T20:12:46.488Z by `node tools/integrity/performance.js`. **Live-forward and backtest evidence are reported separately and never blended.** a theoretical EV is not performance; no figure here is evidence of a profitable edge unless its interval excludes break-even on a meaningful sample.

## Live-forward (football/cfb_terminal/record.json)

- Rule: the last pregame number EdgeDesk froze before kickoff, graded against the close and the final; versions never merged.
- Look-ahead guard: 293 of 293 graded games used; 0 excluded (frozen at or after kickoff).
- Model versions: edgedesk_cfb_p4_v1.0.0.

### Overall

| Group | n | Model MAE | Close MAE | ATS [95% CI] | CLV pts | Win-prob Brier | Sample |
|---|---|---|---|---|---|---|---|
| all | 293 | 13 | 11.2 | 47.6% [41.9–53.3] | -0.08 (n 133) | 0.2111 | DEVELOPING (200–499) |

### By reliability band

| Group | n | Model MAE | Close MAE | ATS [95% CI] | CLV pts | Win-prob Brier | Sample |
|---|---|---|---|---|---|---|---|
| 60–79 | 18 | 16.75 | 15.72 | 33.3% [16.3–56.3] | 0 (n 18) | 0.3074 | TOO EARLY (<50) |
| 80+ | 98 | 12.5 | 11.47 | 53.1% [43.2–62.8] | -0.02 (n 98) | 0.2692 | EARLY SIGNAL (50–199) |
| <60 (limited) | 16 | 14.28 | 11.56 | 50% [28–72] | -0.56 (n 16) | 0.005 | TOO EARLY (<50) |
| unmeasured | 161 | 12.76 | 10.5 | 45.6% [38.1–53.4] | 0 (n 1) | 0.1569 | EARLY SIGNAL (50–199) |

### By model-market gap at the close

| Group | n | Model MAE | Close MAE | ATS [95% CI] | CLV pts | Win-prob Brier | Sample |
|---|---|---|---|---|---|---|---|
| 2–7 pts | 131 | 12.12 | 11.6 | 50% [41.5–58.5] | -0.11 (n 64) | 0.2047 | EARLY SIGNAL (50–199) |
| 7+ pts | 89 | 15.43 | 10.35 | 42.7% [32.9–53.1] | -1.07 (n 29) | 0.2028 | EARLY SIGNAL (50–199) |
| <2 pts | 73 | 11.61 | 11.54 | 49.3% [38–60.7] | 0.69 (n 40) | 0.2319 | EARLY SIGNAL (50–199) |

### By conference

| Group | n | Model MAE | Close MAE | ATS [95% CI] | CLV pts | Win-prob Brier | Sample |
|---|---|---|---|---|---|---|---|
| ACC | 16 | 10.63 | 12.66 | 75% [50.5–89.8] | 0.6 (n 10) | 0.2554 | TOO EARLY (<50) |
| American | 8 | 12.83 | 10.44 | 28.6% [8.2–64.1] | 1 (n 6) | 0.4919 | TOO EARLY (<50) |
| Big 12 | 14 | 10.83 | 9.32 | 53.8% [29.1–76.8] | -0.32 (n 11) | 0.2728 | TOO EARLY (<50) |
| Big Ten | 18 | 14.19 | 12.92 | 50% [29–71] | 0.03 (n 16) | 0.3292 | TOO EARLY (<50) |
| Conference USA | 5 | 9.72 | 9.1 | 40% [11.8–76.9] | 0.9 (n 5) | 0.2226 | TOO EARLY (<50) |
| MAC | 8 | 15.77 | 13.94 | 50% [21.5–78.5] | -0.56 (n 8) | 0.4646 | TOO EARLY (<50) |
| Mountain West | 6 | 14.25 | 12.17 | 33.3% [9.7–70] | 0.1 (n 5) | 0.1942 | TOO EARLY (<50) |
| Pac-12 | 4 | 13.86 | 14.5 | 75% [30.1–95.4] | 0.13 (n 4) | 0.201 | TOO EARLY (<50) |
| SEC | 19 | 14.37 | 12.68 | 42.1% [23.1–63.7] | 0.04 (n 13) | 0.2535 | TOO EARLY (<50) |
| Sun Belt | 7 | 10.23 | 12.14 | 57.1% [25–84.2] | -1 (n 7) | 0.1521 | TOO EARLY (<50) |
| non-conference | 188 | 13.13 | 10.74 | 45.5% [38.5–52.6] | -0.29 (n 48) | 0.1416 | EARLY SIGNAL (50–199) |

- Totals: the live record freezes the spread only; no pregame total is frozen and graded yet, so total forecast error is not measured (an open item, not a zero).

## Backtest (football/validation/pricing_cfb.json)

- time-separated walk-forward validation as shipped; quoted, never re-fitted here. Frame: {"engine":"football/cfb_p4/engine.js (shipped) replayed cold by football/cfb_p4/research/backtest_engine.js","source":"football/cfb_p4/research/report/BACKTEST.md and error_slices.json, copied, not re-run here","eval_window":"out-of-sample error dashboard, eval window 2015-2025; calibrated uses each year’s own walk-forward fit (global)","archive":"sportsdataverse/cfbfastR-data betting/csv/cfb_line_odds.csv.gz (consensus median across books, duplicates dropped)"}.
- Pooled (n 7845): model MAE 13.057 vs close MAE 12.291.

| Disagreement | n | Raw MAE | Market MAE | ATS (raw, 1+ pt) |
|---|---|---|---|---|
| <3 | 3603 | 12.374 | 12.264 | 48.9% (n 2282) |
| 3–7 | 2943 | 12.972 | 12.269 | 48.75% (n 2888) |
| 7–14 | 1200 | 14.693 | 12.363 | 48.08% (n 1169) |
| ≥14 | 99 | 20.588 | 13.109 | 42.42% (n 99) |

- Tier: **RESEARCH**: no disagreement threshold cleared break-even against the close in the shipped backtest (2022-2025); the biggest disagreements are the worst.
- Reading: out of sample the raw model’s error is larger than the closing line’s, and it grows with the size of the model-market disagreement; no disagreement threshold cleared break-even against the close.

## Calibration monitor

- `cfb|spread|close`: PROMOTED / SHADOW, temperature {"method":"temperature","T":1000000}.
- Out of sample: {"n":2339,"log_loss":0.693147,"brier":0.25,"slope":-22.316,"citl":0.018,"identity_log_loss":0.731636,"identity_brier":0.267214,"identity_slope":-0.1691,"identity_citl":-0.1199}.
- Reading: degenerate: the temperature maps every cover probability to 50% — it learned that the raw cover probabilities carry no information out of sample.

