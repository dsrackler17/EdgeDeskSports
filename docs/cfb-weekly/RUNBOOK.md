# CFB weekly learning and rating refresh engine — runbook

Design: [`DESIGN.md`](DESIGN.md). Exact methods: [`METHODS.md`](METHODS.md). Replay evidence:
[`REPLAY.md`](REPLAY.md).

The engine updates **what teams currently are** every week. It never refits the model. The architecture,
hyperparameters, features, calibration and ensemble live in a frozen, manifested artifact
(`football/cfb_v2/artifacts/edgedesk_cfb_v2.1.0/`) and change only through a challenger.

## Operational schedule (UTC, August–January)

| when | mode | clock | what happens |
|---|---|---|---|
| Sun 10:05 | `weekly` | pg_cron `cfb_weekly_sunday` (GitHub backup) | finalize the source week: verify finals, validate PBP, performance, opponent adjustment, team/QB/unit state, provisional next-week projections |
| Mon 10:05 | `weekly` | pg_cron `cfb_weekly_monday` | the same, after Monday games and weekend PBP corrections (a no-op if nothing changed) |
| Tue 12:07 | `freeze` | pg_cron `cfb_weekly_freeze` (GitHub 12:17) | the EARLY freeze at the 12:00 instant (write-once), market comparison, Model Lab hand-off |
| Wed–Sat 10:47 | `daily` | pg_cron `cfb_weekly_daily` | refresh availability / QB / schedule; a new football projection only if football inputs changed |
| hourly | — | `cfb-lab.yml` | market snapshots and the lab's checkpoint snapshots (MIDWEEK T48, OFFICIAL T24, FINAL) |
| after kickoff + 3 h | — | `cfb-lab.yml` | settlement and grading; the next Sunday run reads the grades |

Why Tuesday 12:00: it is the validated as-of instant of the backtest (`common.prediction_ts_for_kickoff`),
and it comes after Monday-night games, which a Monday freeze would miss.

## Running it

```
cd football/cfb_v2/research
export CFB_V2_DATA=$PWD/data CFB_V2_OUT=$PWD/out
python3 -m v2.weekly.run --mode weekly               # now; fetches, runs, gates, publishes
python3 -m v2.weekly.run --mode daily --no-fetch     # reuse the local data
python3 -m v2.weekly.run --mode freeze --now 2026-09-29T12:07:00Z
python3 -m v2.weekly.run --mode rebuild --season 2024 --through-week 8 --state-root /tmp/rebuild
python3 -m v2.weekly.replay --season 2024            # the shadow replay test (REPLAY.md)
python3 -m v2.weekly.tests_weekly                    # orchestration suite (+ tests_games, tests_state)
```

The workflow is `.github/workflows/cfb-v2-shadow.yml` (dispatch with `mode`). One concurrency group,
plus an exclusive file lock inside the run (`$CFB_V2_OUT/.weekly.lock`): two runs never write state at once.

## What a run records

Every run appends one record to `football/cfb_weekly/<season>/runs.jsonl` (mirrored to `cfb_pipeline_runs`)
and writes its full manifest to `runs/<run_id>.json`: every stage's status (OK / WARN / FAILED / BLOCKED /
SKIPPED), timing, counts, warnings, classified errors, the data version and every source version, and the
release gate's checks. `run_key` names the work (season, weeks, versions, data version, mode); a second run of
already-published work is a no-op. `--force` re-runs it.

## Stage failures and what to do

| status | meaning | action |
|---|---|---|
| `GATE_FAILED` | the pipeline ran but a gate check failed; **nothing was published** and the previous valid state stands | read `runs/<run_id>.json` → `gate.failed`; fix the cause; re-dispatch |
| a stage `FAILED` with class `TRANSIENT` / `RATE_LIMIT` | a feed was down; retried with backoff and still failed | re-dispatch later; the previous state stands |
| class `SCHEMA` | a provider changed a column; never retried | fix the reader; add a test |
| class `DATA_QUALITY` | e.g. data errors above the bound, a posterior not finite | inspect `game_validation.jsonl` for the week |
| `LOCKED` | another run holds the lock | wait for it; never delete a lock another run holds |
| `WARN` | partial data (a game not final after 36 h, a partial PBP, no availability report) | informational; the report lists them |

## Degraded modes (`model_mode` on every projection)

`FULL` · `DEGRADED_PBP` (a team's play-by-play is incomplete: reliability capped at 60) ·
`DEGRADED_AVAILABILITY` (availability feed stale or missing: capped at 75) · `DEGRADED_MARKET` (no market
line: the pure projection is unaffected; the betting layer has nothing to compare) · `FALLBACK` (the artifact
failed to verify: nothing is published; V1 stays the champion's board). A degraded projection never shows the
same reliability as a full one, and the mode travels with the published row into `current.json` and the Model
Lab.

## Football updates vs market updates

The pure projection changes only when football inputs change (new games, a PBP correction, a schedule or
venue change; from the personnel system on, confirmed lineup changes). Each change is a new projection record
with a change record explaining it (`projection_changes.jsonl`: exact ridge contributions + GBM TreeSHAP
differences, grouped by feature family). A sportsbook moving from −110 to −115 changes nothing here; it is
the Model Lab's hourly market snapshot and the betting layer's job. An unchanged input hash makes no new
projection (cost control and no contradictory duplicates).

Guardrails: a projection moving more than 9.0 points with new games, or 3.0 points without any, is flagged
`PROJECTION_MOVE_REVIEW` with its drivers; a team rating move beyond the historical p99.5 is flagged with its
decomposition. Nothing is clamped silently.

## Retraining policy

| cadence | what | how |
|---|---|---|
| **weekly** | team state, QB state, unit state, recent form, opponent adjustment, projections | this engine; no model parameter changes |
| **offseason (Feb–July)** | submodel refit, ensemble weights, sigma model, calibration, reliability range, rating hyper-parameters | `cfb-v2-shadow.yml` `mode=retrain` with `challenger_version=<id>`: a full walk-forward on the new season's data, as a **challenger** |
| **midseason** | not allowed in production | V2's validation is walk-forward with annual refits; a midseason refit was never validated. Research only. |
| **trigger for an extra offseason review** | drift alerts sustained for 3+ weeks (Model Lab), or 150+ new common official games | as above |

A retrain **never** overwrites the champion or the production artifact: `export.py` refuses a directory with
a `MANIFEST.json`, a challenger's browser params stay in its own artifact directory, and the CI retrain uploads
its output for review instead of committing it. To shadow a challenger prospectively: commit its artifact
with a MANIFEST, register it in the Model Lab as `candidate` (`node football/cfb_lab/governance.js
experiment ...`), and add it to the lab's tracked models. Promotion follows the Model Lab's gates and a
person's `governance.js promote`.

## Historical rebuild and replay

`--mode rebuild --season S --through-week N` reconstructs the state exactly as of the freeze instant after week
N, using only games that kicked off before it, into a separate state root (never the live ledger). `v2.weekly.replay`
does that week by week for a whole season and proves the incremental pipeline reproduces the batch
point-in-time features, that perturbing any future game changes nothing, and that a re-run is identical
(REPLAY.md holds the latest results).

## Season rollover

January games belong to the season that began in August (`season_for`). The live season constant
(`v2/config.py LIVE_SEASON`) changes only with a governed release before the next August.
