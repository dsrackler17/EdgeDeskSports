# CFB Weekly Learning and Rating Refresh Engine — design contract

The weekly engine turns the latest completed college football games into updated team state, QB state,
uncertainty, opponent-adjusted metrics and the next week's pure projections, then freezes them before the
market is compared. It is **state updating, not retraining**: the model's architecture, hyperparameters,
features, calibration and ensemble are frozen in a versioned artifact (`edgedesk_cfb_v2.1.0`) and change
only through a challenger (see *Retraining policy*).

It is built **around the pipeline that won validation**, not beside it. V2.1's point-in-time pipeline
(`football/cfb_v2/research/v2`) already computes opponent-adjusted Gaussian posteriors per metric at every
freeze time, QB features, pace, drive metrics, matchup edges and the frozen-artifact projection. The weekly
engine runs those same computations as tracked, gated stages, and adds what was missing: validation, run
tracking, explicit state tables, turnover luck, expected performance, a convergence record, prior-decay
accounting, change attribution, a release gate, source health and degraded modes, historical rebuild and
replay.

## Layout

```
football/cfb_v2/research/v2/weekly/     the engine (Python, runs inside the V2 environment)
  ids.py         deterministic ids + canonical hashes (same rendering as the Model Lab, SCHEMA rule 4)
  runlog.py      PipelineRun: stages, statuses, counts, structured logs, error classes, retries, lock
  sources.py     data versions (content hashes) and source health
  validate.py    game finality + play-by-play validation (-> game_validation)
  gamestate.py   play context classes (versioned rule)
  perf.py        game performance objects, expected performance margin, turnover luck,
                 explosive dependency, drive metrics (season + recency)
  team_state.py  team posteriors on the points scale, convergence record, prior decay,
                 recent form, volatility, special teams, FCS, home field, explanations, movement
  qb_state.py    QB week state and QB change detection
  availability.py availability snapshot, unit-health state, freshness
  project.py     upcoming features, pure inference with the frozen artifact, calibration,
                 uncertainty, change attribution, guardrails
  gate.py        sanity checks and the weekly release gate
  research.py    evidence-gated research items -> Model Lab research queue
  report.py      the internal weekly refresh report
  run.py         the orchestrator (CLI)
  replay.py      historical rebuild and the shadow replay test
  tests_weekly.py  the suite

football/cfb_weekly/<season>/           committed state (JSON Lines, append-only, versioned)
  runs.jsonl                 one record per pipeline run (cfb_pipeline_runs)
  runs/<run_id>.json         full manifest: stage logs, counts, warnings, errors, versions
  game_validation.jsonl      per game (versioned; a correction supersedes)
  game_performance.jsonl     per team-game performance object
  team_week_state.jsonl      per team x week x feature_version (exactly once; corrections versioned)
  qb_week_state.jsonl        per QB x team x week
  unit_week_state.jsonl      per team x week x unit
  upcoming_game_features/week_NN.jsonl   write-once feature snapshots (model inputs + hash)
  projections.jsonl          every published pure projection (write-once per game x input hash)
  projection_changes.jsonl   why a projection moved (attribution)
  source_health.json         the latest source status
  reports/week_NN.{json,md}  the weekly refresh report
docs/cfb-weekly/DESIGN.md, RUNBOOK.md, METHODS.md
supabase/cfb_weekly.sql      tables + pg_cron dispatch
.github/workflows/cfb-v2-shadow.yml    runs the engine (modes: weekly | daily | freeze | rebuild | retrain)
```

## Ids and versions

- `h(*parts)` = first 24 hex of sha256 of the parts rendered and joined with `|` (None → '', numbers →
  shortest decimal, timestamps → `YYYY-MM-DDTHH:MM:SS.sssZ`, booleans → true/false). Identical to the lab.
- `run_key = h('run', season, source_week, target_week, model_version, feature_version, data_version, mode)`
  names the *work*; `run_id = 'cfbw_' + h(run_key, started_at)` names one *execution*. A run whose
  `run_key` already PUBLISHED is a no-op unless `--force` (idempotency).
- `data_version = h(pbp_version, schedule_version, market_version, roster_version, injury_version,
  talent_version, retprod_version)`; each is the sha256 of the source file(s) it names (sources.py).
- `state_id = 'cfbs_' + h(team_id, season, week, feature_version, state_version)`. `state_version` starts
  at 1 and increments only when a published row's content would change (a provider correction); the new
  row carries `supersedes` and `reason`. An unpublished row from a failed run may be replaced.
- Every state row carries `model_version, feature_version, data_version, pbp_version, roster_version,
  injury_version, run_id, as_of` (the prediction timestamp T).

## Weeks and time

`T` = the model's freeze instant for the target week: `common.prediction_ts_for_kickoff` (Tuesday 12:00
UTC). The source week's state is the posterior from every game that kicked off before `T`. This is the
validated as-of convention; Monday-night games are included because the freeze is Tuesday.

## Stages (explicit status: OK | WARN | FAILED | SKIPPED | BLOCKED)

