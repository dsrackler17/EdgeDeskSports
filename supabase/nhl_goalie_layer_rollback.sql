-- =============================================================================
-- nhl_goalie_layer_rollback.sql — remove the NHL starting-goalie layer
-- (supabase/nhl_goalie_layer.sql and nhl_goalie_cron.sql). DESTRUCTIVE: every
-- starter observation, card version, edge event, CLV grade and run is dropped
-- with it. The research registry rows for NHL-GOALIE-V2 are left as they are
-- (a person retires a model). The slate (hockey/slate.json) is unaffected.
-- No psql meta-commands; ends in a report.
-- =============================================================================

do $c$ begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname in ('nhl_goalie_sync');
  end if;
end $c$;
drop function if exists public.nhl_goalie_poke();
drop table if exists public.nhl_goalie_pokes;
drop function if exists public.nhl_goalie_card(text);
drop view if exists public.nhl_goalie_meta, public.nhl_goalie_readiness, public.nhl_card_edge_clv_detail, public.nhl_game_cards_current, public.nhl_goalie_starters_current;
drop table if exists public.nhl_card_edge_clv, public.nhl_card_edge_events, public.nhl_game_cards, public.nhl_goalie_starters,
  public.nhl_goalie_alerts, public.nhl_goalie_sync_runs, public.nhl_goalie_config cascade;
drop function if exists public.nhl_card_edge_clv_check();
drop function if exists public.nhl_card_edge_attach();
drop function if exists public.nhl_game_card_version();
drop function if exists public.nhl_goalie_starter_guard();
drop function if exists public.nhl_goalie_starter_supersede();
drop function if exists public.nhl_goalie_status_rank(public.nhl_goalie_status);
drop function if exists public.nhl_goalie_keep();
drop type if exists public.nhl_goalie_status;
notify pgrst, 'reload schema';

select 'the NHL goalie layer is removed' as piece,
       case when to_regclass('public.nhl_goalie_starters') is null and to_regclass('public.nhl_game_cards') is null and to_regtype('public.nhl_goalie_status') is null then 'ok' else 'CHECK THIS' end as state;
