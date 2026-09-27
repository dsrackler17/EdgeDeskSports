# Model card — EdgeDesk CFB V2 (`edgedesk_cfb_v2.1.0`, features `cfb_v2_fv2`)

Status on 2026-09-27: **SHADOW**. V1 (`edgedesk_cfb_p4_v1.0.0`) remains the priced
champion. V2.1.0 passes every pre-registered accuracy gate against V1 on the
2024–2025 holdout and is **eligible** for promotion; promotion is a person's decision
after frozen 2026 shadow weeks confirm it. **BET is disabled**: no betting threshold
survived the reality check or the holdout.

`edgedesk_cfb_v2.1.0` is the **hardened** successor of the frozen baseline
`cfb_v2_candidate_001` (= `edgedesk_cfb_v2.0.0`, kept byte-for-byte in
`football/cfb_v2/candidates/cfb_v2_candidate_001/`). It was produced by the adversarial
red team (`docs/cfb-v2/REDTEAM.md`) applying rules written down before any result was
seen (`docs/cfb-v2/HARDENING_PREREG.md`). No feature was added.

Numbers come from generated reports: `BACKTEST.md` (v2.1.0 walk-forward and gates),
`CHAMPION_CHALLENGER.md` (V1 vs candidate 001 vs v2.1.0 on identical games) and
`REDTEAM.md` (the audit). Where this card and a generated report differ, the report wins.

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
column in `cfb_market_snapshots`). `v2/tests_signs.py` grades nine explicit scenarios
(home and road favourite, the model taking the dog, a favourite flip, pick'em win and
push, a half-point hook, a whole-number push) against a longhand truth at every
layer, and `football/cfb_v2/tests.js` repeats them in the production engine.

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

* **2013 pass/rush splits and sack/havoc rates are MISSING**: the ESPN feed tags 32 sacks that season (~3,000 real).
* Provider stuffed-run / line-yard / opportunity / havoc flags are **not used** (they drift across seasons); V2 recomputes them from raw rushing yardage.
* Provider win-probability columns are **forbidden at load time** (the WP model reads the pregame spread).
* **Market QA is point-in-time (v2.1.0).** Only openers with |line| > 60 are dropped at ingestion. An opener that disagrees in sign with the close or jumps far from it is kept and flagged (`eval_open_close_flip`, `eval_open_close_jump`) for evaluation only, because the close is not known when the opener is used. In production, a gap over 21 points where V2 and the line nearly agree in size routes the game to REVIEW (orientation guard in `engine.decide`).
* Postponed/cancelled games (`NOT_PLAYED`) are never absorbed or scored.
* **FBS-vs-FCS games are projected but NOT PRICED** (see §8).

The provider's EP model was fitted on 2004–2025, so historical EPA values embed a
model that "saw" later seasons. It is a function of game state only and carries no
team or outcome information about the game being predicted; it is a definition-level
look-ahead, disclosed, not removable without refitting EP.

## 3. Point-in-time discipline

Every game is predicted from a **frozen snapshot at Tuesday 12:00 UTC** of its week,
using only games that kicked off before that instant. Training rows contain no market
column. `v2.contract.assert_pure` is called inside every model's `fit()` and accepts
only an **exact allowlist** of model columns (named columns plus patterns generated
from the metric registry); anything else is refused.

The red team added two end-to-end checks on top of the injection tests
(`v2/tests_leakage.py`, 27 tests, including final score, closing spread, future
opponent rating, future season average, future injury status, postgame EPA and
postseason ranking injected into every model):

* **Future poisoning** (`v2/tests_poison.py`): a season is rebuilt with every
  post-cutoff input randomised; every pre-cutoff feature must be bit-identical.
  It found four leaks, all fixed in v2.1.0: a volatility fill from the season median,
  batch-level fills, close-based market QA, and a prefix-based layer contract.
* **Row independence**: a row's features do not change when other rows are removed.

The live overlays refuse any report stamped at or after kickoff.

## 4. Features

Opponent adjustment, time horizons, priors, matchups and the QB model are unchanged
from candidate 001 (see `REDTEAM.md` §1 and the feature dictionary). For each of 31
metrics, offence and defence ratings are solved jointly at every freeze as one
Gaussian posterior with a per-team preseason prior; recent form uses an 8-week
half-life; priors come from last season's data-only ratings, returning production,
247 talent and coaching continuity.

