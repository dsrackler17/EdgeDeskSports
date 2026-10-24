# EdgeDesk college basketball forecast — runbook

NCAA Division I men's basketball: calibrated pregame win probabilities and
score distributions, Upset Watch, weekly challengers with guarded promotion,
and a correlated NCAA tournament simulator. Design, evidence, status and
limitations are in [`CBB_MODEL_NOTES.md`](../../CBB_MODEL_NOTES.md) at the
repository root; this page is how to set up, run, verify, deploy, disable and
roll back the system. (In this repository `cbb` means college baseball; this
system is named `ncaam` everywhere.) The women's system is separate, with its own tables and
switch: [`docs/ncaaw-forecast/README.md`](../ncaaw-forecast/README.md).

**Status today (2026-10-24).** The pregame system is implemented and tested, and its
champion is `ncaam_adjeff@1.0.0`, promoted by the weekly gates on 2026-10-23.

- The code is on `main`, and the daily refresh runs there (13:37 UTC).
- The database layer and the research registration are in production:
  *Deploy NCAAM forecast SQL*, run 40052574063, every report row `ok`.
- **Nothing has been published.** `NCAAM_FC_PUBLISH` is not set, so each
  daily run keeps its forecasts as a run artifact. Setting it is the one step
  left (Deploy, step 4); the season opens 2026-11-02.

The tournament simulator is **BLOCKED for publication** until a person
verifies the 2027 format and types in the official bracket after Selection
Sunday. Three modes are **disabled**, each with its reason:

- in-game (live) forecasts;
- pre-selection national-title forecasts;
- conference-tournament simulation.

## What you need

- **Node.js 22.18 or newer** (CI pins 22.22.0). There is no build step and no
  runtime dependency. Check with `node --version`.
- **Windows PowerShell 5.1 or PowerShell 7**, from the repository root. Every
  command below is one line and uses forward slashes, which Node accepts on
  Windows.
- Only to **ingest** new data, a `python3` command with `pyarrow`. The hoopR
  files are Parquet, read by `hockey/lib/io.js`, which runs `python3`.
  - On Windows, the Microsoft Store Python provides `python3`, or you can use WSL.
  - The committed data is enough for everything else, and the daily workflow
    ingests in CI.
- Optional: PostgreSQL 14+ binaries on `PATH` for the SQL suite, which skips
  without them. Playwright for the browser suite.

```powershell
node --version                                   # v22.18.0 or newer
npm ci --prefix simulator --no-audit --no-fund   # the pinned typechecker (dev only)
python3 -m pip install pyarrow                   # only to ingest
```

## Test

```powershell
npm run ncaam:fc:test                            # model, live writer, SQL (skips without PostgreSQL), simulator module, reader
npm run ncaam:fc:check                           # frozen selection/validation records, registry consistency, generated SQL
npm run sim:typecheck                            # the simulator, NCAAM module included
npm run ncaam:fc:test:ops                        # failure injection on the real weekly run (about 3 minutes)
npm install --no-save playwright@1.49.1; npx playwright install chromium; npm run ncaam:fc:e2e
```

To make a missing PostgreSQL or browser a failure instead of a skip (as CI does):

```powershell
$env:NCAAM_SQL_REQUIRED = '1'; node basketball/ncaam_forecast/tests/sql.test.js; Remove-Item Env:NCAAM_SQL_REQUIRED
$env:NCAAM_E2E_REQUIRED = '1'; npm run ncaam:fc:e2e; Remove-Item Env:NCAAM_E2E_REQUIRED
```

## Run locally (no database, no credentials)

```powershell
npm run ncaam:fc:ingest                          # the season in progress (needs python3 + pyarrow)
npm run ncaam:fc:refresh                         # forecasts for the next 48 h -> basketball/ncaam_forecast/out/forecasts/<stamp>.json
node basketball/ncaam_forecast/refresh.js --hours 72 --now 2026-11-10T15:00:00Z   # a chosen horizon and moment
npm run ncaam:fc:status                          # the champion, its history, and whether the registry agrees with itself
node basketball/ncaam_forecast/weekly.js --only carry_higher --dry-run            # evaluate one challenger, never promote
```

The refresh document lists its gates (data hashes, freshness ≤ 36 h, box
coverage ≥ 97%, finite outputs) and `publishable`. Without `--publish` nothing
leaves the machine.

### Preseason

Before the season's first regular-season game (the earliest `season_type` 2
game in the season's schedule file; 2026-11-02 for 2026-27) the refresh runs in
**preseason** mode. Its window runs to the end of the opening week (opener + 7
days), not 48 hours. No game moves a rating before the opener, so the opening
slate is priced from preseason ratings: last season's, carried forward. Every
such forecast is flagged `PRESEASON_RATINGS`, and the refresh document records
`window.phase`. From the opener on, the routine `--hours` window applies.
Nobody has to switch anything.

