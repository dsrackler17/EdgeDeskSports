# CFB weekly learning engine: final deliverable

What was built for the weekly model refresh brief, item by item (§65). Code lives in
`football/cfb_v2/research/v2/weekly/`. The method documents hold the detail; this page says what exists, where
it is, and what it does not do.

One sentence: every week, each team's posterior from last week becomes this week's prior. The new games update
it, weighted by opponent and by how sustainable the performance was. The frozen V2.1 model
(`edgedesk_cfb_v2.1.0`) then projects the next week at Tuesday 12:00 UTC, before the market has settled.
No model weight, feature, calibration or ensemble weight changes during the season.

| # | item | where | what it is |
|---|---|---|---|
| 1 | weekly pipeline architecture | [DESIGN.md](DESIGN.md), [METHODS.md §1–2](METHODS.md) | `run.run()`: 25 explicit stages (INGEST_FINAL_SCORES → HEALTH_REPORT), each OK / WARN / FAILED / BLOCKED / SKIPPED. A failed critical stage blocks everything downstream, and the release gate decides publication |
| 2 | database migrations | `supabase/cfb_weekly.sql` (SQL bundle file 4) | 14 tables: pipeline runs, stage log, game validation, game performance, team / QB / unit week state, QB events, upcoming features, weekly projections, projection changes, research, source health, misses. It also adds 2 views and `cfb_weekly_poke()` with its pg_cron jobs. Append-only triggers; RLS (authenticated read, anon none). Mirrored by `football/cfb_weekly/sync_supabase.js` |
| 3 | pipeline-run tracking | `runlog.py` (`PipelineRun`), `store.py` | One record per run in `runs.jsonl` (→ `cfb_pipeline_runs`) plus a full manifest, `runs/<run_id>.json`. The manifest holds stage status, timing, counts, warnings, classified errors, every source version, the data version and the gate checks. `run_key` names the work, so re-running published work is a no-op |
| 4 | game / PBP validation | `validate.py`, [METHODS_GAMES §1](METHODS_GAMES.md) | Finality rules (first match wins); PBP checks on final games (score reconciliation, play counts, clock, duplicates); status (FINAL_VALIDATED / FINAL_PARTIAL_DATA / …) and a completeness score. `in_scope` = a game with an FBS team |
| 5 | game-performance calculations | `perf.py`, `gamestate.py`, [METHODS_GAMES §2–3](METHODS_GAMES.md) | Play context (rule `cfb_gamestate_v1`: garbage time, competitive plays), then per team-game non-garbage EPA, success, explosives, havoc, line yards, field position and finishing |
| 6 | expected-performance system | `perf.py`, artifact `artifacts/weekly/expected_margin_v1.json`, [§3.3](METHODS_GAMES.md) | The expected margin a team's play earned, from the frozen `cfb_expected_margin_v1` coefficients; compared with the scoreboard margin in the report |
| 7 | turnover-luck update | `perf.py`, [§3.4](METHODS_GAMES.md) | Fumble recoveries and interceptions against expectation, in points. `turnover_luck_game` per game and a season index; it feeds the report and miss classification, never the model |
| 8 | drive update | `perf.py`, [§3.6](METHODS_GAMES.md) | Points per drive, points per opportunity, start field position and three-and-outs, per team-game |
| 9 | player / QB update | `qb_state.py`, [METHODS_STATE §11](METHODS_STATE.md) | QB week state: starter probability, share, rating and its uncertainty. Change events: NEW_STARTER, BENCHING, INJURED_STARTER, TRANSFER_STARTER, RETURNING_STARTER, MULTI_QB_ROTATION, AMBIGUOUS_STARTER. An ambiguous starter is a WARN, never a guess |
| 10 | unit-health update | `availability.py`, [METHODS §7](METHODS.md) | Unit health from official availability reports; UNKNOWN is never read as healthy. Coverage is thin: 14 of 118 teams in the example run. The player-level unit values (personnel P3) are a separate system, still in progress, and not wired into this engine |
| 11 | team posterior system | `team_state.py`, [METHODS_STATE §9](METHODS_STATE.md) | V2's opponent-adjusted ratings at the freeze instant, in points, with SDs. Stored per team-week, so last week's posterior is this week's prior |
| 12 | opponent-adjustment implementation | V2 stage 3 (`v2.build_ratings`), convergence record in [METHODS_STATE §2](METHODS_STATE.md) | Every metric solved against opponents with games before T; convergence is recorded per metric, and the gate refuses a run that did not converge |
| 13 | prior decay | [METHODS_STATE §5](METHODS_STATE.md) | V2's validated preseason-prior weighting, unchanged. The weekly engine records how much prior is left per team (accounting only); changing the decay is planned experiment EXP-003, not a weekly action |
| 14 | recent-form update | [METHODS_STATE §4](METHODS_STATE.md) | Recency-weighted form (half-life `RECENT_HALFLIFE_WEEKS`) and trend flags. Descriptive only: flags are never model inputs |
| 15 | volatility update | [METHODS_STATE §4](METHODS_STATE.md) | V2's `vol`, recomputed each week from games before T, plus a shrunk `residual_volatility` over the last 4 games. VOLATILITY_RISING fires at z > 2 with at least 6 games |
| 16 | upcoming-game feature builder | `project.py` `model_inputs`, [METHODS §4](METHODS.md) | The target week's V2.1 inputs, built point-in-time from the same stages as the backtest (replay proves they are identical) |
| 17 | submodel inference flow | `project.py` `infer` | C_ridge and D_gbm from the frozen artifact, verified against `MANIFEST.json` before use |
| 18 | ensemble flow | `project.py` | The frozen 0.5 / 0.5 stack |
| 19 | uncertainty generation | `project.py`, `v2` sigma model | Per-game sigma from the frozen Gamma GLM (`sigma_design`), with Student-t df = 100. The report lists high-uncertainty games with their drivers |
| 20 | calibration flow | `project.py` | Frozen win calibration (raw) and cover calibration (conditional Platt). Not refit weekly |
| 21 | early prediction freeze | FREEZE_EARLY stage, `store.py` | The EARLY freeze at Tuesday 12:00 UTC is write-once: a projection id hashes its inputs, and a frozen row is never rewritten |
| 22 | market comparison | MARKET_COMPARISON stage | Compares the frozen projection with the market after the freeze; the market never enters the projection. Replay perturbs the market file and shows no change |
| 23 | midweek / final update rules | [RUNBOOK: football vs market updates](RUNBOOK.md) | `daily` mode (Wed–Sat) makes a new projection record only when football inputs change, each with a change record by feature family. A price move changes nothing here. Moves over 9.0 pts (3.0 pts with no new games) are flagged `PROJECTION_MOVE_REVIEW` |
| 24 | automatic previous-week grading | GRADE_PREVIOUS stage | Reads the Model Lab's grades of OFFICIAL LIVE predictions (MAE, RMSE, Brier, CLV, ATS) |
| 25 | miss classification | `misses.py`, rule `cfb_miss_classification_v1` | Misses of 14 pts or more are split into performance gap + scoreboard gap, with a data-based driver: TURNOVER_LUCK, SPECIAL_TEAMS, SCOREBOARD_OTHER, QB_CHANGE, PERSONNEL, EXPLOSIVE_VARIANCE, TEAM_PERFORMANCE, PACE or UNEXPLAINED. Stored append-only (`cfb_weekly_misses`); an LLM never labels a miss |
| 26 | research queue | `research.py`, [METHODS §8](METHODS.md) | A pattern becomes a research item only at n ≥ 50 and \|z\| ≥ 2. Items are hypotheses for the offseason challenger, never automatic changes |
| 27 | retraining policy | [RUNBOOK: retraining policy](RUNBOOK.md) | Weekly: state only. Offseason: a full walk-forward refit as a challenger. Midseason: not allowed in production |
| 28 | challenger creation policy | [RUNBOOK](RUNBOOK.md), `cfb-v2-shadow.yml mode=retrain` | A retrain writes a new version id and never overwrites the champion (`export.py` refuses a directory with a MANIFEST). A person promotes through `governance.js` |
| 29 | source-health monitoring | `sources.py`, [METHODS §9](METHODS.md) | Per source (schedule, PBP, roster, injury, QB status, market, weather): status, freshness and coverage; stored in `cfb_source_health` |
| 30 | degraded-mode behavior | [METHODS §5](METHODS.md), [RUNBOOK](RUNBOOK.md) | `model_mode` on every projection: FULL, DEGRADED_PBP (reliability ≤ 60), DEGRADED_AVAILABILITY (≤ 75), DEGRADED_MARKET, FALLBACK (nothing published) |
| 31 | scheduled jobs | `supabase/cfb_weekly.sql` pg_cron + `.github/workflows/cfb-v2-shadow.yml` | pg_cron is the primary clock, dispatching the workflow through `cfb_weekly_poke`; GitHub's own schedule is the backup. See item 39 |
| 32 | concurrency protections | `runlog.RunLock`, workflow `concurrency: cfb-v2-shadow` | One workflow concurrency group plus an exclusive non-blocking file lock (`$CFB_V2_OUT/.weekly.lock`). A second run exits LOCKED |
| 33 | retry / error handling | `runlog.retry`, `runlog.classify_error` | Errors are classed TRANSIENT, RATE_LIMIT, DATA_QUALITY, AUTH, SCHEMA, DATABASE or UNKNOWN. Only TRANSIENT and RATE_LIMIT retry: 4 attempts with exponential backoff |
| 34 | weekly release gate | `gate.py`, [METHODS §3](METHODS.md) | Critical checks: pipeline, sources, data errors ≤ 5 %, convergence, leakage, artifact verification, sanity. Game-level checks withhold a game (WITHHOLD_GAME) or its total (WITHHOLD_TOTAL), up to 5 % of the week. A failure publishes nothing, and the previous state stands |
| 35 | historical rebuild capability | `--mode rebuild --season S --through-week N` | Rebuilds state as of any past freeze instant into a separate state root |
| 36 | historical replay test results | `replay.py`, [REPLAY.md](REPLAY.md) | 2025 weeks 3, 7 and 11 all **PASS**: ratings, QB, Elo, every model input, engine projections and team state are identical to the batch world at 1e-9; re-runs are no-ops. Three weeks were replayed, not a whole season |
| 37 | tests added | `tests_weekly.py` (63 fast), `tests_games.py` (102), `tests_state.py` (98), `football/cfb_weekly/sql.test.js` (31, real Postgres) | CI: `.github/workflows/cfb-weekly-tests.yml` |
| 38 | files / functions changed | see below | |
| 39 | exact operational schedule | [RUNBOOK](RUNBOOK.md) | Sun 10:05 and Mon 10:05 `weekly`; Tue 12:07 `freeze` (GitHub backup 12:17); Wed–Sat 10:47 `daily`; hourly Model Lab market snapshots; settlement 3 h after kickoff. All UTC, August–January |
| 40 | example completed weekly run | [example/](example/README.md) | 2026 week 4 → 5 on live data: PUBLISHED, gate PASS, 25/25 stages, 59 games, 29 intended warnings |

