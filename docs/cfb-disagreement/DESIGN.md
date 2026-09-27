# CFB major-disagreement integrity gate — design contract

A 7-point disagreement between EdgeDesk and the market is, far more often than
not, missing or stale information, a scaling error, a roster/QB problem, a
cross-conference translation issue, an over-adjustment or a market-data
problem, not a 10-point betting edge. The forensic replay measured exactly
that (`FORENSICS.md`): at 7+ points the production engine was closer to the
final margin than the opener in 40% of games (2015-2025, n = 998).

So **a raw 7+ gap is never shown as a major disagreement.** It is
`INVESTIGATE` until it passes every integrity check, and only then
`VERIFIED MAJOR DISAGREEMENT`. The checks get stricter as the gap grows.

The results that justify each rule are in [`REPORT.md`](REPORT.md) (the
deliverable) and [`FORENSICS.md`](FORENSICS.md) (generated).

## What the gate never does

- **It never changes the pure football number.** Fair spread, projected
  score, win probability and model state are read, never written. Changing
  the sportsbook line alone changes none of them. `tools/football/disagreement.test.js`
  §14 prices the same game with no market, a -30 line and a +45 line and
  requires byte-identical output.
- **It never uses the market as a football input.** The market is the thing
  being compared against, and its own integrity is checked.
- **It is not a bet.** VERIFIED means the model genuinely disagrees and the
  disagreement survived integrity checks. Bet eligibility belongs to the
  decision layer (calibrated cover probability, price, EV, uncertainty, CLV
  evidence, freshness), and nothing here can override it. Every verdict
  carries `not_a_bet`.
- **It is not a quota.** There is no maximum number of verified gaps per week.
  The slate circuit breaker compares the count of raw gaps with their
  historical frequency and raises `MODEL_SCALE_ALERT` for investigation. It
  never suppresses a gap.
- **It never hides a large gap.** A gap past the 21-point guard that passes
  every check is shown as `VERIFIED MAJOR DISAGREEMENT · EXTRAORDINARY 15+ ·
  MANUAL REVIEW QUEUED`. An unverified one is `DATA FAULT`.

## The statuses

| status | when | tone |
|---|---|---|
| MARKET ALIGNED | gap under 2 points | ok |
| WORTH RESEARCHING | gap 2 to 7 with usable data | accent |
| INVESTIGATE | gap 7+ and a check failed, or verification is incomplete (`INVESTIGATE — VERIFICATION INCOMPLETE`) | warn, and the gap is dimmed |
| MARKET FAULT | gap 7+ and the market data is insufficient or stale | dim |
| DATA FAULT | a known integrity problem (mapping, orientation, invalid distribution), or an unverified gap past the guard | neg |
| VERIFIED MAJOR DISAGREEMENT | gap 7+ and every required check passed | **the strongest treatment on the board** (filled gold chip, glow); nothing else gets it |

`MAJOR DISAGREEMENT` no longer exists. The research view keeps
`LIMITED DATA`, `LOW RELIABILITY` and `NEAR PICK'EM` for gaps under 7, as before.

## The checks

Every item returns `PASS | FAIL | WARN | INCOMPLETE | NOT_APPLICABLE |
NOT_EVALUATED`. **INCOMPLETE is never a pass.** A group passes only when every
item is PASS, WARN or NOT_APPLICABLE (NOT_EVALUATED is reserved for the
historical replay and says what the corpus cannot know). A gap is VERIFIED
only with zero FAIL and zero INCOMPLETE.

