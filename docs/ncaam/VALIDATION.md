# What the validation shows

Every number below comes from the committed records in
`basketball/ncaam_research/published/` (`validation_team.json`,
`validation_player.json`, `validation_interactions.json`, `audit.json`).

## Protocol

- **Chronological walk-forward.** A game is predicted 30 minutes before tip from
  games finished by then. A result is assumed available 4 hours after tip,
  because the pack has no first-publication times. This is a retrospective
  backtest, not a certified point-in-time one.
- **Windows.** 2024 is burn-in (priors and calibration only). 2025 is
  selection. 2026 is the holdout, scored once with the frozen choice
  (`selection_frozen.json`, hash `27581bf5f52258f4`).
- **Inside folds.** The possession FTA coefficient was fitted on 2024 for the
  2025 selection and on 2024-25 for the 2026 holdout. Calibration is
  refitted weekly on earlier out-of-sample rows. Style reliabilities were
  fitted on 2024-25.
- **Selection.** Coordinate descent over ~40 configurations, scored on 2025
  margin CRPS. A value is taken only if it improves CRPS by ≥ 0.002.
- **Uncertainty.** Paired differences on the same games, with bootstrap 95%
  intervals clustered by game day.
- **Benchmarks.**
  - Included: home advantage only; the pack's unadjusted prior-10-game
    efficiencies; the incumbent EdgeDesk points model (scores only, its own
    tuned parameters, the same calibrator); its tuned Elo.
  - Not included: no lawfully available point-in-time KenPom, Torvik or
    EvanMiya archive, and no bookmaker archive.

## Team model (D1 vs D1)

| 2025-26 holdout (n = 5,752) | Log loss | Brier | Margin MAE | Margin CRPS | Total CRPS | 80% margin coverage |
|---|---|---|---|---|---|---|
| **Adjusted efficiency (frozen)** | **0.5290** | **0.1802** | **9.24** | **6.547** | 9.745 | 81.4% |
| Incumbent points model | 0.5376 | 0.1827 | 9.40 | 6.694 | 9.734 | 81.0% |
| Incumbent Elo | 0.5585 | 0.1895 | — | — | — | — |
| Unadjusted prior-10 efficiency | 0.5940 | — | 10.50 | 7.551 | 10.009 | 81.3% |
| Home advantage only | 0.6549 | — | 11.64 | 8.374 | 10.974 | 80.8% |

**Against the incumbent (frozen minus incumbent, 95% CI):**

| | Margin CRPS | Log loss | Total CRPS |
|---|---|---|---|
| 2026 | −0.147 [−0.213, −0.088] | −0.0086 [−0.0130, −0.0036] | +0.011 [−0.017, +0.039] (tie) |
| 2025 | −0.136 [−0.184, −0.094] | −0.0102 [−0.0143, −0.0068] | −0.030 [−0.056, −0.002] |

**Ablations on 2026 (frozen minus variant):**

| Component | Effect | Status |
|---|---|---|
| Preseason prior (vs league average) | −0.347 CRPS [−0.626, −0.181] | essential |
| Parameter-variance width (vs constant width) | −0.0017 [−0.0038, −0.0002] | small but real |
| Transfer/roster prior | +0.002 [−0.015, +0.019] | **experimental**: won 2025 (−0.011), not confirmed 2026 |
| Multiplicative (log) form | −0.005 [−0.016, +0.005] | no difference |
| Recency weighting | — | not chosen: no decay predicted best on 2025 |
| Blowout damping | — | not chosen |
| Rest days | 2025: +0.115 ± 0.089 pts per day; 2026: −0.012 ± 0.090 | no measurable effect, not in the model |

**Where it is weaker:**

- **November.** 80% intervals cover 77%, so early-season uncertainty is
  understated. Margin MAE is 10.2 in November vs 8.8–8.9 from January on.
- **Teams with 0–4 games played.** Coverage is 76%.
- **Calibration.** Holdout reliability bands are within a few points of the
  diagonal. The largest gap: 0.40–0.50 forecast vs 0.52 observed.
