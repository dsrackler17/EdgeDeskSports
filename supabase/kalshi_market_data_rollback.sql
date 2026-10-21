-- =============================================================================
-- kalshi_market_data_rollback.sql — removes the Kalshi market data layer
-- (supabase/kalshi_market_data.sql and supabase/kalshi_market_data_cron.sql).
-- README §Kalshi market data.
--
-- DESTRUCTIVE: every Kalshi snapshot, link, run and alert is dropped with its
-- table. Export public.kalshi_price_snapshots first if the history matters.
-- Touches nothing else: public.signals and public.signal_ticks are read by the
-- layer, never written, and are left exactly as they are.
-- =============================================================================

do $c$ begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname in ('kalshi_sync_snapshot', 'kalshi_sync_discover');
  end if;
end $c$;

begin;
drop function if exists public.kalshi_poke(text);
drop view if exists public.kalshi_meta;
drop view if exists public.kalshi_readiness;
drop view if exists public.kalshi_card_current;
drop view if exists public.kalshi_book_closing_comparison;
drop view if exists public.kalshi_book_comparison;
drop view if exists public.kalshi_close_capture_health;
drop view if exists public.kalshi_closing_snapshot;
drop view if exists public.kalshi_market_close_ref;
drop view if exists public.kalshi_snapshot_mid;
drop table if exists public.kalshi_alerts;
drop table if exists public.kalshi_game_links;
drop table if exists public.kalshi_price_snapshots;
drop table if exists public.kalshi_sync_runs;
drop table if exists public.kalshi_markets;
drop table if exists public.kalshi_link_series;
drop table if exists public.kalshi_series;
drop function if exists public.kalshi_game_links_guard();
drop function if exists public.kalshi_keep();
drop function if exists public.kalshi_rule(text);
commit;

notify pgrst, 'reload schema';

select 'the Kalshi layer is removed' as piece,
       case when to_regclass('public.kalshi_price_snapshots') is null and to_regclass('public.kalshi_game_links') is null
             and to_regprocedure('public.kalshi_poke(text)') is null then 'ok' else 'CHECK THIS' end as state;
