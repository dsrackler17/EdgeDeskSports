# EdgeDesk Simulator — runbook

A correlated Monte Carlo season simulator: division, playoff, seed, conference
and championship probabilities from the served game model, compared (when a
verified mapping exists) with Kalshi futures prices. Design, evidence, status
and limitations are in [`SIMULATOR_NOTES.md`](../../SIMULATOR_NOTES.md) at the
repository root; this page is how to run, verify, deploy, disable and recover it.

**Status today.** The NFL engine, rules, database layer, reader and workflows
are implemented and tested. The NFL is **BLOCKED for publication** until a
person verifies three 2026 facts against the NFL's official pages
(tiebreaking procedures, playoff format, Super Bowl LXI venue). No Kalshi
futures market is mapped and the Kalshi fee schedule is unverified, so the
market comparison reports *unavailable*. Nothing has been applied to the
production database and nothing has been published.

## What you need

- **Node.js 22.18 or newer** (22.22.0 is what CI pins). The simulator is
  TypeScript that Node runs directly (type stripping); there is no build step
  and no runtime dependency. Check with `node --version`.
- **Windows PowerShell 5.1 or PowerShell 7**, from the repository root. Every
  command below is one line and uses forward slashes, which Node accepts on
  Windows.
- Optional: PostgreSQL 14+ binaries on `PATH` (the SQL suite; it skips
  without them), and Playwright (the browser suite; it skips without it).
- Only to rebuild the research studies: the nflverse history cache,
  `CORE=1 bash football/research/nfl_v2/fetch_history.sh 2026` (Git Bash or WSL).

```powershell
node --version                                   # v22.18.0 or newer
npm ci --prefix simulator --no-audit --no-fund   # the pinned typechecker (dev only)
```

## Test

```powershell
npm run sim:typecheck                            # tsc --noEmit, strict
npm run sim:test                                 # engine, hooks, NFL rules 2002-2025, synthetic, simulation, config, markets, reader, CLI, publisher
npm run sim:check                                # generated files are current
npm run sim:sql                                  # supabase/simulator.sql on a throwaway PostgreSQL (skips without one)
npm install --no-save playwright@1.49.1; npx playwright install chromium; npm run sim:e2e   # the Simulator seat in Chromium
```

To make a missing PostgreSQL or browser a failure instead of a skip (as CI does):

```powershell
$env:SIM_SQL_REQUIRED = '1'; npm run sim:sql; Remove-Item Env:SIM_SQL_REQUIRED
$env:SIM_E2E_REQUIRED = '1'; npm run sim:e2e; Remove-Item Env:SIM_E2E_REQUIRED
```

## Dry run (no database, no credentials)

```powershell
npm run sim:dry-run                              # builds the snapshot from the live feeds, 100,000 runs, 4 workers
node simulator/src/cli/run.ts --sport nfl --season 2026 --runs 20000 --workers 4 --dry-run --out simulator/out/try
node simulator/src/cli/run.ts --sport nfl --season 2026 --offline --dry-run      # cached feeds only (simulator/.cache/feeds)
```

Each run writes `snapshot.json` (the frozen, content-hashed inputs),
`results.json`, `gates.json` and `manifest.json` to `simulator/out/<dir>/`
(gitignored). The summary prints every club's probabilities with the 95%
Monte Carlo half-width and every gate that did not pass. `NOT PUBLISHABLE`
with `sport.active` failing is the expected state today.

Exit codes: `0` ok · `1` a gate blocked publication (nothing published) ·
`2` invalid inputs or arguments (nothing simulated) · `3` publication failed
(the previously published run is unchanged).

## Replay and reproducibility

A run is determined by its snapshot, its seed and the code. The default seed
is the first 64 bits of the snapshot's content hash; the worker count never
changes a result.

```powershell
npm run sim:replay -- simulator/out/try/snapshot.json
node simulator/src/cli/run.ts --snapshot simulator/out/try/snapshot.json --seed 12345 --runs 100000 --workers 2 --dry-run
Get-FileHash simulator/out/try/results.json -Algorithm SHA256
```

