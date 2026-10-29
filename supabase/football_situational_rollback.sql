-- =============================================================================
-- football_situational_rollback — removes everything supabase/football_situational.sql
-- added, and nothing else.
--
-- The engine never wrote to any table but its own fsie_* tables, and no
-- existing model reads them (every integration is SHADOW: 0 points applied),
-- so dropping them changes no published number. Run it only after
-- FSIE_MODE=OFF (football/situational/config/integration.json) is committed —
-- otherwise the next scheduled sync recreates rows into missing tables and
-- fails loudly, which is the intended behaviour, not a silent loss.
--
-- CONVENTION (supabase/README.md): idempotent, no psql meta-commands, ends in
-- a report. Safe to run again.
-- =============================================================================

drop view if exists public.fsie_team_games_current;
drop function if exists public.fsie_prune(int);
drop table if exists public.fsie_clv_evaluations;
drop table if exists public.fsie_prop_comparisons;
drop table if exists public.fsie_player_projections;
drop table if exists public.fsie_team_projections;
drop table if exists public.fsie_shadow_integrations;
drop table if exists public.fsie_tendencies;
drop table if exists public.fsie_coverage;
drop table if exists public.fsie_quality_failures;
drop table if exists public.fsie_team_games;
drop table if exists public.fsie_source_files;
drop table if exists public.fsie_pipeline_runs;
drop function if exists public.fsie_frozen();

notify pgrst, 'reload schema';

select piece, state from (
  select 'no fsie table remains' as piece, case when not exists (select 1 from pg_class where relnamespace = 'public'::regnamespace and relname like 'fsie\_%') then 'ok' else 'CHECK THIS' end as state
  union all select 'no fsie function remains', case when not exists (select 1 from pg_proc where proname like 'fsie\_%') then 'ok' else 'CHECK THIS' end
) r order by 1;
