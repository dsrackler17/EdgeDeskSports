# EdgeDesk Research Grade: methodology

**A Research Grade rates the quality and reliability of EdgeDesk's pregame
research on one game.** It is not a win probability, not a prediction of who
wins, not a pick and not a betting recommendation. Research, not picks.

Code: `lib/edgedesk_research_grade.js` (EDGRADE). Version: `rg_v1`, weights
`w1-provisional-2026-10`. Public page: `/performance/grades/`.

## 1. The score

A deterministic score from 0 to 100, the sum of five dimensions. Each
dimension is the weighted mean of named sub-factors, each scored 0–100 from
data on file before kickoff.

| Dimension | Weight | Sub-factors (share within the dimension) |
|---|---|---|
| Model reliability & calibration | 30 | live pregame Brier skill (0.45), live calibration (0.25), walk-forward validation state (0.30) |
| Data completeness | 25 | expected model outputs present (0.30), build freshness (0.25), the engine's own input-quality measure (0.30), source authority (0.15) |
| Model–market comparison | 20 | named-book line age (0.20), spread agreement (0.35), total agreement (0.20), win-probability agreement with the no-vig moneyline (0.25) |
| Matchup clarity | 15 | key-role availability (0.40), sensitivity to one absence (0.25), itemised matchup factors (0.20), start time confirmed (0.15) |
| Uncertainty | 10 | model disagreement or projection stability (0.40), calibration band (0.35), season stage (0.25) |

**The weights are provisional.** They are a documented starting configuration,
not a validated finding. Changing any weight, threshold or reference point is a
new grade version (`CONFIGS` in the kernel); a stored grade always keeps and
reproduces under its own version.

### How each sub-factor is scored

- **Live Brier skill:** `100 × clamp((0.25 − Brier) / (0.25 − good))`, where
  `good` is a provisional per-sport reference near a liquid market's Brier
  (NFL 0.205, CFB 0.145, NBA 0.205, NHL 0.235, WNBA 0.205, college basketball
  0.175). Read from the performance ledger's grade rows **as of the grade's
  own moment**: only games that started and were graded before it, one row
  per game (its latest revision by then), from the same model family.
- **Live calibration:** the share of each probability bucket's gap that falls
  outside its Wilson 95% interval, weighted by count (`ece_excess`); 0 → 100,
  0.05 or more → 0. Noise a small bucket cannot avoid is not penalised.
- **Walk-forward validation:** MARKET_VALIDATED 100, OUTCOME_VALIDATED 75,
  EXPERIMENTAL 40, RESEARCH_ONLY 15 (labelled retrospective in the breakdown).
- **Build freshness:** age ≤ 25% of the sport's limit 100; ≤ 50% 80; ≤ 75% 55;
  ≤ 100% 30.
- **Engine input quality:** CFB — `lib/cfb_reliability.js`'s 0–100 score; NFL —
  100 − 20 per slate data-quality item; NHL — results feed FRESH 100, else 30;
  NBA — 55 when the rotation is carried from an old game; WNBA and college
  basketball publish none (missing).
- **Source authority:** official 100, a mirror of an official report 90, third
  party 80, unverified 40.
- **Line age:** ≤ 3 h 100; ≤ 8 h 80; ≤ 24 h 50; ≤ 48 h 20; older 0.
- **Agreement:** 100 when the gap is within tolerance, 0 at the sport's scale,
  linear between (spread NFL 1–7 pts, CFB 1.5–10; totals NFL 1.5–8, NHL
  0.25–1 goal; win probability 2–15 points, NHL 2–12). A big unexplained gap lowers the
  grade and is flagged: with a liquid market it is more often a data problem
  than an opportunity. It is never called an edge.
- **Key-role availability:** confirmed 100, projected likely 70, projected
  uncertain 40, unknown 0; not modelled for the sport → missing.
- **Sensitivity:** the largest single-absence move in win probability; ≤ 1
  point 100, ≥ 10 points 0.
- **Factors:** 20 per itemised factor (max 100); metrics without factors 40.
- **Start time:** confirmed 100, TBA 0.
- **Model disagreement:** measured model sd 0.5 → 6 points of win probability
  maps 100 → 0; where the engine publishes only a board default, CFB uses its
  perturbation sd (1.5 → 6 points of margin); otherwise missing.
