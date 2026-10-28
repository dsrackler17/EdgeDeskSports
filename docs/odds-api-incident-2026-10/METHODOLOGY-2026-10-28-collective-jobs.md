# Methodology change — the emergency stop covers the Collective's own odds jobs (2026-10-28)

**Type:** methodology change to the odds gateway's guards (AGENTS.md §3). It
is its own pull request and needs explicit review before it merges. It
changes nothing in production by itself. It pauses, resumes or reschedules
nothing until an operator applies a file or calls a function.

## Why

The emergency stop and the hourly limits find a paid pg_cron job by its
command. `public.odds_api_spend_patterns()` is a list of `ILIKE` patterns,
almost all of them function URLs (`%/functions/v1/collective_odds_ingest%`).

The Collective's two odds jobs carry no URL. Read from production on
2026-10-28 by the read-only Collective odds doctor
(`tools/collective/odds_doctor.js`, pull request on branch
`claude/collective-odds-doctor`):

| jobid | jobname | schedule | command |
|---|---|---|---|
| 128 | `collective_nfl_odds` | `35 12 * * *` | `select odds.run_ingest(false);` |
| 130 | `collective_cfb_odds` | `40 12 * * *` | `select odds.run_ingest('ncaaf', false);` |

`odds.run_ingest` posts to `collective_odds_ingest` at the URL held in the
`odds.settings` row `ingest.function_url`. In production
`provider.default = theoddsapi`, so these jobs reach a paid path. Neither
command matches any pattern, so:

- The emergency stop of 2026-10-14 did not pause them. Neither job is in
  `public.odds_api_paused_jobs`, and both ran every day through the incident.
- Report row 4 ("no active pg_cron job can reach a known paid Odds API path")
  and `odds_api_active_spend_jobs()` do not count them.
- `odds_api_hourly_limits.sql` and `odds_api_schedule_audit()` do not see
  them.

This is the same blind spot the 2026-10-26 change closed for
`select public.sharp_check_poke();`, and the same kind of fix.

## What changes

1. `odds_api_spend_patterns()` gains `%odds.run_ingest%`. The change is made
   in `supabase/odds_api_emergency_stop.sql`, the source of truth, and in the
   identical copy in `supabase/odds_api_gateway.sql`. A test already keeps
   the two lists identical.
2. `odds_api_resume_schedules()` gains the same pattern in its allowlist of
   jobs routed through the gateway. The repository's `collective_odds_ingest`
   buys The Odds API only through `odds_gateway` (category `collective`), so
   a paused Collective job comes back with the rest.
3. **The gateway file now re-creates `odds_api_resume_schedules()` verbatim**,
   as it already re-creates the pattern list. The pattern list reaches a live
   database whenever the gateway is applied, so the stop starts pausing these
   jobs. The resume in production predates this change. Without its new copy,
   a stop would be paired with a resume that keeps the Collective's jobs
   paused, "not routed through odds_gateway". Getting the resume from the
   stop file means re-running the stop, which re-pauses every job. A new test
   keeps the two definitions identical.
4. Report row 13 in the gateway file confirms both production commands match
   a pattern and the installed resume names `odds.run_ingest`.
5. The gateway's six SQL-editor parts are regenerated with
   `tools/sql/split_sql.js`. The splitter reproduces `main`'s committed parts
   byte for byte from `main`'s file. Parts 5 and 6 change.

The pattern is `%odds.run_ingest%`. In `ILIKE`, `_` matches any one
character, so it would also match a command naming `odds.runXingest`. No
such command exists, and the existing patterns have the same property
(`%capture_poke%`).

## Before and after

On a real PostgreSQL. "Before" runs the new tests against `main`'s SQL.

| Scenario | Before (`main`) | After |
|---|---|---|
| The stop pauses `collective_nfl_odds` / `collective_cfb_odds` (production commands verbatim) | no: both stay active | yes, recorded in `odds_api_paused_jobs` |
| Paused jobs recorded, in the fixture of 10 | 6 | 8 |
| Applying the gateway replaces a stale resume | no: the stale resume answers, the live layer aborts | yes |
| The resume brings the Collective's jobs back | no | yes, alongside capture, props, close and the URL-form ingest |
| A legacy function nobody can audit | stays paused | stays paused (unchanged) |
| Hourly limits on the daily `35 12 * * *` job | not considered | considered; already at most hourly, so unchanged |
| Hourly limits on an `odds.run_ingest` job every 30 minutes | left at `*/30 * * * *` | slowed to `27 * * * *` |
| A stop after the hourly limits | the Collective's jobs stay active | paused with the rest |
| The free `sharp_lag` job | not a spend path | not a spend path (unchanged) |

Suite totals:

| Suite | `main` as it is | new tests, `main`'s SQL | new tests, this SQL |
|---|---|---|---|
| `tools/odds/no_bypass.test.js` | 102 / 0 | 102 / 1 | 103 / 0 |
| `tools/odds/gateway_sql.test.js` | 104 / 0 | 27 / 8, live layer aborts | 107 / 0 |
| `tools/odds/hourly_limits_sql.test.js` | 36 / 0 | 37 / 2 | 39 / 0 |
| `tools/sharp_lag/sharp_lag_sql.test.js` | — | — | 77 / 0 |
| `tools/sql/split_sql.test.js` | — | — | parts in sync |

Every assertion that existed before still holds. Three existing checks count
things the new fixture adds, and their expected numbers rise with it:
- paused jobs, 6 to 8;
- jobs in the fixture, 8 to 10;
- report rows, 12 to 13.

None of these checks is relaxed.

**Committed data:** none changes. This touches only the control plane's
functions and report. No ledger, snapshot or record row is rewritten.

**Budget effect:** none by itself. It changes what the stop can pause, not
what any job may buy.

## What it does in production, and when

Nothing until an operator acts:
- **Applying `odds_api_gateway.sql`** (Deploy odds gateway, or the parts in
  order) installs the new pattern list and resume. Report rows 1–13 should
  read `ok`. No job is paused or resumed, and the breaker and the budget are
  left as they are.
- **Applying `odds_api_hourly_limits.sql`** now considers the two jobs. Both
  run once a day, so neither schedule changes.
- **The emergency stop**, whether the file is applied again or
  `select public.odds_api_emergency_stop(...)` is called, now pauses the two
  Collective jobs with every other paid job, and `odds_api_resume_schedules()`
  brings them back.

The Collective's polls are refused today for a different reason: the gateway
has not confirmed the October cycle's quota (`denied_unconfirmed_quota`).
This change neither causes nor fixes that.
