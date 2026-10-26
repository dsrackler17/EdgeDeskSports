# Model integrity audit, NBA / NFL / CFB / NHL (2026-10-26)

This is the record of the 2026-10-26 model-integrity audit, and the narrative for the
audit service it added. The contract is `lib/edgedesk_model_integrity.js`, the builder is
`tools/model_integrity/build.js` and the published artifact is `engine/model_integrity.json`.
The calibration figures below are reproduced by `tools/model_integrity/calibration_report.js`
and committed as `docs/system-integrity/model_calibration_audit.json`. That file is a dated
snapshot. The college football history it reads is fixed, but the NBA, NFL and NHL ledgers
grow every day. So `--check` reproduces it only at the commit that wrote it, and it is not a
CI check; rerun `--write` to refresh it.

The goal was not to remove disagreement with sportsbooks. It was to make sure that when
EdgeDesk disagrees, it does so from correct inputs, valid probabilities, and a record that
says what the disagreement is worth. No model was pulled toward the market, and no
historical record, ledger, fitted bound or methodology was edited.

## 1. What the audit does

The audit reads every NBA, NFL, college football and NHL projection that the engine
publishes. It uses the same contract that `engine/projections.json` freezes
(`lib/edgedesk_projections.js`), so it does not run a second projection engine, and no
price enters any model.

For each game, it records:

- **The model.** Version, prediction time, data cut-off and uncertainty.
- **The inputs the number assumed.** These come from the sport's own artifact:
  - NBA: who was assumed active, and the rotation source.
  - NFL: the QB and its status.
  - NHL: the goalies, with start probabilities and confirmations.
  - College football: the starters.
- **The freshness of the roster and injury inputs.**
- **The market captured BEFORE the projection.** It takes the latest quote captured at or
  before `predicted_at`, within 24 h. Sources are the hash-chained
  `performance/ledger/quotes` and the latest `today/slate.json` snapshot. For each quote it
  computes the vig-in implied probabilities, the multiplicative no-vig pair and the
  overround, all with `lib/edgedesk_calc.js`.
- **The disagreement.** It compares the model's *unrounded* margin, never the half-point
  display line, against the market line. For moneylines it compares the win probability
  against the no-vig price, in points.

It then classifies each game. A game carries every classification that applies, and
`status` is the first one in this precedence order:

| Code | Means | Example on 2026-10-26 |
|---|---|---|
| `INPUT_ERROR` | an input is wrong | PHI priced with Jalen Hurts, `RES` on the week-7 roster; NBA "absent regulars" who are on another team's roster |
| `STALE_DATA` | the projection, roster, injury report or quote is past its limit | (none today) |
| `MISSING_CRITICAL_INPUT` | a decision-critical input is unknown | every NHL goalie is a usage projection; NBA baseline has no injury report; BAL QB sources disagree |
| `CALIBRATION_WARNING` | the measured record is off where this game sits | NHL 50-60% bin; CFB FBS favourites at 90%+ |
| `LARGE_MARKET_DISAGREEMENT` | past the review threshold | CHA −10.2 vs −1.5; TOR @ CGY 7.7 pts |
| `INSUFFICIENT_EVIDENCE` | a large disagreement that no input check explains and no validated record supports | DAL @ PHI after the QB fix |
| `VALIDATED_INDEPENDENT_SIGNAL` | see the rule below | none |

**A disagreement is never an error.** `LARGE_MARKET_DISAGREEMENT` is an investigation
trigger, not proof.

`VALIDATED_INDEPENDENT_SIGNAL` (`MI.signalRule`) requires all three of these:

1. The market is `MARKET_VALIDATED` and `TESTED_AHEAD` against the close in `engine/registry.json`.
2. At least 200 graded disagreements beyond the threshold, whose model-side win rate has a
   Wilson 95% lower bound above the −110 break-even (52.38%).
3. Clean inputs.

No market meets the rule today, so no game carries the label.

**Thresholds** live in `engine/model_integrity_config.json`. They are NBA and NFL 3 points,
CFB 5 points, NHL 5 pp on the moneyline and 0.5 goals on the total. They are configurable,
and the artifact publishes beside every build how games beyond each threshold have actually
gone (§3).