- **Non-D1 regime** (scored separately, 547 games). Log loss 0.065, margin
  MAE 14.6.

## Player layer (inside 2025-26)

Possession data exists only for 2026. The windows:

- **Tuning:** fit on games before 15 Jan, score 15 Jan – 15 Feb.
- **Holdout:** fit on games before 15 Feb, score the rest (178,717
  possessions).

Each possession is predicted from the ten players actually on the floor.

| Held-out squared error per possession (lower is better) | Difference (95% CI) |
|---|---|
| Pure RAPM (prior zero) − team ratings | +2.89 [−1.23, +6.94]: **no better than team ratings** |
| RAPM + box-score prior − team ratings | −3.08 [−6.82, +0.58] |
| **RAPM + box + prior-season prior − team ratings** | **−3.68 [−7.30, −0.09]** (chosen, λ = 2000) |
| Box prior − pure RAPM | −5.98 [−7.92, −3.96] |
| Prior-season prior − box only | −0.60 [−1.08, −0.12] |

Per-possession noise is about 13,500 on this scale, so real signal appears as
small differences. The intervals decide what counts.

**Game level, absences known after the fact (oracle participation):**

- Pricing absent rotation players' minutes with impact estimates **did not
  improve** game predictions. All 1,326 games after 15 Feb: +0.016 CRPS
  [−0.026, +0.057]. The 748 games with an absent rotation player: +0.004
  [−0.048, +0.060].
- Subtracting the absent players' points per game is far worse: +3.53
  [+3.12, +3.92].
- Redistributing minutes predicts teammates' actual minutes better than not
  redistributing (MAE 4.80 vs 5.02). Positional similarity adds almost
  nothing (4.80 vs 4.80).

**Stability:**

- Split-half (odd vs even games) correlation of net impact is 0.56 (2,017
  players with 400+ possessions in each half). For comparison, the
  publisher's full-season RAPM correlates 0.42 from 2025 to 2026.
- Refits vs the primary:
  - exact-reconciled games only: correlation 0.970, top-50 overlap 40;
  - garbage time removed: 0.988, overlap 43;
  - half the penalty: 0.979, overlap 39;
  - double the penalty: 0.980, overlap 44.
- The primary correlates 0.945 with the publisher's 2026 RAPM, which is
  descriptive only: both use the same possessions.

**Minutes and production forecasts** (chosen on 2025, scored on 2026):

- Minutes when playing, MAE: EWMA with a 2-game half-life 4.91, last 5 games
  5.01, season mean 5.27, last game 5.82.
- Points given minutes, MAE: shrunk per-40 rate 3.27 vs raw 3.32. Rebounds
  1.46 vs 1.50. Assists 0.94 vs 0.95.

## Lineups and matchup interactions

- **Lineup persistence.** A lineup's result beyond its players' impacts did
  not repeat from the first half of the season to the second: r = −0.09 over
  459 lineups. The between-lineup variance is estimated at zero, so pooled
  lineup ratings equal their players' sum.
- **Role composition.** "No rebounder" is −1.37 ± 0.58 per 100 (z = 2.36).
  This is not significant after a Bonferroni correction for four tests, and
  it is in-sample only. The other roles are null.
- **Style interactions.** These pair an offense's and a defense's 3PA share,
  ORB%, TOV%, FTA rate and rim share. None was significant on 2025, and
  adding them did not improve 2026 (+0.013 [−0.115, +0.142]). Matchup pages
  show them as hypotheses and add no points.

## Components and status

| Component | Status |
|---|---|
| Team ratings, tempo, score distributions, win probability | Validated against outcomes; beats the incumbent |
| Preseason prior | Validated (large effect) |
| Transfer prior | Experimental |
| Player impact (RAPM + priors) | Modest validated signal at the possession level |
| Pure on-court RAPM / raw on/off | Descriptive only |
| Absence and minutes scenarios | Experimental, conditional: no game-level gain shown |
| Lineup ratings beyond players | Not supported, pooled to players |
| Style interactions | Not supported, shown as hypotheses |
| Market comparison | Unavailable: no odds source; never market-tested |
