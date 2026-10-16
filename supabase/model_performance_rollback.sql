-- =============================================================================
-- model_performance_rollback — undo supabase/model_performance.sql.
--
-- Drops ONLY that file's objects. The committed ledger
-- (performance/ledger/*.jsonl) is the source of truth and is untouched; the
-- public page reads the committed files, so it keeps working. Re-applying
-- model_performance.sql and the next sync (tools/performance/sync.js)
-- restores the mirror from the ledger.
--
-- NOT REVERSIBLE: the server receipt times (server_recorded_at) of rows
-- already mirrored. A re-sync stamps them again with the time of the re-sync.
--
-- CONVENTION (supabase/README.md): idempotent, no psql meta-commands, ends in
-- a report.
-- =============================================================================

drop view if exists public.perf_forecast_attestation;
drop function if exists public.perf_ingest(text, jsonb, text, text);
drop function if exists public.perf_heads();
drop table if exists public.perf_grades;
drop table if exists public.perf_results;
drop table if exists public.perf_quotes;
drop table if exists public.perf_forecasts;
drop table if exists public.perf_ingest_runs;
drop function if exists public.perf_append_only();
drop function if exists public.perf_stamp();

notify pgrst, 'reload schema';

-- THE REPORT.
select 'perf objects removed' as piece,
  case when to_regclass('public.perf_forecasts') is null and to_regclass('public.perf_quotes') is null and to_regclass('public.perf_results') is null
    and to_regclass('public.perf_grades') is null and to_regclass('public.perf_ingest_runs') is null
    and not exists (select 1 from pg_proc where proname in ('perf_ingest', 'perf_heads', 'perf_append_only', 'perf_stamp')) then 'ok' else 'CHECK THIS' end as state;