**Removed in v2.1.0** (pre-registered rule R4, development seasons only):
`edge_havoc`, `edge_sack_rate`, `x_sack_h`, `x_sack_a` (grouped ablation: removing
the havoc/sack group improved development MAE) and `drive_margin_raw` (its component
was dropped). The joint development MAE of the simplified model is 12.7991 against
candidate 001's 12.8024. The list lives in `config.DROPPED_FEATURES` and applies to
production paths only; the red team's reconstruction of candidate 001 is explicit.

## 5. Algorithms and ensemble

| submodel | what it is | weight |
|---|---|---|
| C ridge | standardized ridge (α 30) over base, adjusted efficiency, trench, matchup, form, context | 0.5 |
| D LightGBM | Huber loss, 7 leaves, 250 trees, seeded, single-threaded; base, adjusted efficiency, matchup, form, special teams, QB | 0.5 |

v2.1.0 is **C + D, equal weights** (rules R2 and R3). The three other components of
candidate 001 (A adjusted efficiency, B dynamic Elo, E drive model) each changed
development MAE by at most 0.005 points when removed, and a learned stack was no better
than the mean. C and D residuals correlate at about 0.99: the ensemble is effectively
one model fitted two ways, and their disagreement (`ens_sd`) is published.

Each submodel for season S is fit on FBS-vs-FBS games of seasons < S. The independent
re-implementation (`v2/rt_walkforward.py`) reproduces candidate 001's frozen
predictions to the precision they are stored at (`report/redteam/phase04_reproduction.json`).

## 6. Uncertainty and calibration

* **Error model**: `E[r²] = exp(Xb)` (Gamma GLM, log link) on out-of-fold residuals of
  earlier seasons. Missing inputs are filled with values learned on the training rows
  (`sigma.fill`), never with statistics of the rows being predicted.
* **Shape**: standardized Student-t for probabilities; split-conformal |z| quantiles for
  intervals. Holdout coverage 0.508 / 0.814 / 0.951 at 50 / 80 / 95%.
* **Win probability**: raw, Platt, isotonic and beta calibration were compared on
  development log loss; **raw** ships (holdout ECE 0.020).
* **Cover probability**: a plain Platt calibration of the model's cover probability
  (rule R6). **It has no skill**: holdout log loss equals a coin flip's. It is published
  for transparency and does not gate anything.
* **Reliability** (0–100) is the error model's sigma mapped onto its historical range,
  with caps. It never reads the market. Treat it as "not bad" vs "bad", not as a fine grade.

**Live overlays** (engine only; historical point-in-time data does not exist):

* **QB status**: a level model measured on development seasons. An unexpected starter
  change cost 1.16 points [−2.01, −0.22] relative to same-starter games, applied
  relative to the 85.7% baseline same-starter rate that the training data already
  contains (so no report means no shift), plus the measured extra variance of
  backup-QB games. Candidate 001's 7.74 points per EPA/dropback rating-gap coefficient
  was not supported and is gone.
* **Injuries / availability**: never move the mean. They widen the interval and cap
  reliability, with diminishing marginal effects within a position group
  (`cap·(1 − e^(−raw/cap))`) and a replacement-quality input. Declared, not validated.
* **Weather**: shown; narrows or widens the weather uncertainty term; moves no points.

## 7. Performance (FBS-vs-FBS, common game sets, 95% bootstrap CIs)

From `BACKTEST.md`:

| window | n | V2.1.0 MAE | V1 | opener | close | V2 Brier | V1 Brier | 50/80/95% coverage |
|---|---|---|---|---|---|---|---|---|
| dev 2016–23 | 4,984 | **12.685** | 13.062 | 12.458 | 12.308 | 0.1782 | 0.1825 | 0.50 / 0.81 / 0.96 |
| holdout 2024–25 | 1,534 | **12.376** | 12.652 | 12.097 | 12.013 | 0.1829 | 0.1857 | 0.51 / 0.81 / 0.95 |
| live 2026 (replay, to date) | 208 | **11.607** | — | 10.844 | 10.649 | 0.1419 | — | 0.54 / 0.85 / 0.95 |