**Where it runs**

- `projections-build.yml` writes and commits the artifact every 3 hours, after the
  projections.
- `projections.yml` runs its tests on pull requests.
- **Today's Games** (terminal only) shows the audit's chips on each card ("Starting goalie
  unconfirmed", "Missing injury inputs", "Major model-market disagreement", …).
- The matchup view has a **Model integrity** section. It shows who and what the number
  assumed, the quote it was compared with and when, and the component behind each warning.
- No signal chip is shown while an input error, stale data or an unresolved critical input
  stands.

## 2. The reported discrepancies, reproduced

Every model number below is the stored projection. Every market number is a DraftKings
quote with its capture time: from ESPN's scoreboard via `performance/ledger/quotes` or
`today/slate.json`, or from `record/football/*` for college football.

| Sport | Game | Reported | Stored model | Market (captured) | Verdict |
|---|---|---|---|---|---|
| NBA | IND @ MIL | MIL −1.5 vs IND −4.5 | MIL −1.5 (unrounded MIL by 0.42) | IND −4.5 (07:44Z) | **Verified**, 4.9-pt gap |
| NBA | WSH @ CHA | CHA −9.5 vs −1.5 | CHA −9.5 (unrounded 10.2) | CHA −1.5 (07:44Z) | **Verified**, 8.7-pt gap |
| NBA | MIN @ CLE | CLE −6.5; Edwards uncertain | CLE −6.5 (unrounded 5.64); Edwards in the projected rotation at 27.5 min | CLE −3.5 (07:44Z) | **Projection verified.** Edwards' status is **unverified**: no injury report is in the NBA baseline, and the official report is unreachable from this audit |
| NBA | POR @ LAL | POR −1.5 | POR by 0.84 (fair LAL +1.5) | no quote captured yet | **Market unverified** |
| NFL | DAL @ PHI | PHI −2.8 | PHI −2.83, **Hurts priced** | PHI +4.5 | **Verified, and an input error** (§4) |
| NFL | BAL @ BUF | BUF −10.5 vs −3.5 | BUF −10.54, Huntley priced (Lamar `Out` on the week-7 report, carried as PENDING) | BUF −3.5 | **Verified.** With Lamar, the same engine gives BUF −6.10 |
| CFB | Tulane @ Charlotte | Tulane −18.2 vs ~−10 | first published −18.73 (2026-10-21T01:09Z); now −13.46 | Charlotte +10 (17:23Z) | **Partially verified**: the −18 number existed and has since moved |
| CFB | Cal @ NC State | NC State −12.3 vs ~−7 | −11.95 | −7 DK (consensus −8.5) | **Verified** |
| NHL | DET @ EDM | total 6.39; EDM −144 vs −180 | 6.39; EDM 59.06% (−144) | −180 (no-vig 61.64%) | **Verified** |
| NHL | EDM goalie | possibly wrong | Levi 63% / Jarry 37% (Jarry started the last game) | — | **Unverifiable.** No confirmation or injury feed is in the repo. The headline price has no goalie term |
| NHL | LAK @ NYR | NYR −116 vs −130 | 53.73% (−116) | −130 (no-vig 54.27%) | **Verified**; 0.5 pts, not a large gap |
| NHL | TOR @ CGY | TOR −107 vs −162; CGY 48% vs 41% | CGY 48.32% (TOR −107) | TOR −155 (no-vig CGY 41.70%) | **Verified**, 6.6–7.7 pts |

## 3. What the record says the thresholds are worth

The record is chronological. Each row pairs the last forecast before the start with the last
quote at or before that forecast, and a result graded after.

| Sport (record) | Games past threshold | Model MAE vs market MAE (past threshold) | Model-side cover past threshold |
|---|---|---|---|
| CFB OOS 2022–2025 (cold replay vs opener, >5) | 957 of 3,112 | **13.69 vs 12.13** | **49.9%** (46.7–53.1) |
| CFB 2026 (>5) | 22 of 86 | 11.61 vs 9.73 | 50.0% (30.7–69.3) |
| NFL 2026 (>3) | 35 of 88 | 9.09 vs 9.07 | 64.7% (47.9–78.5) |
| NBA 2026 (>3) | 20 of 43 | 14.45 vs 12.80 | 50.0% (29.9–70.1) |
| NHL 2026 moneyline (>5 pp) | 5 of 26 | Brier 0.215 vs 0.215 | — |

Only college football has enough history to measure. There, a disagreement beyond 5 points
has been a reason to look, and **not** a reason to act: the market has been the more
accurate number on those games, and the model's side covered at a coin-flip rate. The NFL's
64.7% is 22 of 34 games, with a lower bound of 47.9%. That is not evidence.

## 4. Confirmed defects and what was repaired

| Sport | Defect | Root cause | Files | Severity | Repair |
|---|---|---|---|---|---|
| NFL | A QB on the reserve list priced as the starter | `fbNflReconcileStarters` reads only OUT/DOUBTFUL on the weekly injury report. That report lists active-roster players only, and the roster's `RES` status was never read. The depth-chart check was blocked as "contested" | `app.html`, `tools/football/build_nfl_slate.js` | **High.** PHI −2.83 → −0.58, and PHI @ WAS WAS −0.28 → −2.52, from the same feeds at the same instant | `fbNflReconcileRoster`: `RES`/`CUT`/`RET`/`SUS` replace the starter as OUT does, PENDING for an earlier week's roster; the replacement skips anyone off the active roster. Labelled `ROSTER_RESERVE_REPLACEMENT[_PENDING]`, sourced to the roster |
| All (EDINTEL) | Push-inflated EV | `decide()` used a two-way no-vig probability (no push) as the unconditional P(win) beside a separate push mass | `supabase/functions/edgedesk_ai/_intelligence.js` (+ inlined copies) | **High.** 0.5 at 1.909 with a 6% push read **+1.45%**, correct −4.27% | win = p(1−q), loss = (1−p)(1−q); edge against (1−q)/d |
| Football, NBA, NHL graphics | "EDGE: …" from a mean-vs-line gap | the card named a side from the gap alone; NBA and NHL cards printed it while their own slates say value claims are DISABLED; the NHL moneyline was compared with the no-vig split, not the offered price | `lib/edgedesk_game_graphic.js`, `lib/edgedesk_nba_graphic.js`, `lib/edgedesk_nhl_graphic.js` | **Medium.** The LAK @ NYR card read "EDGE: OVER 5.5" with P(6+) 52.67% against a 56.52% break-even | the gap is a *reading*. An EDGE needs the exact bet's probability, pushes counted, to clear its offered price's break-even by 4 pts, and value claims on. NBA/NHL cards compute `price_checks` from their own ladders |
| NHL | A one-sided goalie confirmation marked the game CONFIRMED | `goalieCertainty = conf ? 'CONFIRMED' : …` | `hockey/build_slate.js` | Medium (latent: no confirmations file today) | `startersFor()`: CONFIRMED only when both sides are; an operator-listed unavailable goalie leaves the projection; a confirmation naming one is a CONFLICT; every projected goalie is UNVERIFIED, with a warning |
| NBA | Players who left the team offered as "returns" scenarios and listed as absent regulars | `regulars()` spans the last ten games, which early in a season reach into last season, with no roster check | `nba/build_slate.js`, `lib/edgedesk_nba_ui.js` | Medium (research and AI context; the price moves at most 0.24 pts) | `splitAbsent()`: absent regulars checked against the current roster the build already reads; departed players listed as "Left the team (now X)" |
| Board | NHL whole-number total reference had no push | a no-push no-vig reference was shrunk against an unconditional probability | `engine/build_board.js` | Low (latent: NHL prices are not captured) | reference × (1 − push), as the football board's |

**Investigated, measured, and not changed:**

- **NBA projected-rotation minutes.** Every player in the last box score is scaled to 240
  minutes, so a 14-man blowout box cuts the starters' minutes: Minnesota's last box cut
  Edwards from 32.8 to 27.5. The depth-chart allocation the roster-adjusted layer already
  uses would move the player-impact margin by at most 2.2 points (≈0.9 on the price). Its
  correlation with the model-market gap over today's quoted games is −0.08 (n = 9), so it
  does **not** explain the reported discrepancies. A fix changes a fitted feature, so it
  needs a refit and a new model version (§7).
- **NBA `adj_proj` full-strength reference.** It includes departed players, but its ridge
  coefficient is 0.095, so the effect is ≤ 0.24 pts on today's slate.
- **NHL "inactive goalie".** Over 2016–2026, a top-two goalie idle for 7 club games started
  the very next game 33.8% of the time, and started again within 10 games 77.9% of the time.
  Idleness is not evidence of unavailability, so no heuristic was added. The projection does
  *under*state idle goalies' next start (8.7% projected vs 33.8% observed) and overstate the
  last game's starter (63.5% vs 49.4%). That finding belongs to the goalie layer's own
  calibration (§7).

## 5. Edge calculations

Every American-odds and no-vig formula on the platform was checked and none is wrong for a
valid price (inventory in the pull request). The exact-price engines (`lib/edgedesk_quote_ev.js`,
`lib/edgedesk_ev.js`, `lib/edgedesk_fairodds.js`, `lib/research_core.js`,
`lib/edgedesk_market_compare.js`, `nba/build_slate.js` market block) price the exact bet with
pushes counted against the offered price's break-even.

The surfaces that still label from a gap in points alone are listed in §7. They are research
statuses, leans and counters, not EV claims, and are documented rather than changed here.

## 6. Calibration and accuracy

Source: `docs/system-integrity/model_calibration_audit.json`. Every axis is stated in the
script's header.

**College football, out of sample 2022–2025** (n = 3,120, FBS vs FBS, cold replay):

- **Margins are too wide.** Regressing actual home margin (y) on projected home margin (x)
  gives a slope of **0.933** (SE 0.022). Model MAE is 12.72, against 12.12 for the opener
  and 12.00 for the close.

- **Favourites fall short in every bucket above 7 points:**

  | Projected favourite margin | n | Projected | Actual | Bias (SE) | Favourite won vs predicted | Covered close |
  |---|---|---|---|---|---|---|
  | 0–3 | 548 | 1.58 | 1.79 | +0.21 (0.67) | 54.6% vs 54.2% | 51.5% |
  | >3–7 | 685 | 4.97 | 4.52 | −0.45 (0.62) | 60.3% vs 63.1% | 50.2% |
  | >7–10 | 471 | 8.43 | 6.81 | **−1.62 (0.76)** | 67.9% vs 71.5% | 46.7% |
  | >10–14 | 455 | 11.89 | 10.38 | **−1.51 (0.72)** | 76.3% vs 78.8% | 50.5% |
  | >14–21 | 526 | 17.14 | 14.79 | **−2.35 (0.68)** | 83.1% vs 87.3% | 47.8% |
  | >21 | 435 | 28.07 | 26.14 | **−1.93 (0.79)** | 93.6% vs 96.2% | 48.0% |

- **Win probabilities are too extreme, not compressed.** Logistic recalibration of the
  outcome on logit(p) gives a slope of **0.854** (95% bootstrap CI 0.78–0.92). ECE is 0.028.
  Three bins fall outside their intervals: 65–70% (67.5% predicted, 61.1% observed), 85–90%
  (87.4% vs 81.6%) and 95–100% (97.5% vs 95.1%).

- **The disagreement with the opener carries no measurable information about the result.**
  Regressing actual − open (y) on model − open (x) gives a slope of **0.055** (SE 0.057). The
  close moved toward the model 54.2% of the time (52.3–56.1%), which is information about
  the line, not the game.

- **Rolling-origin tests**, fitted on earlier seasons only:
  - A margin shrink (fitted slope 0.91–0.92) lowered MAE in 3 of 3 test seasons, but only
    by 0.004–0.074.
  - A win-probability recalibration improved log loss in 2023 and 2024 and worsened it in
    2025.

**College football, 2026 live.** These are the published picks.

- **FBS vs FBS** (n = 393): bias −0.46 (SE 0.76). In the 21+ bucket the bias is −4.53
  (SE 2.41), and the 90–95% win bin ran 91.6% predicted against 73.9% observed (n = 23).
- **FBS vs FCS** (n = 73): bias **+7.95** (SE 2.05). Favourites beat the projection, so
  pooling the two populations hides both effects.

**Verdict on Tulane and NC State.** Part of a large CFB favourite's gap to the market is
measured **miscalibration of scale**, not signal. The remainder is unexplained, and the
record does not support it.

At the measured slope, Tulane −13.46 becomes about −12.6 against −10, and NC State −11.95
becomes about −11.1 against −7. A calibration change is a methodology change: it was not
made here (§7).

**NHL: are probabilities compressed toward 50%?**

- **Against outcomes, the evidence is mixed.** The confirmation-window slope is 1.064 (inside
  the [0.85, 1.15] pass band). Per season, the slope was above 1 every year 2014–2022 (1.09–1.66),
  about 1 in 2023–2025 (1.02, 0.96, 0.99), 0.78 in 2026 (too extreme), and 1.82 live in 2027
  (n = 140). That is not a stable compression.
- **Against the timestamp-matched no-vig market** (n = 26), the model's logit-probabilities
  are 0.85× as dispersed as the market's. This is consistent with mild compression relative
  to the market, on too few games to act on.
  - The regression slope of logit(model) on logit(market) is 0.81, but that slope is diluted
    by disagreement and is not a compression measure on its own.
- The pair calibration's b = 0.9 does shrink the home/away split by design.
- Totals are the opposite: their slopes are 0.72–0.78 (too spread out).

**NBA, NFL, live 2026:**

- **NBA** (n = 43): Brier 0.219. Its dispersion against the market is 0.97, about equal. The
  totals bias is +2.4.
- **NFL** (n = 90): Brier 0.239, and spread MAE 9.35 against 9.08 for the market.
  - Home margins came in **2.86 points below projection** (SE 1.23). That is about 2.3 SE on
    90 games and points at the home-field term, a model parameter (§7).
  - The NFL's dispersion against the market is 1.16.

## 7. What remains, and what needs its own pull request

These are methodology changes. Under AGENTS.md §3, each must be its own pull request with
this evidence and a before/after on the committed data. None was folded into this one.

1. **CFB margin scale and win-probability calibration** (FBS vs FBS).
   - Evidence: §6. The margin shrink improves 3 of 3 rolling-origin seasons, by small
     amounts. The repo's own `cfb_margin_cal_v1` (slope 0.9637) failed its 0.05-MAE bar with
     a CI that crosses zero.
   - The win-probability slope is 0.854 (CI 0.78–0.92). The rolling recalibration is mixed.
   - FBS vs FCS needs its own treatment: the bias there is in the opposite direction.
2. **NBA rotation minutes.** Allocate projected minutes down the depth chart, as
   `nba/injury/core.js` does, instead of scaling every player in the last box. This needs a
   walk-forward refit and a new model version.
3. **NFL home field in 2026** (−2.86 ± 1.23 on 90 games). Watch it. A change needs the
   walk-forward.
4. **NHL goalie start probabilities.** They are miscalibrated at the extremes (§4); the
   goalie layer's own calibration should be measured and fixed there.
5. **Remaining gap-only labels**, all documented:
   - `football/engine.js` `classifyEdge` (RESEARCH_LEAN at 2 points);
   - `lib/edgedesk_canon.js` research statuses and the "ACTIONABLE RESEARCH SIGNALS" counter;
   - `lib/edgedesk_read.js` "FOOTBALL-MODEL EDGE" wording. Changing its text alone moves 31
     committed terminal reads, so it must ship with a CFB terminal rebuild;
   - the capture function's `edge`, whose size is overstated by 1/(1−push) on whole lines.
6. **Data the audit could not reach from this environment:**
   - ESPN, the NBA official injury report, the NHL API, the odds API and the production site
     are blocked by this container's network policy;
   - no Supabase credentials, so the injury and goalie layers' database rows were not read.

   Live feeds were therefore not verified here, only the committed artifacts.
7. **Too little history to validate:**
   - NBA, NFL and NHL thresholds: 2026 only, n = 26–88 matched;
   - NHL and NBA have no licensed closing-price archive, so no market test is possible yet.
