# CFB weekly engine — methods

The exact rules the engine runs, with every constant. The design contract is [`DESIGN.md`](DESIGN.md), the
operator's guide [`RUNBOOK.md`](RUNBOOK.md), the replay evidence [`REPLAY.md`](REPLAY.md). The two data
layers have their own methods documents, written with their results:

- [`METHODS_GAMES.md`](METHODS_GAMES.md): game validation and finality, play-context classes, game
  performance (expected margin, turnover luck, explosive dependency, drive metrics).
- [`METHODS_STATE.md`](METHODS_STATE.md): opponent adjustment and its convergence, team posteriors
  (overall / offense / defense / special teams / pass / rush, mean and SD), recent form, trend flags,
  volatility, prior decay, home field, FCS, QB state and change detection, rating movement bounds.

This document covers the orchestration around them: runs, idempotency, stages, the gate, projections,
attribution, degraded modes, guardrails, research items, availability and source health.

## 1. The run

A run is one execution of `python3 -m v2.weekly.run --mode <mode>` (`run.py`).

| field | rule |
|---|---|
| `run_key` | `h('run', season, source_week, target_week, model_version, feature_version, data_version, mode)`: names the work |
| `run_id` | `'cfbw_' + h(run_key, started_at)`: names the execution |
| `data_version` | content hash over the pure model's inputs (play-by-play, schedule, talent, returning production) of the season and every earlier season the priors read (`sources.versions`) |
| per-source versions | `pbp_version`, `schedule_version`, `market_version`, `talent_version`, `retprod_version`, `roster_version`, `injury_version`, `qb_status_version`, `weather_version`: each the hash of the files it reads |

`h` is sha256 over the parts joined with `|`, truncated to 24 hex characters, the same rule the Model Lab
uses (`ids.py` and `football/cfb_lab/lab_core.js` produce the same id for the same parts; a test pins one).

**Idempotency.** Before any work, the run looks for a published run with the same `run_key`. If it finds
one, the run is a no-op (nothing is appended). `--force` re-runs it: state written exactly once
(section 6) means a forced re-run appends a run record and nothing else unless an input changed. The replay
proves both on real data.

**Lock.** An exclusive, non-blocking `flock` on `$CFB_V2_OUT/.weekly.lock` (`runlog.RunLock`). A second run
fails at once with status `LOCKED`; it never waits and never deletes another run's lock. The workflow's
concurrency group is the first guard.

**Season rollover.** `season_for(now)`: January and February belong to the season that began the previous
August. `fetch_v2.sh` and `run_all.sh` use the same rule.

**Weeks.** `weeks_for(G, season, now, mode)` returns (source week, target week, T). T is the freeze instant
of the target week: the backtest's `prediction_ts` (Tuesday 12:00 UTC before kickoff). Weekly and daily
modes take the next freeze not yet passed; freeze mode takes the current one; rebuild takes the freeze
after `--through-week`. The source week is the last week with a game kicked off before T.

## 2. Stages

Each stage records a status (`OK`, `WARN`, `FAILED`, `BLOCKED`, `SKIPPED`), timing, counts, warnings and a
classified error. A stage whose declared dependencies are not all `OK`/`WARN`/`SKIPPED` is `BLOCKED` and
does not run.

| stage | needs | what it does |
|---|---|---|
| `INGEST_FINAL_SCORES` | – | fetch (with retry), data versions, stage-1 rebuild **only for seasons whose inputs changed** (hash manifest `stage1/.inputs.json`), stage 2, weeks, idempotency |
| `VERIFY_COMPLETED_GAMES` | ingest | `validate.validate_games(season, now)`; the source week's in-scope games: overdue / not final after 36 h → WARN; schedule, provider and PBP disagree on finality → held out, WARN; final score disagrees with the Model Lab settlement → WARN |
| `VALIDATE_PBP` | verify | status counts, plays processed, mean `pbp_completeness_score`; every `DATA_ERROR` named |
| `GAME_PERFORMANCE`, `DRIVE_METRICS` | validate | `perf.game_performance(season, T)`, `perf.team_summary(season, T)` |
| `OPPONENT_ADJUSTMENT` | validate | V2 stage 3 (`build_ratings`) for the season |
| `PLAYER_QB_METRICS` | opponent adj. | V2 stage 4 (`qb`), then `qb_state.build(season, T)`: QB rows and events |
| `AVAILABILITY_STATE` | ingest | `availability.snapshot`: official reports as known at the run |
| `TEAM_POSTERIORS` | opp. adj., QB | `team_state.build(season, T, prev)`; movement flags; any non-finite posterior → FAILED (`DATA_QUALITY`) |
| `RECENT_FORM`, `UNCERTAINTY` | posteriors / calibration | counts from the state rows and the sigma model |
| `UPCOMING_FEATURES` | posteriors | V2 Elo and stage 5 for the season; every scheduled target game must have a feature row; feature snapshots |
| `LEAKAGE_TESTS` | features | `v2.tests_leakage` (injection tests) |
| `PURE_SUBMODELS`, `ENSEMBLE`, `CALIBRATION` | features | the frozen artifact, verified against its MANIFEST (section 4) |
| `PROJECTION_RECORDS` | calibration | degraded modes, projection records, change records, guardrails, sanity checks |
| `RELEASE_GATE` | records | section 3; failure → run status `GATE_FAILED`, nothing published |
| `FREEZE_EARLY` | gate | `predict_live.publish`: `current.json`, write-once snapshots at T |
| `WRITE_STATE` | freeze | exactly-once state (section 6) |
| `MARKET_COMPARISON` | freeze | after the pure projection only: `v2.shadow` and the decision layer |
| `GRADE_PREVIOUS`, `RESEARCH` | ingest | the previous week's graded results (Model Lab), research items (section 8) |
| `MODEL_LAB` | freeze | checks the lab imported the freeze; the freeze workflow dispatches the lab |
| `REPORT` | – | `reports/week_NN.{json,md}` |

