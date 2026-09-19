# Runbook — tennis daily updates and monitoring

## The scheduled jobs

`.github/workflows/tennis-record.yml`. All times UTC.

| cron | job | what it does |
|---|---|---|
| `35 5 * * *` | **nightly** | rebuild point-in-time features → rebuild the rating layer → refresh rankings |
| `15 */2 * * *` | **board** | take in results → settle the published record → re-price the board |
| `20 7 * * 1` | **weekly** | venue/weather backfill, model calibration review |
| `50 * * * *` | **monitor** | read-only health report |

The existing `tennis-sync.yml` (every 6h) and `tennis-live.yml` (gate every 30m)
are unchanged and still own the draw, identity and the live match centre.

**The historical backfill is on no schedule.** It is a one-off administrative
act against a licence-restricted archive; putting it on a timer would make an
accidental re-import a cron away.

## Order matters

Features → ratings, because the rating layer reads the feature rows. Results →
settlement → board, because a finished match should be settled before the board
is rebuilt, so it does not reappear as researchable.

## The monitoring checklist

Run `npm run tennis:status`, or read `tennis.record_health`. Act on:

- [ ] **every job has an `ok` inside its own cadence** — nightly within 24h,
      board within 3h, monitor within 2h
- [ ] **`reconciled` is `yes` on the last import** — a `NO` means the run is
      marked `error` and nothing downstream used it
- [ ] **`failed_runs_7d` is 0** — otherwise read `error_summary` on the run
- [ ] **`ratings_computed_at` is inside 36 hours** — the board stamps this on
      every card, so a stale rating layer is visible to readers before it is
      visible to you
- [ ] **`active_model_version` is not null** — no active model means no prices
- [ ] **`open_data_issues` is not climbing** — a rising count usually means the
      source changed shape
- [ ] **`record_cleared_for_commercial_use`** — `false` is expected today and
      the board says so on screen. If it flips to `true`, somebody registered a
      commercial licence; make sure that was deliberate.
- [ ] **`open_opportunities` is non-zero during a tour week** — zero with
      fixtures on file means ratings, a model or prices are missing

## When a job fails

**The cursor does not advance on failure.** The next run re-reads the same
window, so a transient failure heals itself and a persistent one keeps saying so
rather than silently skipping a day.

```sql
select job, status, started_at, finished_at, rows_read, rows_rejected, error_summary
  from tennis.ingestion_runs
 where status = 'error' and started_at > now() - interval '7 days'
 order by started_at desc;
```

## Freshness, as the reader sees it

Every board card carries three timestamps — when the ratings were built, when
the price was captured, and which model version produced the number. A stale
layer therefore shows up on the page, not only in this runbook. That is
deliberate: a research surface that hides its own staleness is worse than one
that has none.

## What a failed provider does NOT do

It does not erase anything. A provider that stops mentioning a match has not
un-played it; `tools/tennis/providers/index.js` states this as policy and no job
in this system contains a delete. A source omitting a record is recorded as a
data-quality observation and the row stays.