- **Calibration band:** calibration sd 1 → 6 points maps 100 → 0.
- **Season stage:** in-season 100, early season (NFL/CFB week ≤ 3, fewer than
  10 games for a basketball side, or the engine's flag) 40.

### Letters

The score is rounded once to the nearest whole number (half up; 89.5 → 90,
89.49 → 89), then: **A 90–100 · B 80–89 · C 70–79 · D 60–69 · F below 60.**

## 2. Missing data, caps and gates

- **Nothing missing earns credit.** A missing sub-factor scores 0 and is listed
  in the Grade Breakdown with its reason.
- **A question that does not arise leaves the denominator** (`n/a`): the NHL
  publishes no margin, so its ±1.5 puck line is not compared with one.
- **Excluded and capped.** Two kinds of evidence are treated as the method
  specifies — marked unvalidated/unavailable, excluded and capped rather than
  credited:
  - an **unvalidated live track record** (fewer than 50 scored pregame games):
    the two live sub-factors leave the reliability denominator; cap **C (79)**.
    50–199 games: counted, cap **B (89)**. 200+: no cap.
  - **no named-book line captured before kickoff** (odds feed down or stale,
    game not on the feed, no quote, or a quote captured after the start or after
    the grade): the market dimension leaves the total, which stands on the other
    80 weight points; cap **B (89)**.
- **Unknown key-role availability** caps the grade at **C (79)**.
- Caps are weight-independent ceilings; the explanation names every binding cap.
- **Gates → "Not graded" (Insufficient Data)**, no letter, no score: no sport
  adapter; no model win probability; the grade's moment, the model's
  prediction time or its inputs-known time at or after the start; a model that
  reads market prices; research state not READY/CONDITIONAL; an invalidated
  projection; a build that is not FRESH; data completeness below 40; less than
  60 weight points standing on evidence. The breakdown is still shown.

## 3. Immutable pregame snapshots

The hourly performance job (`tools/performance/run.js`) grades every upcoming
game after it captures the forecasts and writes a row to
`performance/ledger/research_grades/<sport>-<year>.jsonl` whenever the letter,
the score, a part's whole-number score, the caps or gates, the forecast it
graded, whether a line was on file, or the side EdgeDesk's number sat on
changed. A line move that changes none of these is not a new grade; the
existing quote ledger keeps every line move.
Each row holds: game id, sport, league, season, teams, start; grade state,
letter, score, raw score, caps, failed gates, dimension and sub-factor scores,
flags and explanation; the grade, weights and kernel versions and the model id
and version; the forecast (hash of the forecast ledger row, win probabilities,
projected margin and total, fair lines); the named-book line with book,
provider and capture time; the evaluated side and line saved before kickoff;
the full normalised inputs; the capture time, run and commit. Rows are
SHA-256 hash-chained; a revision names the row it supersedes.

**Reproducibility.** `EDGRADE.reproduce(row)` re-scores the stored inputs under
the stored version; the job refuses to write a row that does not reproduce,
and `run.js --check` (in CI and before every hourly write) re-scores every
committed row.

**The latest valid pregame snapshot** (`EDGRADE.designate`) is the last row
captured strictly before the actual start; a row taken for a start that moved
by more than 36 hours graded a different date and is ineligible.

## 4. Settlement and evaluation

After the existing results step verifies a final (two sources agree; canceled,
forfeited and postponed-14-days games are void; overtime counts; NHL finals
include the shootout goal; corrections are revisions), each game's designated
grade is settled into `performance/ledger/grade_outcomes/`:

- winner, Brier and log loss, margin and total error from `EDPERF.gradeGame`
  on the numbers the grade froze;
- against the spread / over-under **only** from the side and line saved with the
  grade before kickoff (never chosen from the final), units only at a captured
  price;
- CLV only against a close from the same source family as the line the grade saw;
- a void game is an ineligible outcome; a game with no pregame grade gets no
  outcome and is counted as an exclusion; a corrected final is a new revision.

The dashboard (`EDGRADE.performance`) reports, per letter: settled games,
average score, Brier with a 95% interval (from 50 games), calibration buckets
with Wilson intervals, margin and total MAE / RMSE, average model-agreement and
completeness scores, records at the saved line, CLV, the sample state, and the
weekly trend. **No rate prints below 20 settled games, no interval below 50.**
A difference between adjacent letters is reported as evidence only when its 95%
interval (Welch) excludes zero with 50+ games on each side; otherwise the page
says there is no evidence yet.

## 5. What is never done

- No grade is made at or after kickoff, or from a number or line seen after it.
- No historical game is given a grade it did not have before kickoff.
- No odds, accuracy or edge is fabricated; no price is assumed.
- No grade is claimed to predict results until settled games show it.
- A retrospective analysis, if one is ever published, is labelled and kept apart.
