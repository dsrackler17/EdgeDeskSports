# NHL — model card (`edgedesk_nhl_v1`)

> Status: **validated against outcomes, not tested against the market.**
> Fair lines are published; value claims are off.

## 1. Data

| Layer | Source | Coverage | Files |
|---|---|---|---|
| Play-by-play | sportsdataverse `fastRhockey-nhl-data` (compiled from the NHL's api-web game feeds) | 2010-11 → 2026-27 in progress, regular season + playoffs, 20,676 games | `.cache/nhl_src` (not committed) |
| Starters | the same, goalie box score `starter` flag | as above | — |
| Schedule | sportsdataverse `fastRhockey-nhl-raw` season schedule; the NHL API `/v1/schedule/{date}` in CI | every scheduled game with UTC start | `hockey/sources/nhl_api.js` |
| Team-game table | built here (schema `edgedesk_nhl_team_games_v1`) | 41,352 rows, 2 per game | `hockey/data/team_games/<season>/<YYYY-MM>.csv`, `hockey/data/manifest.json` |

**Integrity, measured on ingest**: every game's play-by-play final equals the
official final (0 disagreements across 17 seasons); time on ice sums to 3,600 s
in every regulation game; one goal-attribution mismatch in 41,352 team-game
rows (`tools/hockey/hockey.test.js` tolerates none in the 2025-26 partition it
checks). 2009-10 is excluded (no strength state in the source).

Semantics verified on the 2025-26 source before any code relied on them: the
home team attacks +x; `event_team` is the shooter (shots) and the penalised
team (penalties); a goal row's score already includes the goal; `empty_net`
is true exactly when the defending goalie is out.

## 2. Method

1. **xG** (`hockey/xg/model.js`). Shot-level logistic regression on distance
   (piecewise linear), angle, behind-the-net, shot type, rebound and its angle
   change, rush, cross-slot movement, puck speed from the previous event,
   turnovers, offensive-zone faceoffs and hits, strength state and
   interactions; a separate distance model for empty-net attempts. Fitted on
   the three seasons before the season it scores.
2. **Ratings** (`hockey/model/ratings.js`), point in time: score-and-venue
   adjusted, opponent-adjusted 5v5 xG for/against; all-situations goals;
   power-play xG and penalty-kill xG against; PP/PK minutes; finishing;
   goalie goals saved above expected shrunk toward a replacement-level prior;
   projected starters (recent usage, the league's measured back-to-back
   rule). Half-life 180 days, a 32-game prior (tuned on the selection window).
3. **Goal model** (`hockey/model/glm.js`). Poisson regression of each team's
   regulation goals on the ratings (log ratios), home ice and back-to-backs,
   with the league's running scoring level as an offset; refitted each season
   on the five seasons before it. A two-number recalibration (shrink the
   predicted total, stretch the home/away split) is fitted on the three
   seasons' out-of-sample predictions before the season it applies to.
4. **Score distribution** (`hockey/model/distribution.js`, browser + Node).
   An exact 30-second dynamic programme over regulation with empirical
   score-effect multipliers by lead and time (they encode leaders sitting back,
   trailers pressing and goalie pulls), 3-on-3 overtime with a fitted rate,
   the shootout at its observed home rate, and sudden death in the playoffs.
5. **Markets**: 2-way moneyline (incl. OT/SO), 60-minute 3-way, puck line
   ±1.5 (an OT/SO win is a one-goal win), totals 5–7 (incl. OT; shootout
   winner credited one goal; whole lines push), team totals.

Tested and rejected, recorded in the validation file: a bivariate-Poisson
common shock (maximum-likelihood share 0 in every season).

## 3. The walk-forward record (`hockey/validation/nhl_walkforward.json`)

Protocol (written into `hockey/model/walkforward.js` before scoring): one
chronological pass; games on date D are predicted from games on earlier dates
only, 30 minutes before the scheduled start; every parameter is fitted on
earlier seasons. Selection window 2014–2020, confirmation 2021–2026, live
2026-27. Leakage audit: **17,236 predictions, 0 violations**.

Moneyline log loss (lower is better):

| Model | Selection (n 9,205) | Confirmation (n 7,945) | Live 2026-27 (n 86) |
|---|---|---|---|
| Home ice only | 0.6899 | 0.6908 | 0.6894 |
| Elo (FiveThirtyEight MOV form, tuned on selection) | 0.6767 | 0.6665 | 0.6592 |
| Goals-only ratings | 0.6758 | 0.6649 | 0.6568 |
| **xG model (chosen)** | **0.6747** | **0.6627** | **0.6539** |
| xG + projected goalie | 0.6745 | 0.6625 | 0.6541 |
| xG + confirmed goalie | 0.6743 | 0.6625 | 0.6532 |

On confirmation the chosen model beats Elo by 0.0039 (block bootstrap 95%
interval −0.0057 to −0.0022) and goals-only by 0.0023 (−0.0035 to −0.0012).
Goalie information adds a statistically detectable but tiny amount
(−0.0002); under the pre-registered rule (a challenger must beat the
incumbent by 0.001 on selection) the goalie-free model was chosen, and the
goalie-aware variant drives the goalie scenarios instead.

Status by market on confirmation (rules: n ≥ 1000, |mean p − mean y| ≤ 0.02,
calibration slope 0.85–1.15, and for the moneyline a 95% interval below the
best baseline):

| Market | Status | Notes |
|---|---|---|
| Moneyline | OUTCOME_VALIDATED | Brier 0.2353, slope 1.08, mean p − y +0.008 |
| Puck line home −1.5 / away −1.5 | OUTCOME_VALIDATED | slopes 0.94 / 0.99 |
| Total 5.5 / 6.5 | PROVISIONAL | calibration slopes 0.81 / 0.80 (over-confident) |
| 60-minute 3-way | PROVISIONAL | the draw is under-priced: 20.5% predicted vs 22.4% observed |
| Team totals | PROVISIONAL | not separately scored |
| **Against the close** | **NOT_TESTED** | no licensed closing archive (`hockey/model/market_test.js` is ready) |

xG (`hockey/xg/report.json`): beats a distance-only model in every season and
matches or beats the source's own xG through 2021-22; from 2022-23 the source
records shot locations differently and its own xG (whose training seasons are
undocumented, so possibly in-sample) is better calibrated than mine.

## 4. Honest limits

- **Not tested against the market.** Beating Elo is not beating a sportsbook.
  Until `hockey/market/closing/` holds a licensed archive and the market test
  says `TESTED_AHEAD` (n ≥ 500), no NHL price is called an edge.
- The confirmation window was viewed while two structural defects were fixed
  (a scoring-level lag and the total/split recalibration, both diagnosed on
  the selection window). The 2026-27 season and every later one are the clean
  out-of-sample test; the ledger (`hockey/ledger/`) freezes every published
  price before the puck drops so that test is honest.
- Skater injuries, line combinations, travel and time zones are not modelled.
- Starters are projected unless confirmed by hand with a source.
- Totals are over-confident and the 60-minute draw is under-priced; both are
  labelled PROVISIONAL in every view.
