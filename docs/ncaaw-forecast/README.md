# EdgeDesk women's college basketball forecast — runbook

NCAA Division I women's basketball: calibrated pregame win probabilities and
score distributions, Upset Watch, and weekly challengers with guarded
promotion. Design, evidence, status and limitations are in
[`NCAAW_MODEL_NOTES.md`](../../NCAAW_MODEL_NOTES.md) at the repository root;
this page is how to set up, run, verify, deploy, disable and roll back. The
men's system is separate: [`docs/ncaam-forecast/README.md`](../ncaam-forecast/README.md).
(`cbb` means college baseball in this repository; this system is `ncaaw`.)

**Status today (2026-10-24).** Implemented and tested. The champion is
`ncaaw_adjeff@1.0.0`, promoted by the weekly gates on 2026-10-24 over the
served scores-only model.

- The code is on `main` (daily refresh 13:47 UTC, weekly challengers Monday
  11:37 UTC).
- The database layer and the research registration are in production:
  *Deploy NCAAW forecast SQL*, run 40098150410, every report row `ok`.
- **Nothing is published** until `NCAAW_FC_PUBLISH` is `on` (Deploy, step 4).
  Setting it is the one step left; the season opens 2026-11-02.

Not built, each with its reason (NCAAW_MODEL_NOTES.md §9): the NCAA tournament
simulation (the first two rounds are home games for the top 16 seeds, and the
slot engine is neutral-site), in-game forecasts (no women's live feed), and
the market comparison (no women's college basketball price is captured).

## What you need

Exactly as the men's runbook: Node.js 22.18 or newer (CI pins 22.22.0), no
build step and no runtime dependency; Windows PowerShell 5.1 or PowerShell 7
from the repository root; `python3` with `pyarrow` only to ingest (the wehoop
files are Parquet); optional PostgreSQL 14+ for the SQL suite and Playwright
for the browser suite.

## Test

```powershell
npm run ncaaw:fc:test                            # model (98 checks), SQL (skips without PostgreSQL), the reader
npm run ncaaw:fc:check                           # frozen selection/validation records, registry consistency, generated SQL
npm run sim:typecheck                            # the simulator, the registry's NCAAW entry included
npm run ncaaw:fc:test:ops                        # failure injection on the real weekly run (about 1 minute)
npm install --no-save playwright@1.49.1; npx playwright install chromium; npm run ncaaw:fc:e2e
```

To make a missing PostgreSQL or browser a failure instead of a skip (as CI does):

```powershell
$env:NCAAW_SQL_REQUIRED = '1'; node basketball/ncaaw_forecast/tests/sql.test.js; Remove-Item Env:NCAAW_SQL_REQUIRED
$env:NCAAW_E2E_REQUIRED = '1'; npm run ncaaw:fc:e2e; Remove-Item Env:NCAAW_E2E_REQUIRED
```

## Run locally (no database, no credentials)

```powershell
npm run ncaaw:fc:ingest                          # the season in progress (needs python3 + pyarrow)
npm run ncaaw:fc:refresh                         # forecasts for the next 48 h -> basketball/ncaaw_forecast/out/forecasts/<stamp>.json
node basketball/ncaaw_forecast/refresh.js --hours 72 --now 2026-11-03T15:00:00Z   # a chosen horizon and moment
npm run ncaaw:fc:status                          # the champion, its history, and whether the registry agrees with itself
node basketball/ncaaw_forecast/weekly.js --only carry_lower --dry-run             # evaluate one challenger, never promote
```

The refresh document lists its gates (data hashes, freshness ≤ 36 h, box
coverage ≥ 97%, finite outputs) and `publishable`. Without `--publish` nothing
leaves the machine. A `--now` far from the last ingest fails the freshness gate,
as it should.

### Preseason

Before the season's first regular-season game (the earliest `season_type` 2
game in the season's schedule file; 2026-11-02 for 2026-27) the refresh runs in
**preseason** mode. Its window runs to the end of the opening week (opener + 7
days), not 48 hours. No game moves a rating before the opener, so the opening
slate is priced from preseason ratings: last season's, carried forward. Every
such forecast is flagged `PRESEASON_RATINGS`, and the refresh document records
`window.phase`. From the opener on, the routine `--hours` window applies.
Nobody has to switch anything.

Exhibition games are not priced. The wehoop schedule files have no
`season_type` 1 row in any season, and ESPN's Division I scoreboard listed no
game on a preseason date (2024-11-01) or from 2026-10-22 to 10-27 (the slate).
The Simulator seat shows **Preseason** on its chip and a preseason card until
the opening day in the generated registry (`games.regular_season_start`,
`simulator/src/sports/registry.ts`). Each new season, set that date in a
reviewed commit. The tournament simulation's status (BLOCKED) is separate and
still gates only the Tournament tab and the simulator planner.

```powershell
node basketball/ncaaw_forecast/refresh.js --now 2026-10-24T15:00:00Z   # preseason: through 2026-11-09, every forecast flagged
node basketball/ncaaw_forecast/refresh.js --now 2026-11-02T13:37:00Z   # opening day: the routine 48 h
```

### Records (research, not a claim of edge)

```powershell
node basketball/ncaaw_forecast/ingest.js --season all     # every season 2010-2027 (about 20 s with a warm cache)
node basketball/ncaaw_forecast/select.js --check          # the frozen development selection (never re-chosen)
node basketball/ncaaw_forecast/validate.js                # rebuilds validation/ncaaw_fc_validation.json and VALIDATION.md (about 2 minutes)
```

`select.js` without `--check` re-chooses on 2018-2022 and rewrites the frozen
file: do not run it on the committed system (the champion's configuration and
every weekly report cite that selection's hash).

## Deploy (each step is a person's decision)

1. **Merge** the branch to `main` after review.
2. **Database** (done 2026-10-24, run 40098150410). The simulator layer is in
   production already (*Deploy simulator SQL*). Run Actions → *Deploy NCAAW
   forecast SQL*. Re-running it is safe (idempotent, additive).
   - It needs the `SB_DB_URL` secret.
   - It runs the SQL suite on a throwaway PostgreSQL, refuses without
     `public.sim_viewer_entitled()`, applies `supabase/ncaaw_forecast.sql` in
     one transaction, and optionally registers NCAAW-FORECAST 1.0.0
     (EXPERIMENTAL, T3).
   - It does not need, and never touches, the men's tables.
   - The alternative is to paste `supabase/ncaaw_forecast.sql`, then
     `supabase/ncaaw_forecast_registry.sql`, into the Supabase SQL editor. Each
     ends in a report whose rows must all read `ok`.
3. **Secrets**: `SB_URL` and `SB_SERVICE_ROLE` (Actions secrets, already used by
   the men's jobs). The service-role key lives only in the job environment; the
   browser reads with the signed-in user's session and the database checks the
   premium entitlement (it fails closed).
4. **Turn publication on**: Settings → Secrets and variables → Actions →
   Variables → `NCAAW_FC_PUBLISH` = `on`. The next daily run (13:47 UTC)
   publishes. To publish at once: Actions → *NCAAW forecast (daily)* → Run
   workflow. The men's switch (`NCAAM_FC_PUBLISH`) is separate.
5. **Frontend.** `app.html` loads `lib/edgedesk_simulator_ncaaw.js`. The
   Simulator's **Women's College Basketball** seat shows the statuses, the
   blocked tournament and "no forecast published yet" until the first
   publication.

## Weekly challengers and promotion

*NCAAW forecast (weekly challengers)* runs every Monday at 11:37 UTC (after the
men's run), and by hand with `only` and `dry_run`. Up to four changes from the
fixed catalogue in `weekly.js`, each walked forward with calibration fitted
causally, scored against the champion on 2023 to date under the eight gates of
`config/promotion_v1.json` (the men's thresholds, adopted before any women's
candidate was scored). Every candidate gets an immutable report in
`reports/weekly/` and a line in `registry/history.jsonl`. At most one promotion
a week, only with every gate passed and a reproducible artifact. A catalogue
change that is no change for the current champion is skipped (the women's
champion already has `carry` 1.0 and `half_life` 365).

## Rollback

```powershell
node basketball/ncaaw_forecast/registry.js status
node basketball/ncaaw_forecast/registry.js rollback --reason "why, in a sentence"                   # to the previous champion (ncaaw_points@1.1.0)
node basketball/ncaaw_forecast/registry.js verify
```

Commit `basketball/ncaaw_forecast/registry`. The next daily run serves the
restored champion; with publication on it also syncs the database pointer
through `ncaaw_fc_set_champion` (a ROLLBACK needs a reason there too). To sync
at once:

```powershell
$env:SB_URL = 'https://<project>.supabase.co'; $env:SB_SERVICE_ROLE = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText; node basketball/ncaaw_forecast/publish.js --sync; Remove-Item Env:SB_URL, Env:SB_SERVICE_ROLE
```

If `registry.js verify` reports that the pointer and the history disagree,
weekly and refresh refuse to run: restore the last committed `registry/`
(`git checkout -- basketball/ncaaw_forecast/registry`) or append the missing
decision line by hand in a reviewed commit, then verify again.

## Disable and recover

- **Stop publishing**: set `NCAAW_FC_PUBLISH` to anything but `on`. The data
  stays current; readers keep the last published forecasts, marked stale after
  36 hours. Nothing is deleted.
- **Stop everything**: Actions → each NCAAW workflow → ⋯ → *Disable workflow*.
- **A failed refresh** never replaces the published forecasts: the run is
  marked `failed` and the reader shows the last good run as stale.
- **A failed weekly run** is recorded FAILED with its stage and never moves the
  champion.
- **Data problem**: `dataset.load()` refuses a file whose sha256 does not match
  `data/manifest.json`. Restore the committed file
  (`git checkout -- basketball/ncaaw_forecast/data`) or re-ingest:
  `node basketball/ncaaw_forecast/ingest.js --season 2027`.
- **Removing the database layer** is not scripted on purpose (the tables are
  append-only evidence).