* V2.1.0 − V1 on the holdout: **−0.276 [−0.467, −0.087]** (gate G1), better in both
  holdout seasons and 7 of 8 development seasons. `CHAMPION_CHALLENGER.md` gives
  −0.280 [−0.477, −0.093] on its own common set, and V2.1.0 − candidate 001 = −0.012
  (rule R10: equal accuracy with fewer parts).
* **V2 does not beat the market**: V2 − opener on the holdout +0.263 [0.103, 0.426];
  V2 − close +0.371. On 2026 to date V2 trails the opener by 0.76.
* The close moves toward V2 (55% of holdout moves; CLV about +0.2 to +0.5 points), but
  every-game ATS against the opener is 51.0% on the holdout (ROI −2.6% at −110) and
  50.0% at the close.
* No betting rule chosen on development passes the reality check (500 coin-flip
  worlds), and the chosen rule loses at the close on the holdout. BET is disabled.

## 8. Known weaknesses, biases, failure cases

The full list with numbers is `REDTEAM.md` §22. In short:

1. **Less accurate than the market** in every window.
2. **Prior fade has the wrong shape**: preseason information is under-used in weeks
   0–2 and over-used in weeks 7–10; the model under-reacts to sustained efficiency.
3. **P4 side of P4-vs-G5 games underrated** (about −2.6 development, −3.3 holdout),
   and market favourites of more than 21 points.
4. **No cover skill.**
5. **No historical pregame QB-status, injury or weather data**: overlays are measured
   (QB) or declared (injury, weather), never validated on pregame reports. The shadow
   rows now store the board's pregame reports so that validation can start.
6. **FBS-vs-FCS**: the mean is biased against the FBS side (about −6 on the holdout,
   −9 in 2026); intervals are honest only because they are very wide. **Not priced.**
7. **The 2024–2025 holdout is no longer pristine**; 2026 onward is the clean test.
8. **No historical spread prices after 2019**: ROI for 2020–2025 assumes −110.
9. **2013** lacks sacks; **2020** has no openers and a COVID schedule.

## 9. Shadow mode, monitoring and retraining policy

* **Daily** (`.github/workflows/cfb-v2-shadow.yml`): current-season features rebuilt
  with the backtest's own code; predictions from frozen artifacts; write-once, hashed
  snapshot rows per Tuesday freeze. Each frozen row also records candidate 001's
  projection, V1's published projection, the market as seen at the freeze, and the
  board's pregame availability / QB evidence (recorded only; V2 does not read it).
* **Line ledger** (`football/cfb_v2/shadow/<season>/lines.jsonl`): append-only,
  timestamped line observations, so edge decay by time becomes measurable.
* **Outcomes and decisions** (`shadow/<season>/outcomes.json`, `decisions.json`):
  derived every run from the frozen rows, the ledger and final scores. The frozen rows
  are never modified.
* **Monitoring** (`football/cfb_v2/monitoring.json`, `monitor.html`): per-week MAE,
  RMSE, Brier, V1 / candidate 001 / V2 on the same games, CLV and ATS, statuses, largest
  misses, and health warnings (MAE spike, calibration, missing play-by-play, stale
  odds, stale availability source, BET while disabled, ensemble weights, C/D
  disagreement, stale pipeline, week-matched output drift against a noise null).
  **A warning informs a person; nothing retrains automatically.**
* **Retrain**: once per offseason (manual dispatch) → a new `model_version`, a new
  backtest, the same gates, compared against the frozen candidate. Never after a
  single weekend.

## 10. Versioning

`football/cfb_v2/artifacts/edgedesk_cfb_v2.1.0/` holds the exact fitted models (JSON
coefficients, LightGBM text model, weights, error model, calibration, overlays,
monitoring reference) and `meta.json` (seed 20260927, windows, tuning, promotion
record). Frozen candidates live in `football/cfb_v2/candidates/<id>/` with a manifest
of hashes that `candidates.test.js` re-checks; `freeze_candidate.py` refuses to
overwrite one. Every snapshot row carries `model_version`, `feature_version`,
`prediction_ts`, `feature_ts` and a content hash.