Exhibition games are not priced. The hoopR schedule files have no
`season_type` 1 row in any season, and ESPN's Division I scoreboard listed no
game on a preseason date (2024-11-01) or from 2026-10-22 to 10-27 (the slate).
The Simulator seat shows **Preseason** on its chip and a preseason card until
the opening day in the generated registry (`games.regular_season_start`,
`simulator/src/sports/registry.ts`). Each new season, set that date in a
reviewed commit. The tournament simulation's status (BLOCKED) is separate and
still gates only the Tournament tab and the simulator planner.

```powershell
node basketball/ncaam_forecast/refresh.js --now 2026-10-24T15:00:00Z   # preseason: through 2026-11-09, every forecast flagged
node basketball/ncaam_forecast/refresh.js --now 2026-11-02T13:37:00Z   # opening day: the routine 48 h
```

### Validation records (research, not a claim of edge)

```powershell
node basketball/ncaam_forecast/validate.js       # rebuilds validation/ncaam_fc_validation.json and VALIDATION.md (about 8 minutes)
node basketball/ncaam_forecast/live_backtest.js  # the in-game checkpoint backtest (about 1.5 minutes)
node simulator/src/research/ncaam_backtest.ts --runs 20000 --workers 4   # 15 historical tournaments, V vs V = 0 (about 1.5 minutes)
node basketball/ncaam_forecast/select.js --check # the frozen development selection (never re-chosen)
```

## Tournament simulation

The benchmark is the 2026 field, 100,000 runs, dry run. Here it took 2.9 s of
simulation and 39 s in all on 4 vCPU:

```powershell
npm run ncaam:fc:bench
```

**After Selection Sunday 2027:**

1. Verify the 2027 format (field size, play-in games, regions) against the
   NCAA's official release. In `simulator/src/sports/ncaam/config.ts` set
   `format.verification = 'VERIFIED'`, `verified_by` and `verified_at`
   (YYYY-MM-DD) in a reviewed commit. A fact marked VERIFIED without both
   fields still blocks.
   - If the field is no longer 68 teams with four play-in games, stop and
     review the format text and the reader before going on.
2. Make the template from a past field and type the official bracket into it:

   ```powershell
   node basketball/ncaam_forecast/tournament.js --example 2026 --out basketball/ncaam_forecast/config/brackets/2027.json
   ```

   Replace every entrant (ESPN team id → region, seed), every slot (`a`/`b`
   are `{ "team": id }` or `{ "winnerOf": slot id }`), `season`,
   `announced_at` and `source` (name the official release). Completed games
   are fixed automatically from results known at the run's as-of time.
3. Record the bracket fact as VERIFIED the same way, then regenerate the reader
   registry and test:

   ```powershell
   node simulator/src/cli/build_ui_registry.ts; npm run ncaam:fc:test
   ```

4. Dry run:

   ```powershell
   node simulator/src/cli/run.ts --sport ncaam --season 2027 --runs 100000 --workers 4 --dry-run
   ```

   Every gate must say PASS. `snapshot.json` must have an empty
   `unrated_entrants`.
5. Publish once by hand: Actions → *Simulator* → Run workflow, sport `ncaam`,
   season `2027`, publish ticked. From then on the nightly plan includes
   NCAAM.

Replays: `--as-of <ISO time>` builds the ratings and the frozen results as of
that moment, and `--snapshot <dir>/snapshot.json` re-runs the exact inputs.

## Deploy (each step is a person's decision)

1. **Merge** the branch to `main` after review.
2. **Database** (done 2026-10-24, run 40052574063). The simulator layer must
   be in production first: Actions → *Deploy simulator SQL*. Then Actions →
   *Deploy NCAAM forecast SQL*. Re-running it is safe (idempotent, additive).
   - Both need the `SB_DB_URL` secret.
   - The deploy runs the SQL suite on a throwaway PostgreSQL, refuses without
     `public.sim_viewer_entitled()`, applies `supabase/ncaam_forecast.sql` in
     one transaction, and optionally registers NCAAM-FORECAST 1.0.0 and
     SIM-NCAAM-TOURNAMENT 0.1.0 (EXPERIMENTAL, T3).
   - The alternative is to paste `supabase/ncaam_forecast.sql`, then
     `supabase/ncaam_forecast_registry.sql`, into the Supabase SQL editor.
     Each ends in a report whose rows must all read `ok`.
3. **Secrets**: `SB_URL` and `SB_SERVICE_ROLE` (Actions secrets, already used
   by other jobs).
   - The service-role key lives only in the job environment and is redacted
     from every message.
   - The browser reads with the signed-in user's session, and the database
     checks the premium entitlement (it fails closed).