| group | check | 7+ | 10+ | 15+ | evidence |
|---|---|---|---|---|---|
| GAME | teams resolve, identity join, home/away orientation of the quote, venue/neutral flag known, kickoff valid, pregame, quote kickoff within 36 h | required | required | required | a swapped or mis-joined row is a DATA FAULT, not a disagreement |
| MARKET | quote present and plausible (\|line\| ≤ 60) | required | required | required | the archive carries -334 and 185 openers |
| MARKET | books behind the consensus | ≥ 2 | ≥ 2 | ≥ 3 | single-book openers carried sign flips (UCF–Maryland 2016: -9 at one book, +10.5 at seventeen) |
| MARKET | quote age | ≤ 24 h | ≤ 12 h | ≤ 12 h | a quote with no capture time cannot be judged fresh (INCOMPLETE) |
| MARKET | cross-book dispersion | SD ≤ 2.31 or range ≤ 5 (archive p99) | same | same | an outlier or stale book driving the consensus |
| TEAM STATE | current-season games behind BOTH ratings | ≥ 3 | ≥ 4 | ≥ 4 | holdout 7+ gaps: pass → 23.0% false extremes, fail → 37.3% |
| TEAM STATE | long-term state vs current form | warn past 10 | ≤ 10 | ≤ 10 | stale-state guard |
| TEAM STATE | opponent adjustment converged / state season / state fresh | when supplied | same | same | V1 is a sequential Elo: NOT_APPLICABLE, said so |
| TEAM STATE | FCS opponent | warn | fail | fail | pooled FCS rating |
| QB | a starter ruled OUT/DOUBTFUL/QUESTIONABLE/GTD that the number does not price | fail | fail | fail | QB_STATUS_ERROR |
| QB | a new starter the rating has not seen (under 3 recent starts), unpriced | fail | fail | fail | no double count once he has 3 starts |
| QB | starter unresolved (COMPETITION/UNKNOWN) | warn | fail | fail | "resolved or scenario-weighted" at 10+ |
| ROSTER | availability feed FETCH_FAILED / STALE / CONFLICTING | fail | fail | fail | abnormal missing data (NOT_DUE_YET and "checked, none filed" are normal) |
| ROSTER | an absence the rating already reflects also priced | fail | fail | fail | ROSTER_DOUBLE_COUNT |
| COMPONENT | any non-base term past its validated p99 | fail | fail | fail | component distributions, `disagreement_params.js` |
| COMPONENT | the conference term alone lifts the gap over its tier (≥ 2 pts) | **fail** | fail | fail | holdout: moved toward 41%, false extremes 43% |
| COMPONENT | the matchup term alone lifts it | warn | warn | warn | historically informative (7+ gaps with \|matchup\| > 3 moved toward 65%) |
| COMPONENT | schedule / injury / QB / travel / rivalry term alone lifts it | warn | fail | fail | |
| MODEL | valid prediction distribution | required | required | required | |
| MODEL | information confidence ≥ 35, reliability ≥ 60 | required | required | required | the engine's own floors |
| MODEL | football-only calibration keeps the gap ≥ 7, same sign | required | required | required | HFA_ERROR / EXTREME_FAVORITE_NONLINEARITY; the label claims only the tier the calibrated gap supports |
| MODEL | independent submodels on EdgeDesk's side by ≥ 2 pts | majority | majority | n − 1 | holdout: support fails → false extremes 30.2% vs 26.6% |
| MODEL | the independent ensemble on EdgeDesk's side | same direction | ≥ 3 pts | ≥ 5 pts | |
| MODEL | the ensemble's internal disagreement (SD) | — | ≤ 6 | ≤ 5 | holdout fail: moved toward 37%, false extremes 40% |

**Favourite flip** (EdgeDesk and the market name different favourites) at 7+:
the 10+ sample, ensemble-gap and ensemble-SD rules apply, and the independent
ensemble must favour the same team as EdgeDesk.

**15+**: every 10+ rule, three books, n − 1 submodels, and `manual_review:
true` with the `MANUAL_REVIEW` flag and an internal warning. Never an
automatic wager designation.

**Fail safe**: any exception inside verification returns `INVESTIGATE —
VERIFICATION INCOMPLETE`. No gate result at all (library missing, adapter
threw) makes the research view and the board fail closed the same way.

## Root causes

The first failing check, in a fixed priority order, names the cause:
`GAME_MAPPING_ERROR, HOME_AWAY_ERROR, MARKET_JOIN_ERROR, STALE_MARKET,
THIN_MARKET, QB_STATUS_ERROR, PLAYER_AVAILABILITY_ERROR, ROSTER_DOUBLE_COUNT,
FCS_TRANSLATION_ERROR, EARLY_SEASON_PRIOR_ERROR, OPPONENT_ADJUSTMENT_ERROR,
CROSS_CONFERENCE_SCALE_ERROR, MATCHUP_OVERADJUSTMENT, HFA_ERROR,
TRAVEL_OR_REST_ERROR, EXTREME_FAVORITE_NONLINEARITY, TEAM_RATING_ERROR,
RECENT_FORM_OVERREACTION, UNKNOWN`. All checks passing gives
`VALID_MODEL_DISAGREEMENT`. Incomplete verification gives `UNKNOWN`: a cause
is never invented.

## The false extreme

A raw 7+ gap is a **false extreme** when BOTH hold: the closing market did NOT
move toward EdgeDesk (it held or moved away), AND the final margin landed on
the market's side of the disagreement or within its first quarter. A losing
ticket alone is never enough: a game that lost ATS after the market moved
toward EdgeDesk had a good price and is not counted.

