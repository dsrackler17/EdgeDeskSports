-- =============================================================================
-- research_grades_rollback — undo supabase/research_grades.sql.
--
-- Drops ONLY that file's objects. The committed ledger
-- (performance/ledger/research_grades/, performance/ledger/grade_outcomes/)
-- is the source of truth and is untouched; the boards and /performance/grades/
-- read the committed files, so they keep working. Re-applying
-- research_grades.sql and the next sync (tools/performance/sync.js) restores
-- the mirror from the ledger. supabase/model_performance.sql is not touched.
--
-- NOT REVERSIBLE: the server receipt times (server_recorded_at) of rows
-- already mirrored. A re-sync stamps them again with the time of the re-sync.
--
-- CONVENTION (supabase/README.md): idempotent, no psql meta-commands, ends in
-- a report.
-- =============================================================================

drop view if exists public.perf_grade_performance;
drop view if exists public.perf_grade_outcomes_latest;
drop function if exists public.perf_research_ingest(text, jsonb, text, text);
drop function if exists public.perf_research_heads();
drop table if exists public.perf_grade_outcomes;
drop table if exists public.perf_research_grades;
drop table if exists public.perf_rg_ingest_runs;
drop function if exists public.perf_rg_outcome_check();
drop function if exists public.perf_rg_append_only();
drop function if exists public.perf_rg_stamp();

notify pgrst, 'reload schema';

-- THE REPORT.
select 'research grade objects removed' as piece,
  case when to_regclass('public.perf_research_grades') is null and to_regclass('public.perf_grade_outcomes') is null and to_regclass('public.perf_rg_ingest_runs') is null
    and to_regclass('public.perf_grade_performance') is null and to_regclass('public.perf_grade_outcomes_latest') is null
    and not exists (select 1 from pg_proc where proname in ('perf_research_ingest', 'perf_research_heads', 'perf_rg_append_only', 'perf_rg_stamp', 'perf_rg_outcome_check')) then 'ok' else 'CHECK THIS' end as state;