| # | stage | module | fails the run when |
|---|---|---|---|
| 1 | VERIFY_COMPLETED_GAMES | validate | a source-week game has no final status after the grace period, or sources disagree |
| 2 | INGEST_FINAL_SCORES | V2 plays/games | the schedule file is missing or stale beyond its bound |
| 3 | VALIDATE_PBP | validate | a DATA_ERROR share above the bound (then the run is BLOCKED, not published) |
| 4 | GAME_PERFORMANCE | perf | — (WARN on partial data) |
| 5 | DRIVE_METRICS | perf | — |
| 6 | PLAYER_QB_METRICS | qb_state | QB state cannot be built |
| 7 | AVAILABILITY_STATE | availability | never (degrades to DEGRADED_AVAILABILITY) |
| 8 | OPPONENT_ADJUSTMENT | V2 build_ratings (+ convergence) | any metric fails to converge |
| 9 | TEAM_POSTERIORS | team_state | a team is missing, or a posterior is non-finite |
| 10 | RECENT_FORM | team_state | — |
| 11 | UNCERTAINTY | team_state + project | — |
| 12 | UPCOMING_FEATURES | V2 snapshots + project | a scheduled game has no feature row |
| 13 | PURE_SUBMODELS | project | the artifact hash does not verify |
| 14 | ENSEMBLE | project | — |
| 15 | CALIBRATION | project | — |
| 16 | FREEZE_EARLY | V2 predict_live.freeze | freeze attempted before T or after kickoff |
| 17 | MARKET_COMPARISON | V2 shadow + decisions | never (DEGRADED_MARKET) |
| 18 | MODEL_LAB | hand-off (dispatch the lab; verify the last freeze was imported) | never |
| 19 | HEALTH_REPORT | report + gate | — |

Plus GRADE_PREVIOUS (reads the Model Lab's graded evaluations for the source week, runs `learn_week` miss
classification) and RESEARCH (evidence-gated patterns → the lab's research queue).

A stage never runs against a failed upstream stage: the orchestrator marks it BLOCKED. The RELEASE GATE
runs before anything is published; on failure the previous valid `current.json` and state stay in place
and the run is recorded as GATE_FAILED with its reasons.

## Modes and schedule (UTC, August–January)

| when | mode | what |
|---|---|---|
| Sun 10:05, Mon 10:05 | weekly | finalize the source week, validate, state, provisional projections (PROVISIONAL rows) |
| Tue 12:07 | freeze | the EARLY freeze at T (write-once snapshot), market comparison, lab hand-off |
| daily 10:47 | daily | refresh availability / QB / schedule; a new football projection only when football inputs changed |
| on demand | rebuild | historical state through week N using only what was known then |
| offseason | retrain | a NEW challenger version (never overwrites the champion or the production artifact) |

pg_cron dispatches `cfb-v2-shadow.yml` (primary clock); GitHub's schedule is the backup. One concurrency
group; a file lock inside the run.

## Module contracts (what each returns)

- `validate.validate_games(season, now, source_week=None) -> DataFrame` one row per game: `game_id, season,
  week, status (FINAL_VALIDATED|FINAL_PARTIAL_DATA|POSTPONED|CANCELED|DATA_ERROR|SCHEDULED|IN_PROGRESS),
  home_points, away_points, overtime, periods, pbp_plays, pbp_completeness_score (0-1), checks {name: ok},
  issues [..], pbp_score_home, pbp_score_away, score_reconciles, validated_at, rule_version`.
- `gamestate.classify(plays) -> Series` of `COMPETITIVE|LOW_LEVERAGE|GARBAGE|CLOCK_KILL|DESPERATION`
  (rule `cfb_gamestate_v1`); production weights stay V2's (garbage 0, all else 1).
- `perf.game_performance(season, T=None) -> DataFrame` per team-game: offense/defense/special-teams
  metrics raw and filtered, `expected_performance_margin`, `scoreboard_overperformance`, turnover and
  explosive components. `perf.team_summary(season, T) -> DataFrame` per team: `turnover_luck_index,
  explosive_dependency_score, drive_* (season, recency), performance_margin, scoreboard_margin,
  close_game_record, record`.
- `team_state.build(season, T, prev=None) -> (rows DataFrame, convergence dict, explanations dict)`:
  `overall_mean/sd, offense_mean/sd, defense_mean/sd, st_mean/sd, pass_off_mean/sd, rush_off_mean/sd,
  pass_def_mean/sd, rush_def_mean/sd` (points per game vs an average FBS team, neutral field),
  `season_strength, recent_strength, recent_minus_season, volatility, prior_weight_*, hfa, fcs, trend
  flags, lineup_context`.
- `qb_state.build(season, T) -> (qb rows, events)`: per QB `expected_starter, starter_probability,
  career_starts, season_starts, recent_attempts, adj_epa_db, success_rate, sack_rate, rush_contribution,
  explosive_pass_rate, turnover_proxy, posterior_value, posterior_sd`; events `NEW_STARTER, RETURNING_STARTER,
  INJURED_STARTER, BENCHING, TRANSFER_STARTER, MULTI_QB_ROTATION, AMBIGUOUS_STARTER`.

Every numeric output is finite or explicitly null with a reason; nothing is invented.