A snapshot edited after it was built is refused (content hash mismatch). A
snapshot built with different model code (`football/nfl_model.js`, the
parameters, the board builder, the uncertainty study) is refused by the
`replay.code_identity` gate: check out the snapshot's `source_commit` first.

## Validation (research, not a claim of edge)

```powershell
npm run sim:uncertainty                          # simulator/data/nfl_strength_uncertainty.json (needs the history cache)
npm run sim:backtest -- --runs 2000 --workers 4  # simulator/data/nfl_backtest.json, 2010-2025 x weeks 4/8/12/16 (~6 min)
npm run sim:registry                             # regenerates supabase/simulator_registry.sql from simulator/research/registration.json
```

The model is registered **EXPERIMENTAL, tier T3** (`SIM-NFL-SEASON` v0.1.0)
with its promotion criteria written before any holdout evaluation. Nothing
promotes it automatically; promotion is a reviewed change after the criteria
in `simulator/research/registration.json` are met on the holdout seasons.

## Kalshi futures

```powershell
npm run sim:kalshi:discover -- --sport nfl       # writes simulator/out/kalshi_candidates.json; never the config
npm run sim:markets -- --results simulator/out/try/results.json      # compares without writing anything
```

A market is compared only when a person has read its settlement rules and
added it to `simulator/config/kalshi_futures.json` with `status: "verified"`,
the exact outcome it settles on, the rules' sha256, `verified_by` and
`verified_at`. Probabilities are normalized only across a complete, mutually
exclusive outcome set quoted within the skew limit. Executable comparisons use
the ask at the configured quantity; the midpoint is a reference only. Until
the fee schedule is verified (`fees.verified`), every executable figure is
labelled pre-fee and nothing is flagged. The simulator never places an order.

## Deployment sequence

Every step is a decision a person makes; none runs by itself.

1. **Verify the NFL facts.** Compare `SIMULATOR_NOTES.md` §NFL rules with
   <https://operations.nfl.com/the-rules/nfl-tiebreaking-procedures/>, confirm
   the 2026 playoff format and the Super Bowl LXI venue and date. In
   `simulator/src/sports/nfl/config.ts` set each fact's `verification` to
   `VERIFIED` with `verified_by` and `verified_at` (YYYY-MM-DD) in a reviewed
   commit, then `node simulator/src/cli/build_ui_registry.ts` and
   `npm run sim:test`. A fact marked VERIFIED without both fields still blocks.
2. **Apply the database layer.** Actions → *Deploy simulator SQL* → Run
   workflow (needs the `SB_DB_URL` secret), or paste
   `supabase/simulator.sql` into the Supabase SQL editor (it is idempotent and
   ends in a report; every row must read `ok`). Then
   `supabase/simulator_registry.sql` (the research registration). The report
   checks that `public.community_is_entitled(uuid)` exists: without it no one
   can read results (fail closed).
3. **Secrets.** `SB_URL` and `SB_SERVICE_ROLE` (Actions secrets, already used
   by other jobs). The service role key lives only in the job environment;
   the reader uses the signed-in user's session and the database checks the
   premium entitlement.
4. **First publication by hand.** Actions → *Simulator* → Run workflow with
   `publish` ticked. The plan step refuses a sport that is not ACTIVE or fewer
   than 100,000 runs. Check the run's evidence artifact and the reader.
5. **Nightly.** The schedule (10:17 UTC) then publishes every ACTIVE sport.
   After each publication the *markets* job compares with Kalshi (when
   mappings exist).
6. **Frontend.** `app.html` already carries the Simulator seat; it shows
   statuses, blockers and limitations until a run is published, and the
   last published run with its age afterwards.

PowerShell, to check what a step will do before running it in CI:

```powershell
$env:SIM_EVENT='workflow_dispatch'; $env:SIM_SPORT='nfl'; $env:SIM_SEASON='2026'; $env:SIM_RUNS='100000'; $env:SIM_SEED=''; $env:SIM_PUBLISH='true'; node simulator/src/cli/plan.ts
```

## NBA (2026-27): blocked, runnable as a dry run

