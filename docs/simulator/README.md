# EdgeDesk Simulator — runbook

A correlated Monte Carlo season simulator: division, playoff, seed, conference
and championship probabilities from the served game model, compared (when a
verified mapping exists) with Kalshi futures prices. Design, evidence, status
and limitations are in [`SIMULATOR_NOTES.md`](../../SIMULATOR_NOTES.md) at the
repository root; this page is how to run, verify, deploy, disable and recover it.

**Status (2026-10-23).** The NFL engine, rules, database layer, reader and
workflows are implemented and tested. The database layer is applied to
production. The NFL's three 2026 facts (tiebreaking procedures, playoff format,
Super Bowl LXI) were verified against the NFL's own pages, read from GitHub's
runners by *Simulator source check*, so the NFL is **ACTIVE**. 352 Kalshi
futures markets are mapped exactly and the fee schedule is verified. The first
publication runs from `main` through the *Simulator* workflow.

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

The mappings are generated, not typed: run Actions → *Simulator source check*,
then build the config from its `kalshi_candidates.json` artifact (download it
from the run page):

```powershell
node simulator/src/cli/build_kalshi_mappings.ts --candidates C:/Downloads/kalshi_candidates.json --run <run id>
npm run sim:test
```


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

1. **Verify the NFL facts** (done for 2026 on 2026-10-23; repeat each season).
   Run Actions → *Simulator source check* (it reads the NFL's and Kalshi's pages
   from GitHub's runners), then compare `SIMULATOR_NOTES.md` §NFL rules with
   <https://www.nfl.com/standings/tie-breaking-procedures> and the league's
   approved rules for the season, and confirm the Super Bowl venue and
   designated home. In
   `simulator/src/sports/nfl/config.ts` set each fact's `verification` to
   `VERIFIED` with `verified_by` and `verified_at` (YYYY-MM-DD) in a reviewed
   commit, then `node simulator/src/cli/build_ui_registry.ts` and
   `npm run sim:test`. A fact marked VERIFIED without both fields still blocks.
2. **Apply the database layer** (done 2026-10-23, run 39947585888; it is
   idempotent, so re-running after a schema change is safe). Actions → *Deploy simulator SQL* → Run
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
