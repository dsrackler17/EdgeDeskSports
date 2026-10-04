# Runbook — tennis troubleshooting

| symptom | almost always | what to do |
|---|---|---|
| `the tennis record contract is not installed` | the migration has not run | `psql "$SUPABASE_DB_URL" -f supabase/tennis_record.sql`, then read the report |
| `PGRST106 Invalid schema: tennis` | the Data API is not serving the schema | Supabase → Project Settings → API → Exposed schemas → add `tennis` |
| `source "X" is not registered in tennis.source_licenses` | the licence gate | register the source with its licence before importing. This is the gate working. |
| `unregistered source "X"` from a trigger | same, at write time | as above |
| `the source is missing required columns` | the archive changed shape | do **not** force it. Diff the header against `M.REQUIRED_COLUMNS` and decide deliberately. |
| reconciliation `MISMATCH` | rows read ≠ accepted + rejected + skipped | the run is marked `error` and nothing derived from it. Re-run; if it persists, the source file is truncated. |
| import died halfway | anything | `npm run tennis:record:resume -- --file <same file>`. It resumes by checksum and adopts the original chunk size. |
| `resuming: no unfinished run over these bytes` | a different file | expected. A different file is a different run. |
| `permission denied for table model_predictions` as a signed-in reader | not entitled | **working as designed.** Prices are subscriber-only and the database enforces it. |
| `permission denied for table player_match_features` as *anyone* | correct | that table is private to the pipeline. Subscription or no subscription, no browser reads it. |
| board empty, fixtures on file | no ratings, no model, or no prices | check `ratings_computed_at` and `active_model_version` in `tennis.record_health`, then `select count(*) from tennis.odds_snapshots` |
| board empty, no fixtures | the draw has not synced | that is `tennis-sync.yml`, not the record jobs |
| every match reads `EXCLUDED` | usually no market price, or no active model | the reason codes on each card say which |
| `no ACTIVE tennis model is registered` | never promoted | `npm run tennis:model:build`. If it registers a *candidate*, it did not clear the gate — read the gate output. |
| model will not promote | it did not beat the baselines or calibration | that is the gate working. `--force` exists and records the override on the row. |
| `tennis.model_predictions is append-only` | something tried to edit a prediction | **working as designed.** Write a new prediction. |
| `this record is already settled` | a second settlement attempt | working as designed. Publish a correction; do not rewrite history. |
| ratings all near 50 | thin samples | correct behaviour — the rating is shrunk toward the tour median by sample. Check `rating_sample`. |
| a player has no rating | no matches on file, or the rating build has not run | `npm run tennis:ratings:build` |
| weather missing everywhere | expected | only confidently-resolved **outdoor** venues get weather, and it is a tournament-week profile. Indoor events get an explicit `indoor` row. |
| `no database connection` | env | set `SUPABASE_DB_URL` (or `DATABASE_URL`, or `EDGD_PG`) |
| `psql is not installed` | the runner | `apt-get install postgresql-client` |
| SQL suites say `SKIP` | no PostgreSQL reachable | expected locally; CI runs them with one |

## Reading the pipeline's own diary

```sql
-- the last run of every job
select distinct on (job) job, status, started_at, finished_at,
       rows_read, rows_inserted, rows_updated, rows_rejected, reconciled, error_summary
  from tennis.ingestion_runs order by job, started_at desc;

-- what is wrong with the data, most frequent first
select issue_type, severity, occurrences, field, detail
  from tennis.data_quality_issues where resolved_at is null
 order by occurrences desc limit 20;

-- what a specific import rejected, and why
select reject_reason, count(*) from tennis.stg_archive_matches
 where run_id = '<uuid>' and reject_reason is not null group by 1 order by 2 desc;
```

## The one thing never to do

Do not defeat an immutability trigger. If a prediction, a model evaluation or a
published record needs to change, the answer is a new row. The triggers raise
for every role including the service role precisely so that "we needed to fix it
quickly" cannot become an edit to a published record.