Design, evidence and what is and is not modelled:
[`NBA_SIMULATOR_NOTES.md`](../../NBA_SIMULATOR_NOTES.md). The NBA is
**BLOCKED**: six 2026-27 rules facts await verification against nba.com
(unreachable from the build environment), and 30 regular-season games depend
on the NBA Cup group stage and are not on the schedule until early December.

The NBA snapshot prices every game with the served NBA model, which needs the
NBA work tables (`.cache/nba_work`, rebuilt from the public hoopR feeds; about
eight minutes and 0.5 GB the first time) and `pyarrow`:

```powershell
pip install pyarrow
node --max-old-space-size=6144 nba/ingest/season.js --season all      # the work tables (the committed nba/data files may change: git checkout nba/data keeps the committed ones)
npm run sim:nba:test                                                    # NBA rules (2006-07..2025-26 postseasons), synthetic cases, config, model, simulation
npm run sim:nba:dry-run -- --runs 100000                                # the 2026-27 season as committed; --allow-incomplete-schedule is a WARN that blocks publication
node --max-old-space-size=8000 simulator/src/cli/run.ts --sport nba --season 2026 --as-of 2026-04-25T00:00:00Z --dry-run --runs 20000 --workers 4   # a historical replay: 2025-26 frozen in the first round
npm run sim:replay -- simulator/out/<dir>/snapshot.json                 # replay an NBA snapshot (sport and season come from the file)
```

Research artifacts (committed; rebuild in this order when the NBA model changes):

```powershell
npm run sim:nba:hazards                  # simulator/data/nba_return_hazards.json (seconds)
npm run sim:nba:frozen                   # frozen forecasts, 15 seasons x 5 as-of points (simulator/.cache/nba_frozen; hours)
npm run sim:nba:uncertainty              # simulator/data/nba_strength_uncertainty.json
npm run sim:nba:audit                    # simulator/data/nba_postseason_audit.json
npm run sim:nba:fixture                  # simulator/fixtures/nba_2027_snapshot.json.gz and nba_2026_r1_snapshot.json.gz (the test snapshots)
```

**To activate the NBA:** verify the six facts in
`simulator/src/sports/nba/config.ts` (VERIFIED, `verified_by`, `verified_at`)
in a reviewed commit; once the NBA Cup-dependent games are on the schedule
(`schedule.complete` passes) remove the schedule blocker in
`simulator/src/sports/registry.ts`; regenerate the reader registry
(`node simulator/src/cli/build_ui_registry.ts`); add `nba` to `RUNNABLE` in
`simulator/src/cli/plan.ts` and an NBA work-table step to
`.github/workflows/simulator.yml` (restore the `nba-work-` cache the NBA build
keeps, as `nba-build.yml` does); then a first 100,000-run publication by hand.

## Disable and recover

- **Stop publishing:** Actions → *Simulator* → ⋯ → *Disable workflow*. The
  reader keeps showing the last published run with its age and a stale badge
  after 36 hours. Nothing is deleted.
- **Hide one sport:** set its fact back to `UNVERIFIED` (or its registry
  status) in a reviewed commit and regenerate the reader's registry; the
  publisher refuses it from the next run. Published history stays.
- **A bad publication:** publish a corrected run (a newer input supersedes);
  rows are immutable and the pointer only moves forward through
  `sim_publish_run`. Nothing is deleted or rewritten; the superseded run stays
  queryable with its status.
- **A failed run** never replaces the published one: it is marked `failed`
  with its error and recorded in `public.sim_alerts`. Fix the cause and run
  the workflow again (the idempotency key is per input, seed and run count, so
  a re-run of the same inputs after a failure starts a new attempt).
- **A Kalshi outage** fails only the *markets* job (recorded `DEGRADED`); the
  simulation stays published and no old quote is shown as fresh.
- **Remove the reader seat:** revert the `app.html` and
  `lib/edgedesk_workspace_ui.js` hunks of the Simulator commit. The database
  tables can stay; nothing else reads them.
- **Remove the database layer entirely** is not scripted on purpose (the
  tables are append-only evidence). If it is ever needed, a person writes and
  reviews that migration.
