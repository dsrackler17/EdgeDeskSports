# EdgeDesk Signal Center — runbook

**EDGEDESK | RESEARCH NOT PICKS.** Know what changed. Understand why. See whether
the evidence supports it.

Signal Center watches EdgeDesk's own records and reports when something material
changed. The records are every game-research snapshot, every ledgered forecast,
every captured market price, every dated availability report and every published
Simulator run. It reads them back to the start of each ledger, so the season so
far is there from the first run. Each past change is placed when it happened and
marked *found in the ledger later* (METHODOLOGY.md §3). Each signal carries the evidence for the change, the
model's record (Model DNA) and its limits. It is a research-discovery surface. It
never recommends a bet.

| Document | What it covers |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The inventory it was built on, the data flow, the database, the doors, and the per-sport capability table |
| [METHODOLOGY.md](METHODOLOGY.md) | Comparability, the evidence ladder, verification, the importance score and its thresholds, Model DNA, uncertainty |
| [GRAPHICS.md](GRAPHICS.md) | The six templates, the three formats, revision and invalidation, operator approval |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Migration order, switches, shadow → live, rollback, costs, verification queries |

**Status (2026-10-24).** The schema is applied. It was re-applied with #737's
`sha256()` write fix, and Signal Center is **live for every sport**. The 00:25 UTC run
stored 371 signals and published 166. The backfill (the season's history, point in
time) takes effect when this file is applied again: **Actions → Deploy Signal Center
schema** (idempotent: it replaces the doors, adds two columns, and dates and places
the rows already stored). Then **Actions → Signal Center run**. That run stores the
history (about 750 signals over the committed records), re-scores the stored rows
under `sc_importance_v2`, and publishes the verified history of the live sports.
None of it becomes a notice (DEPLOYMENT.md §2–3).

## Where it lives

| Surface | Path | Who |
| --- | --- | --- |
| The Signal Center seat (first in the terminal's navigation) | `app.html#signals` (alias `#signal-center`) | signed-in readers; Full Access sees the numbers |
| A signal's evidence | `app.html#signals/s/<id>` | Full Access (others get the number-free preview) |
| Model DNA, Coverage, Alerts, Method | `#signals/dna[/<sport>]`, `#signals/coverage`, `#signals/alerts`, `#signals/method` | signed-in readers |
| The public preview | `/signals/` | anyone (three anonymous doors, no current number) |
| The operator console | `/admin/signals/` | operators (checked by the database) |

## Test

```powershell
npm run sc:test        # engine 125 · registry 186 · UI renderers 96 · graphics 268 (offline)
npm run sc:sql         # the migration on PostgreSQL 184 · the worker end to end 36
npm run sc:e2e         # graphics in Chromium 200 · the terminal seat 123 · /signals/ + /admin/signals/ 58
npm run sc:dry-run     # evaluate the committed sources now; writes .cache/signal_center/run.json only
```

The SQL and browser suites need PostgreSQL binaries (`/usr/lib/postgresql/<n>/bin`) and Playwright with Chromium. Without
them they skip, except when `SC_SQL_REQUIRED=1`, which CI sets so a skip there is a failure.
The CI workflow is `.github/workflows/signal-center-tests.yml`.

## Run

```powershell
node tools/signal_center/run.js --dry-run              # evaluate, write nothing outside .cache
node tools/signal_center/run.js --dry-run --now 2026-10-23T20:30:00Z
node tools/signal_center/run.js                        # live: needs SB_URL and SB_SERVICE_ROLE
node tools/signal_center/run.js --fixture f.json       # controlled payloads, each marked fixture (never published)
node tools/signal_center/render_graphics.js            # draw every eligible signal's graphics locally and inspect them
```

A live run takes the lease (`sc_begin_run`). It evaluates, re-verifies the active
signals and withdraws any whose source record vanished. It ingests new signals
and versions, draws the graphics that are due, stores Model DNA and sends notices
(capped per reader), records failures as dead letters and closes the run. Every
write goes through a job door in the database. See ARCHITECTURE.md.

## Disable

- **Stop evaluating:** set the repository variable `SIGNAL_CENTER_WORKER` to anything but `on`.
- **Stop publishing:** as an operator, `/admin/signals/` → Mode → Shadow, or
  `select public.sc_admin_set_mode('shadow', null);` signed in as an operator.
- **One signal:** `/admin/signals/` → Review → Hold or Withdraw (the reason is kept).
- **Remove everything:** `supabase/signal_center_rollback.sql` (destructive; DEPLOYMENT.md).

## What it will not do

- It posts nothing to X, Discord or any other service. Graphic "approval" is a
  record that a person checked a graphic; no job reads it to publish.
- It sends no email or SMS. Notices are rows in the existing research-alerts bell (`public.user_alerts`).
- It calls no odds provider and changes no capture cadence. It reads what the existing jobs already captured.
- It invents nothing to fill a page. No signal comes from a fixture, a synthetic model or an unverified number.
  A sport without a dated source for a kind of signal says so (Coverage).
- It does not claim a cause it did not isolate. See the evidence ladder in METHODOLOGY.md.