## Market movement after a verified gap

`D.movement(prev, now)` names the move MOVED_TOWARD / UNCHANGED / MOVED_AWAY.
A VERIFIED gap that a multi-book market moves 1.5+ points further away from
raises `RECHECK_REQUIRED`: revalidate QB, injuries, roster, news and source
freshness. The pure projection is not changed by the move.

## The football-only margin calibrator

`calibrated = slope × (raw margin − applied home field) + fitted home field × [home game]`,
fitted to **final margins only** (`football/cfb_p4/margin_calibration.js`,
generated). It has no intercept on the neutral part, so a neutral-site pick'em
stays 0 and swapping the teams negates the number.

It is **not promoted**: walk-forward it improves MAE by 0.041 points and the
14+ tail by 0.062, better in 7 of 9 seasons, which is under the repo's
pre-declared 0.05-point bar (`football/cfb_p4/v12_correction.js` criteria). The
engine publishes it as `model.margin_calibration` (a shadow, `promoted: false`)
beside `model.raw_game_margin`, and the gate uses it as the calibration check.
The equation every projection satisfies:

```
raw game margin      = Σ contributions (rating, hfa, qb, matchup, travel, schedule, injury, rivalry, conference)
calibrated (shadow)  = slope × (raw − applied hfa) + fitted hfa × [home]
priced fair spread   = raw game margin          (calibrated only if margin_calibration.promoted)
```

## Where it lives

| piece | file |
|---|---|
| the gate (UMD, browser + Node) | `lib/cfb_disagreement.js` (`window.EDCfbDisagreement`) |
| measured parameters (generated) | `football/cfb_p4/disagreement_params.js` |
| the calibrator (generated) | `football/cfb_p4/margin_calibration.js` |
| engine: raw margin, shadow calibration, both teams' games played | `football/cfb_p4/engine.js` (additive fields only) |
| research view labels | `lib/cfb_research_view.js` (`researchLabel`, `disagreementSummary`) |
| board status, evidence packet, loaders | `app.html` (`fbP4DisagreementFor`, `fbP4GateStatus`, `fbP4StatusFor`, `fbP4ForensicHTML`, `fbDgSubEnsure`) |
| headless publisher | `tools/articles/research_host.js` loads the gate |
| slate artifact: football gate inputs | `football/fbs/build_coverage.js` → `slate.json` `disagreement_inputs` |
| Model Lab verdict per snapshot | `football/cfb_lab/checkpoint.js` |
| Model Lab graded section | `football/cfb_lab/disagreement.js` → `lab.json` `major_disagreement`, `admin/cfb-lab` §8 |
| database | `supabase/cfb_lab.sql`: seven columns on `cfb_lab_predictions`, two constraints, the `cfb_lab_major_disagreements` view, report row 13 |
| forensic replay | `football/cfb_p4/research/disagreement_eff.js`, `disagreement_replay.js`, `disagreement_forensics.js` |
| current slate + weekly report | `tools/football/disagreement_slate.js` → `football/validation/disagreement/slate_<season>_week_<NN>.{json,md}` |
| tests | `tools/football/disagreement.test.js` (169 checks) and the updated view, board, lab and SQL suites |

## Runbook

```
# the forensic replay (network once: schedules, the betting archive, play tables)
DATA=.cache/cfbdata
mkdir -p $DATA/sched $DATA/betting
B=https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main
for y in $(seq 2007 2026); do curl -fsSL $B/schedules/csv/cfb_schedules_$y.csv -o $DATA/sched/sched_$y.csv; done
curl -fsSL $B/betting/csv/cfb_line_odds.csv.gz -o $DATA/betting/cfb_line_odds.csv.gz
npm run cfb:disagreement:eff -- --data $DATA 2014 2015 2016 2017 2018 2019 2020 2021 2022 2023 2024 2025 2026
npm run cfb:disagreement:replay -- --data $DATA --from 2015 --to 2026 --replay-from 2007
npm run cfb:disagreement:forensics -- --data $DATA        # regenerates the params, the calibrator and every report

# the current slate and the weekly report
npm run cfb:disagreement:slate -- --season 2026 --replay $DATA/out/disagreement_replay.jsonl

npm run cfb:disagreement:test
```

Refit cadence: the measured parameters and the calibrator are regenerated in
the offseason with the rest of the engine (never midseason). Promotion of the
calibrator or of the re-fitted blend is a person's decision against the
0.05-point bar, after the full 2026 season is in.
