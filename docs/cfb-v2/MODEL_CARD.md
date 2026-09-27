# Model card — EdgeDesk CFB V2 (`edgedesk_cfb_v2.0.0`, features `cfb_v2_fv1`)

Status on 2026-09-27: **SHADOW**. V2 passed every pre-registered accuracy gate on the
2024–2025 holdout and is **eligible** for promotion; V1 (`edgedesk_cfb_p4_v1.0.0`)
remains the priced champion until a person switches the flag. **BET status is
disabled**: no betting threshold survived out-of-sample testing.

Numbers below are from `docs/cfb-v2/BACKTEST.md` (generated). Where this card and the
generated report differ, the report wins.

## 1. What it predicts

| target | definition | layer |
|---|---|---|
| `margin` | home points − away points (final, incl. OT). **+ = home wins** | target |
| `home_win_prob` | P(margin > 0); college football has no ties | derived |
| `fair_total` | home + away points (drive model); published, not gated | derived |
| intervals | 50 / 80 / 95% ranges for the margin | derived |

Two outputs are kept apart everywhere (engine, JSON, database):

* **pure_model_projection** — football information only. Never sees a sportsbook number.
* **market_decision_projection** — reads the frozen pure projection and the market; never writes back.

Sign convention: internal margins are home-positive; book lines are home-negative
(`-7` = home laying 7). Conversion happens once at ingestion
(`common.book_home_line_to_margin`, `engine.conv.bookToMargin`, and a generated
column in `cfb_market_snapshots`). Tests pin it at every layer.

## 2. Data

