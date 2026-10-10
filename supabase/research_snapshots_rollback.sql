-- =============================================================================
-- ROLLBACK for supabase/research_snapshots.sql. Drops exactly what that file
-- created. The committed ledger
-- (football/cfb_terminal/history/<season>/research_snapshots.jsonl) is the
-- source of truth and is untouched; re-applying the file and re-running
-- football/cfb_terminal/research_sync.js restores every row.
--
-- CONVENTION: idempotent, no psql meta-commands, ends in a report.
-- =============================================================================
drop view if exists public.research_snapshot_latest;
drop function if exists public.research_snapshots_ingest(jsonb);
drop table if exists public.research_snapshots;
drop function if exists public.research_snapshots_append_only();
notify pgrst, 'reload schema';

select 'research_snapshots removed' as piece,
       case when to_regclass('public.research_snapshots') is null and to_regprocedure('public.research_snapshots_ingest(jsonb)') is null then 'ok' else 'CHECK THIS' end as state;
