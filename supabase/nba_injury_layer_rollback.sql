-- =============================================================================
-- nba_injury_layer_rollback.sql — remove the NBA roster and injury layer
-- (supabase/nba_injury_layer.sql and nba_injury_cron.sql). DESTRUCTIVE: every
-- report, roster, projection and run is dropped with it. The research registry
-- rows for NBA-ROSTER-ADJ are left as they are (a person retires a model).
-- No psql meta-commands; ends in a report.
-- =============================================================================

do $c$ begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname in ('nba_injury_sync');
  end if;
end $c$;
drop function if exists public.nba_injury_poke();
drop function if exists public.nba_injury_card(text, text, text, timestamptz);
drop view if exists public.nba_injury_meta, public.nba_injury_readiness, public.nba_adjusted_projection_current,
  public.nba_player_status_current, public.nba_roster_changes, public.nba_roster_current;
drop table if exists public.nba_adjusted_projection_snapshots, public.nba_player_impact_snapshots, public.nba_injury_report_snapshots,
  public.nba_injury_reports, public.nba_roster_snapshots, public.nba_roster_captures, public.nba_injury_alerts, public.nba_injury_sync_runs,
  public.nba_injury_config cascade;
drop function if exists public.nba_adjusted_projection_registered();
drop function if exists public.nba_injury_keep();
notify pgrst, 'reload schema';

select 'the NBA injury layer is removed' as piece,
       case when to_regclass('public.nba_injury_reports') is null and to_regclass('public.nba_injury_sync_runs') is null then 'ok' else 'CHECK THIS' end as state;