## Files

In `football/cfb_v2/research/v2/weekly/`:
- `run.py`: the orchestrator; stage functions `ingest` … `report`, `weeks_for`, `season_for`;
- `runlog.py`: `PipelineRun`, `RunLock`, `StageError`, `retry`, `classify_error`, `single_thread_blas`;
- `store.py`: exactly-once state store; `ids.py`: deterministic ids;
- `gate.py`: `check`, `sanity`, `release_gate`;
- `validate.py`, `gamestate.py`, `perf.py`;
- `team_state.py`, `qb_state.py`, `availability.py`;
- `project.py`: `model_inputs`, `infer`, `projection_records`;
- `sources.py`, `research.py`, `misses.py`;
- `report.py`: `weekly`, `markdown`, `_perf_table`, `_qb_changes`;
- `replay.py`: `build_world`, `batch_world`, `compare_week`, `replay_week`;
- tests: `tests_weekly.py`, `tests_games.py`, `tests_state.py`.

Elsewhere:
- `supabase/cfb_weekly.sql`;
- `football/cfb_weekly/{sync_supabase.js, sql.test.js}`;
- `.github/workflows/{cfb-v2-shadow.yml, cfb-weekly-tests.yml}`;
- docs in `docs/cfb-weekly/`;
- V2 hooks (default off, output-identical) in [METHODS_STATE §1](METHODS_STATE.md).

## Known limits (stated, not hidden)

- **Availability coverage is thin.** 14 of 118 teams in the example run; every game ran `DEGRADED_AVAILABILITY`.
- **Special teams.** FBS special-teams priors are floored and do not update in-season. This is a research item for
  the next challenger.
- **QB baseline speed.** V2's `qb_team_rating` baseline absorbs a new starter 4–6× faster than the ratings do.
  This is noted for the next retrain, not changed here.
- **Determinism.** Rating solves are bit-reproducible only with single-threaded BLAS. Every entry point re-execs
  itself with one thread.