4. **Turn publication on**: Settings → Secrets and variables → Actions →
   Variables → `NCAAM_FC_PUBLISH` = `on`. The next daily run (13:37 UTC)
   publishes. To publish at once: Actions → *NCAAM forecast (daily)* → Run
   workflow.
5. **Frontend.** `app.html` already loads `lib/edgedesk_simulator_ncaam.js`
   (cache-bust `?v=20261023ncaam1`). The Men's College Basketball tabs show the
   statuses, the blockers and "no forecast published yet" until the first
   publication.

To check a step before CI runs it:

```powershell
node basketball/ncaam_forecast/registry.js verify
$env:SIM_EVENT='workflow_dispatch'; $env:SIM_SPORT='ncaam'; $env:SIM_SEASON='2027'; $env:SIM_RUNS='100000'; $env:SIM_SEED=''; $env:SIM_PUBLISH='false'; node simulator/src/cli/plan.ts
```

## Weekly challengers and promotion

The *NCAAM forecast (weekly challengers)* workflow runs every Monday at 11:07
UTC. It can also be run by hand, with `only` (catalogue ids) and `dry_run`.

- Every candidate gets an immutable report in
  `basketball/ncaam_forecast/reports/weekly/` and a line in
  `registry/history.jsonl`, including RETAIN, INSUFFICIENT_EVIDENCE and
  FAILED.
- Promotion happens only when all eight gates in `config/promotion_v1.json`
  pass and the artifact rebuilds identically.
- The gates file is versioned. Changing a threshold is a new version in a
  reviewed commit, never an edit to make a candidate pass.

```powershell
node basketball/ncaam_forecast/weekly.js --max 4                # the weekly rotation
node basketball/ncaam_forecast/weekly.js --only tie_consistent_fit,carry_higher
Get-Content basketball/ncaam_forecast/registry/history.jsonl -Tail 5
```

## Rollback

Rolling back points the daily refresh at the previous champion's
configuration. Its record and report stay in the registry.

```powershell
node basketball/ncaam_forecast/registry.js status
node basketball/ncaam_forecast/registry.js rollback --reason "why, in a sentence"                   # to the previous champion
node basketball/ncaam_forecast/registry.js rollback --to ncaam_points@1.1.0 --reason "why"          # to a named earlier champion
node basketball/ncaam_forecast/registry.js verify
```

Commit `basketball/ncaam_forecast/registry`. The next daily run serves the
restored champion. With publication on, it also syncs the database pointer
through `ncaam_fc_set_champion` (ROLLBACK needs a reason there too). To sync
at once:

```powershell
$env:SB_URL = 'https://<project>.supabase.co'; $env:SB_SERVICE_ROLE = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText; node basketball/ncaam_forecast/publish.js --sync; Remove-Item Env:SB_URL, Env:SB_SERVICE_ROLE
```

(`ConvertFrom-SecureString -AsPlainText` needs PowerShell 7; it keeps the key
out of the command history.)

If `registry.js verify` reports that the pointer and the history disagree
(for example after a crash between the two writes), weekly and refresh refuse
to run. Restore the last committed `registry/` (`git checkout -- basketball/ncaam_forecast/registry`)
or append the missing decision line by hand in a reviewed commit, then verify
again.

## Disable and recover

- **Stop publishing**: set `NCAAM_FC_PUBLISH` to anything but `on`. The data
  stays current and forecasts are still built as run artifacts. Readers keep
  the last published forecasts, marked stale after 36 hours. Nothing is
  deleted.
- **Stop everything**: Actions → each NCAAM workflow → ⋯ → *Disable workflow*.
- **A failed refresh** never replaces the published forecasts. The run is
  marked `failed` with its error, and the reader shows the last good run as
  stale. Fix the cause and run the workflow again.
- **A failed weekly run** is recorded FAILED with its stage and never moves
  the champion.
- **Bad forecasts were published**: roll back (above) and run the daily
  workflow. A newer run supersedes; rows are immutable and nothing is
  rewritten.
- **Data problem**: `dataset.load()` refuses a file whose sha256 does not
  match `data/manifest.json`. Restore the committed file
  (`git checkout -- basketball/ncaam_forecast/data`) or re-ingest the season:

  ```powershell
  node basketball/ncaam_forecast/ingest.js --season 2027
  ```

- **Live forecasts** ship disabled. `live_writer.js` refuses to start while
  `config/live.json` says `enabled: false`, and refuses to run in GitHub
  Actions at all. The database refuses live rows while
  `ncaam_fc_config.live_enabled` is not `'true'`. Enabling it needs
  everything listed under `blockers` in `config/live.json`.
- **Removing the database layer** is not scripted on purpose (the tables are
  append-only evidence). If it is ever needed, a person writes and reviews
  that migration.
