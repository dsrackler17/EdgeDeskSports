# Research Grade: runbook

## Where it runs

Inside the existing hourly **Model performance** job
(`.github/workflows/performance.yml`, `:19` every hour). No new workflow, no
new secret, no paid service. Each run, after the forecast capture:

1. `RG.snapshot` grades every upcoming game and appends changed grades to
   `performance/ledger/research_grades/`;
2. after results and grades, `RG.settle` appends outcomes to
   `performance/ledger/grade_outcomes/`;
3. `grade_build.js` rewrites `performance/data/grades/` (live, live detail,
   game files, summary); its health items join `performance/data/health.json`.

The run commits through `tools/ci/push_generated.sh` with the paths the job
already owns (`performance/ledger`, `performance/data`).

## Commands

| Command | What it does |
|---|---|
| `node tools/performance/run.js` | dry run: shows the grade letters it would write |
| `node tools/performance/run.js --check --base origin/main` | every chain verifies, every committed line is kept, **every stored grade re-scores to itself** |
| `npm run grades:test` | kernel, lifecycle and wiring suites |
| `npm run grades:sql` | the mirror on a throwaway PostgreSQL |
| `npm run grades:e2e` | the dashboard, badges, filter and breakdown in Chromium |

## Health items

| Item | Level | Meaning |
|---|---|---|
| `grade_reproducibility` | ERROR | a grade did not re-score from its own inputs; it was not written. A kernel change without a new grade version — fix by adding a version. |
| `grade_capture_stale` | ALERT | no grade written for 6 h while games start within a day |
| `odds_feed` | WARN | the slate (the feed carrying named-book lines) is missing or older than 6 h; grades were capped at B |
| `no_pregame_grade` | INFO | completed games with no pregame grade (excluded, never backfilled) |

## Changing the method

Never edit `CONFIGS.rg_v1`. Add `CONFIGS.rg_v2` (new `grade_version`, new
`weights_version`) and point `DEFAULT_VERSION` at it. Old rows keep
reproducing under `rg_v1`; new rows carry `rg_v2`; the dashboard's grade-version
filter keeps the two apart, because letters from different versions are not
comparable. Removing a version makes `--check` fail, by design.

## The Supabase mirror (optional)

1. Run the **Deploy model performance mirror** workflow with `apply_grades`
   ticked (or paste `supabase/research_grades.sql` into the SQL editor; it fits
   in one paste and ends in an `ok` / `CHECK THIS` report).
2. With `vars.PERFORMANCE_SUPABASE == 'on'` the hourly sync mirrors the two
   streams through `perf_research_ingest()`. Without the file applied, those two
   streams wait and the rest still sync.

Rollback: `supabase/research_grades_rollback.sql` drops only this file's
objects; `model_performance.sql` is independent of it in both directions.

## When the dashboard says "Insufficient Historical Data"

That is the correct state until 20 settled games with a pregame grade exist
for the selection (and 50 for intervals). It changes on its own as games are
played. Do not import or reconstruct historical grades to fill it.