The run table's summary columns (`score_ingestion_status`, `pbp_status`, `drive_status`, `player_status`,
`opponent_adjustment_status`, `team_rating_status`, `projection_status`, `market_status`,
`model_lab_status`) are each the worst status of their stages (`runlog.STAGE_GROUPS`).

**Errors.** `runlog.classify_error` maps an exception to `TRANSIENT`, `RATE_LIMIT`, `AUTH`, `SCHEMA`,
`DATABASE`, `DATA_QUALITY` or `UNKNOWN`. Only `TRANSIENT` and `RATE_LIMIT` are retried: 4 attempts, backoff
2, 4, 8 s. A schema or data-quality error is permanent and never retried.

## 3. The release gate (`gate.py`)

Published only if every critical check holds:

1. every critical stage (`CRITICAL_STAGES`) is `OK`, `WARN` or `SKIPPED`;
2. no critical data source failed (`sources.health`);
3. data errors ≤ 5% of the source week's in-scope finals (`MAX_DATA_ERROR_SHARE`);
4. the opponent adjustment converged for every metric;
5. no leakage test failed;
6. the artifact verified against its MANIFEST;
7. every critical run-level sanity check passes:
   - no team projected in two games of the week, none home and away in one game, no duplicate games;
   - no invalid team id;
   - feature time < kickoff for every game, and every feature snapshot is as of T;
   - team state uses only games before T;
   - no extreme rating move without an explanation;
   - no market column among the model's inputs.
8. game-level checks withhold games, not weeks. A game whose win probability is not strictly inside (0, 1),
   whose spread, sigma or total is not finite (or sigma ≤ 0), or whose total is outside [10, 120] or margin
   beyond ±75 is **withheld**: not published, not recorded as a projection, named in the run. The week is held
   only if more than 5% of its games are withheld (`MAX_WITHHELD_SHARE`). A projected margin larger than the
   projected total (negative implied points for one team: the separately modelled total is incoherent in a
   lopsided mismatch: 3 of 11,262 walk-forward rows — Clemson–The Citadel and BYU–North Alabama 2020, Ohio
   State–Ball State 2026 — and, under the frozen artifact, LSU–SE Louisiana 2025, which held a replayed week before
   this rule)
   withholds only that game's **total**: the spread publishes, the total is null with the reason.

An expected-starter QB state older than 21 days is a non-critical warning.

A failed gate leaves the previous valid state standing: nothing is written to `current.json`, the snapshots
or the state files. The run record (status `GATE_FAILED`, the failed checks) is still appended.

## 4. Projection (`project.py`)