| source | use | range |
|---|---|---|
| sportsdataverse `espn_cfb_pbp` release | every play (one EP model for all seasons) | 2009–2026 |
| `cfb_schedules` | kickoff, neutral site, divisions, conferences, scores | 2009–2026 |
| `cfb_returning_production`, `cfb_team_talent` | preseason prior inputs | 2009–2026 |
| `cfb_matchup_line` | coaching continuity (2015+), CFBD lines for 2026, CFBD Elo (benchmark only) | 2015–2026 |
| cfbfastR `cfb_line_odds` (via V1's `build_market.py`) | multi-book opening + closing lines | 2006–2025 |
| cfbfastR `team_info` | venue geography (travel, time zone, altitude) | 2009–2025 |

Excluded or altered, with reasons:

* **2013 pass/rush splits and sack/havoc rates are MISSING** — the ESPN feed tags 32 sacks that season (~3,000 real).
* Provider stuffed-run / line-yard / opportunity / havoc flags are **not used** (they drift across seasons); V2 recomputes them from raw rushing yardage and uses front havoc = sacks + run TFLs.
* Provider win-probability columns are **forbidden at load time** (the WP model reads the pregame spread).
* Market rows: 31 implausible or sign-flipped openers/closes **dropped** at ingestion (never repaired). No openers exist for 2020 or before 2012.
* Postponed/cancelled games (`NOT_PLAYED`) are never absorbed or scored.
* **FBS-vs-FCS games are projected but NOT PRICED** (see §8).

The provider's EP model was fitted on 2004–2025, so historical EPA values embed a
model that "saw" later seasons. It is a function of game state only (down, distance,
field position, time, score) and carries no team or outcome information about the
game being predicted; it is a definition-level look-ahead, disclosed, not removable
without refitting EP.

## 3. Point-in-time discipline

Every game is predicted from a **frozen snapshot at Tuesday 12:00 UTC** of its week,
using only games that kicked off before that instant (a Thursday result cannot
inform a Saturday prediction). Training rows (`cfb_model_training_snapshots`,
PK `(game_id, prediction_ts, feature_version)`) contain no market column; market data
lives in `cfb_market_training_snapshots`. `v2.contract.assert_pure` is called inside
every model's `fit()` and refuses market, evaluation, target and unknown columns.
`v2/tests_leakage.py` injects closing lines, final scores, future games and
post-kickoff quarterback knowledge and fails if any of them reaches training.

## 4. Features (what survived)

**Opponent adjustment first.** For each of 31 metrics, offence and defence ratings are
solved jointly at every freeze as one Gaussian posterior
(`y = mu + o_off + d_def + h·H + e`, `Var(e) = s²_play/n + s²_game`), with a preseason
prior per team whose variance is estimated from history and scaled by a per-metric
factor tuned by next-game prediction on dev seasons. No SOS multipliers, no iteration counts.

Metrics: EPA/play, pass EPA/dropback, rush EPA/rush, success (overall, pass, rush,
early-down, passing-down, 3rd-down), explosive-play rates (overall/pass/rush), line
yards, stuff rate, opportunity rate, front havoc, sack rate, turnover rate, points
per drive, scoring-opportunity rate, points per opportunity, drive EPA, starting field
position, pass rate (style), plays and drives per game (pace), net special-teams EPA,
field-goal value.

**Time horizons**, kept separate: preseason prior, season-to-date posterior, recent
posterior (half-life 8 weeks, tuned — at that setting recent form beats season-long
next-game error by 0.2%), last-4 and last-2 residual form (shrunk).

**Priors** (a distribution per team): ridge on last season's and the prior season's
data-only ratings, returning production, 247 talent, head-coach change and
coordinator change (2015+), each missing value imputed with an explicit flag; FCS teams
share one pooled prior.

**Matchups** from standardized ratings (never ranks): pass/rush edges, play-mix-weighted
edge, trench, havoc, sack, explosive, early-down, passing-down, finishing,
field-position and special-teams edges, strength×weakness products, expected plays and
possessions.

**QB model**: opponent-adjusted EPA/dropback per passer, career-shrunk
(k = 150 dropbacks toward a replacement mean of −0.057), expected starter = most recent
starter, plus team-QB delta, backup drop-off, experience, changed/unsettled flags.

Feature families kept by the dev-only grouped ablation (forward keep + backward
elimination, `docs/cfb-v2/BACKTEST.md`):

| model | families kept | dev MAE |
|---|---|---|
| C ridge | base (priors, home field, Elo), adjusted efficiency, trench/havoc, matchup, form, context | 12.806 |
| D GBM | base, adjusted efficiency, matchup, form, special teams, QB | 12.895 |

## 5. Algorithms and ensemble

| submodel | what it is | stack weight (2026) |
|---|---|---|
| A adjusted-efficiency | net adjusted EPA/play × expected plays + ST + home field | 0.00 |
| B dynamic Elo | results-only Elo, MOV multiplier, K 50 / HFA 70 / carry 1.0 (tuned) | 0.02 |
| C ridge | standardized ridge (α 30) over the kept families | 0.57 |
| D LightGBM | Huber loss, 7 leaves, 250 trees, seeded, single-threaded | 0.37 |
| E drive | expected points/drive × expected drives, + ST, + home field | 0.04 |

Each submodel for season S is fit on FBS-vs-FBS games of seasons < S. Stacking weights
are non-negative, sum to one, and are fit on those submodels' **out-of-fold**
predictions of earlier seasons only. Every component prediction is stored
(`cfb_model_component_predictions`, `components` in each snapshot row), and their
standard deviation (`ens_sd`) is a published disagreement measure that feeds the error
model and the cover calibration.

## 6. Uncertainty and calibration

* **Error model**: `E[r²] = exp(Xb)` (Gamma GLM, log link) on out-of-fold residuals of
  earlier seasons, with early season, games played, rating posterior width, model
  disagreement, lopsidedness, expected total, FCS, QB unknown/unsettled, team
  volatility and turnover dependence.
* **Shape**: standardized Student-t (df fit on past residuals) for probabilities;
  **split-conformal** |z| quantiles for 50/80/95% intervals.
* **Win probability**: raw, Platt and isotonic were compared on dev log loss; **raw**
  won (0.5298 vs Platt 0.5301 vs isotonic 0.5351) and ships.
* **Cover probability**: conditional Platt on the model's cover logit with slope
  terms for disagreement, rating uncertainty, early season and QB uncertainty (the
  dynamic no-bet zone), fit walk-forward. On the holdout it is essentially a coin
  flip (Brier 0.2501 vs 0.2500 for 0.5): the market is efficient and V2 knows it.
* **Reliability** (`football_prediction_confidence`, 0–100) is the error model's
  sigma mapped onto its historical range, with caps (FCS 50, no game yet 70, QB
  unsettled 75, QB unknown 65). It never reads the market, the gap or EV.
  `betting_edge_strength` is separate (EV-based).

## 7. Performance (FBS-vs-FBS, common game sets, 95% bootstrap CIs)

| window | n | V2 MAE | V1 | opener | close | V2 Brier | V1 Brier | 50/80/95% coverage |
|---|---|---|---|---|---|---|---|---|
| dev 2016–23 | 4,970 | **12.69** | 13.07 | 12.44 | 12.31 | 0.1784 | 0.1825 | 0.50 / 0.81 / 0.96 |
| holdout 2024–25 | 1,532 | **12.39** | 12.65 | 12.09 | 12.01 | 0.1830 | 0.1857 | 0.51 / 0.82 / 0.95 |
| live 2026 (replay, wk 0–4) | 181 | **12.03** | 12.23 | 11.17 | 10.92 | 0.142 | 0.139 | 0.53 / 0.85 / 0.95 |

* V2 − V1 on the holdout: **−0.26 pts [−0.46, −0.07]**; better than V1 in both
  holdout seasons, 7 of 8 dev seasons, and every dev and holdout week bucket. In the
  2026 replay V1 is ahead in weeks 3–5 (10.14 vs 10.35 on 83 games) and on Brier.
* V2 − opener on the holdout: **+0.29 [+0.13, +0.46]**; V2 − close **+0.38**.
  **V2 does not beat the market.** The gap is largest in weeks 0–2 and nearly closes
  after week 10 (holdout: 12.37 vs opener 12.30).
* Simple Elo 13.17, CFBD Elo 13.03, naive home field 15.94 (holdout).
* The **market-adjusted challenger** (V2 + opener, weights learned walk-forward; mean
  model weight 0.26) scores 12.07 on the holdout — the same as the opener. It is
  published as a separate, labelled projection, never as the EdgeDesk fair line.
* The close moved toward V2 on **53.6%** of holdout games where it moved (58.3% dev),
  mean CLV **+0.29 pts [0.19, 0.40]** — V2 carries information the market later
  prices, but not enough to clear the vig: every-game ATS vs the opener 50.5%, ROI
  −3.5% at −110 (holdout), 49.9% at the close.
* Edge buckets: no bucket is reliably profitable on both dev and holdout (tables in the report).
* The BET rule chosen on dev (gap ≥ 3, reliability ≥ 65, review above 7 pts) went
  56.2% on 469 dev plays but **49.5% on 184 holdout plays (ROI −5.5%)**; the reality
  check (500 coin-flip worlds) had already rated it p = 0.196. BET is disabled.

## 8. Known weaknesses, biases, failure cases

1. **Worse than the market** (≈ 0.3 pts of MAE vs the opener on the holdout).
2. **Early season** (weeks 0–2): gap to the opener 0.6–0.9 pts — the market knows
   transfers, QB battles and depth charts that no reachable feed carries.
3. **FBS-vs-FCS**: bias −2.9 (dev), −6.5 (holdout), −9.0 (2026) pts and 80% coverage
   0.68–0.81. **Not priced**; kept in snapshots for monitoring.
4. **Postseason** (dev, 42 FBS games): 16.6 MAE — opt-outs and bowl motivation are invisible.
5. **Non-QB injuries, weather and pregame QB status** have no historical point-in-time
   data. Status and forecasts are live overlays with DECLARED mappings; injuries and
   weather widen the distribution only. None of them is validated.
6. **Home bias**: holdout bias −0.46 (V2 slightly under-rates home teams); 2026 −0.97.
7. **2013** lacks sacks; **2020** has no openers and a COVID schedule (reported, not dropped).
8. **Reliability does not rank-order above 60.** It isolates the worst games
   (< 40: holdout MAE 14.0 vs 12.0–12.9 elsewhere) but the 90+ tier (MAE 12.59, 80%
   coverage 0.77) is no better than 75–90 (MAE 12.01, coverage 0.83). The score is
   an inverted sigma, and the lowest-sigma games are close matchups whose errors are
   not smaller. **Treat reliability as "not bad" vs "bad", not as a fine grade.** Fix
   for the next version (dev seasons only): map the score to each bucket's
   walk-forward MAE and coverage instead of the sigma range.
9. Historical CLV/ROI assume a Tuesday bet at the opener at −110; the archive has no
   spread prices and no intra-week lines, so the at-close grading is the lower bound.

## 9. Refresh and retraining policy

* **Daily / Tuesday** (`.github/workflows/cfb-v2-shadow.yml`, `run_all.sh live`): current-season
  features rebuilt with the backtest's own code; predictions from frozen artifacts;
  write-once snapshots per Tuesday freeze; `current.json` for the next 10 days.
* **Weekly learning** (`python3 -m v2.learn_week`): errors, major-miss classification,
  `football/cfb_v2/monitoring.json`. Monitoring only; no parameter changes in season.
* **Retrain**: once per offseason (`run_all.sh retrain`, manual dispatch) → a new
  `model_version`, a new backtest, the same gates. Never after a single weekend.

## 10. Versioning

`artifacts/edgedesk_cfb_v2.0.0/` holds the exact fitted models (JSON coefficients,
LightGBM text model, stacking weights, error model, calibration, market rule) and
`meta.json` (seed 20260927, windows, tuning, promotion record). Every snapshot row
carries `model_version`, `feature_version`, `prediction_ts`, `feature_ts` and a
content hash.
