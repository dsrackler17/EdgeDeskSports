-- =============================================================================
-- independent_projections_rollback.sql — reverses supabase/independent_projections.sql.
--
-- Removes the two multi-sport research ledgers (projection_snapshots,
-- market_comparisons), their triggers and functions. Run it only to undo the
-- migration: it deletes the rows those ledgers hold. Nothing else is touched —
-- no betting record, research packet, audit or billing relation. The edge
-- function keeps answering without the tables: its writes fail, are reported
-- as failed (status only) and the answer stands.
-- =============================================================================
drop table if exists public.market_comparisons;
drop table if exists public.projection_snapshots;
drop function if exists public.market_comparisons_frozen_check();
drop function if exists public.projection_snapshots_check();
drop function if exists public.independent_projections_prune(int);
drop function if exists public.independent_projections_immutable();
drop function if exists public.independent_projections_no_delete();
notify pgrst, 'reload schema';
select 'independent projections ledgers removed' as piece,
  case when to_regclass('public.projection_snapshots') is null and to_regclass('public.market_comparisons') is null then 'ok' else 'CHECK THIS' end as state;