**The artifact.** `artifacts/edgedesk_cfb_v2.1.0/` with `MANIFEST.json` (sha256 of every file). `verify_artifact`
recomputes the hashes; a mismatch is `FALLBACK` (nothing published; V1 remains the champion's board). The
engine never fits: submodels, stack weights (0.5 ridge + 0.5 GBM), the Gamma-GLM sigma model, `t_df = 100`,
the win calibration (`raw`) and the cover calibration (Platt) are applied as frozen.

**Inputs.** `model_inputs(A)`: every column the submodels and the sigma model read.
`assert_no_market_inputs` refuses any input whose name is a market column (`close_margin`, `open_margin`,
`over_under`, `total_open`, `total_close`, `line_move`, ...) or contains a market token (`spread`,
`moneyline`, `ml`, `price`, `odds`, `book`, `market`, `vig`, `clv`, ...), matched as whole `_`-separated
tokens so `edge_line_yds` is not a false positive.

**Feature snapshots.** One per game and T: `feature_snapshot_id = 'cfbf_' + h(game_id, T, feature_version,
input_hash)`, with `input_hash` the content hash of the inputs after the artifact's own derivations. Written
once (`upcoming_game_features/week_NN.jsonl`).

**Inference** (`infer`) is `predict_live.predict` plus the stored extras:
- raw and calibrated home win probability, and the calibration method;
- `expected_model_error = sigma · √(2/π)`, the expected absolute error of a normal with that SD;
- 50 / 80 / 95% intervals at the t quantiles with `t_df` degrees of freedom;
- `directional_agreement`: every submodel has the same sign;
- the ensemble SD.

**Projection records.** `projection_id = 'cfbj_' + h(game_id, feature_version, input_hash, model_version)`,
so an unchanged input makes no new projection (cost control; no contradictory duplicates).

**Change attribution.** A new projection for a game already projected carries a change record
(`projection_changes.jsonl`). Its `projection_change_reason` holds:
- the exact ridge contribution differences (coefficient × input change, per input);
- the GBM's TreeSHAP differences (`pred_contrib=True`), stacked with the approved weights;
- both grouped by feature family (efficiency ratings, QB, Elo, schedule and rest, travel, priors and
  talent, special teams, pace).

The families sum to the total move up to the GBM's float rounding.

**Guardrails.** A projection moving more than 9.0 points after new games, or more than 3.0 points with no
new game, is flagged `PROJECTION_MOVE_REVIEW` with its top three drivers. A team rating move beyond the
historical p99.5 for its point in the season is flagged by the state layer with its decomposition. Nothing
is clamped.

## 5. Degraded modes

`model_mode(team_pbp_quality, availability_status, has_market, artifact_ok)`, per game, worst first:

| mode | trigger | reliability cap |
|---|---|---|
| `FALLBACK` | artifact failed to verify | 0: nothing published |
| `DEGRADED_PBP` | the weaker team's mean `pbp_completeness_score` over its games before T < 0.9 | 60 |
| `DEGRADED_AVAILABILITY` | the availability source is STALE / DEGRADED / MISSING | 75 |
| `DEGRADED_MARKET` | no market line for the game | 100 (the pure projection is unaffected; the betting layer has nothing to compare) |
| `FULL` | otherwise | 100 |

`reliability_effective = min(reliability, cap)`. The mode travels with the published row (`current.json`),
the projection record and the Model Lab snapshot.

## 6. State (`store.py`)

Each state kind has a natural key:
- team week: team, season, week, feature version;
- QB week: player, team, season, week, feature version;
- unit week: team, season, week, unit, rule;
- game validation: game, rule;
- game performance: game, team, rule.

`write_versioned` writes a key once. A later run with identical content (provenance fields excluded) writes
nothing. Different content, after a provider correction, is written as `state_version + 1`, with
`supersedes` naming the previous id and a reason. Nothing is overwritten.

`current(kind)` returns the highest version per key. Write-once facts (runs, projections, changes, QB events,
research items) use `append_unique` on their id. The Postgres mirror (`supabase/cfb_weekly.sql`) enforces
the same keys and refuses updates and deletes by trigger.

## 7. Availability (`availability.py`)

A player's status comes from the official reports published before the run (`published_at ≤ now`). The
status maps to a play probability: ACTIVE / AVAILABLE 1.0, PROBABLE 0.85, QUESTIONABLE / GAME-TIME DECISION
0.5, DOUBTFUL 0.2, OUT / SUSPENDED / TRANSFERRED / OUT FOR SEASON 0.0, and OUT FIRST HALF counts as 0.5 of the
game.

A team with no report is `UNKNOWN`: it is not healthy, and it is reported as missing information. Positions
map to eight units (QB, OL, WR_TE, RB, DL, LB, DB, ST). Reports exist for 2026 conference games only. The
availability state is informational in V2.1: the frozen model does not read it. The personnel system
(`docs/cfb-personnel/`) turns it into lineup deltas as a challenger.

## 8. Research items (`research.py`)

These are patterns of repeated failure: first-time starting QBs, QB changes, big favorites, early season,
high submodel disagreement, and others. Each pattern is scored on residuals oriented to the side it concerns.

The evidence comes in two kinds that are never pooled:
- `BACKTEST_DEV`: walk-forward out-of-fold predictions for 2016–2023; the holdout is never mined.
- `LIVE`: the season's frozen predictions graded against finals.

A pattern becomes a `RESEARCH` item when n ≥ 50 and |mean| / se ≥ 2. A new row is appended only when the
evidence has grown by 25 observations, so the queue shows how the evidence accumulated. On the development
backtest no pattern reaches |z| ≥ 2 today. Nothing here changes production.

## 9. Source health (`sources.py`)

Each source is HEALTHY, STALE, DEGRADED, MISSING, NOT_CONFIGURED or NOT_USED_BY_MODEL. The record carries
its version, freshness against a bound, coverage and error rate.

| source | freshness bound | health rule |
|---|---|---|
| schedule | – | games due (kickoff more than 36 h before) without a result: 0 → HEALTHY, < 5% → STALE, else DEGRADED |
| roster | 8 days | – |
| qb_status | 36 h | – |
| market | 6 h | from the Model Lab's last quote |
| pbp | – | play-by-play coverage of the finals |
| injury | – | report freshness and team coverage |
| weather | – | the forecast file's age |

A source blocks the gate (`critical_failures`) only when it is critical, MISSING, and read by the pure
model. Of all the sources, only the play-by-play, schedule, talent and returning production feed the pure
model. The artifact is checked separately, against its MANIFEST.
