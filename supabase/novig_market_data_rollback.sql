-- =============================================================================
-- novig_market_data_rollback.sql — removes the Novig market data layer
-- (supabase/novig_market_data.sql and supabase/novig_market_data_cron.sql).
-- docs/novig/README.md.
--
-- DESTRUCTIVE: every Novig snapshot, depth row, link, run, alert and config
-- change is dropped with its table. Export public.novig_book_snapshots and
-- public.novig_market_links first if the history matters.
-- Touches nothing else: public.signals and the DraftKings prices
-- (public.sharp_price_snapshots or public.book_quote_ticks, through the
-- layer's own view public.novig_dk_tape, dropped here) are read by the
-- layer, never written, and are left exactly as they are.
-- The Edge Function secrets (NOVIG_*) are not in the database; remove them
-- with `supabase secrets unset` if the integration is being retired.
-- =============================================================================

do $c$ begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname in ('novig_sync_probe', 'novig_sync_discover', 'novig_sync_snapshot', 'novig_prune');
  end if;
end $c$;

begin;
drop function if exists public.novig_poke(text);
drop view if exists public.novig_meta;
drop view if exists public.novig_readiness;
drop function if exists public.novig_access();
drop function if exists public.novig_price_gap_summary(timestamptz, timestamptz);
drop function if exists public.novig_history(text);
drop function if exists public.novig_compare(text, timestamptz, timestamptz, text);
drop function if exists public.novig_dk_price(text, text, text, numeric, timestamptz);
drop function if exists public.novig_dk_source();
drop view if exists public.novig_dk_tape;
drop function if exists public.novig_prune();
drop function if exists public.novig_record_unmapped(text, jsonb, text[], text[]);
drop table if exists public.novig_book_depth;
drop table if exists public.novig_alerts;
drop table if exists public.novig_market_links;
drop table if exists public.novig_book_snapshots;
drop table if exists public.novig_sync_runs;
drop table if exists public.novig_unmapped;
drop table if exists public.novig_markets;
drop table if exists public.novig_events;
drop table if exists public.novig_config_log;
drop table if exists public.novig_config;
drop function if exists public.novig_can_read();
drop function if exists public.novig_is_subscriber();
drop function if exists public.novig_is_operator();
drop function if exists public.novig_setting(text);
drop function if exists public.novig_config_audit();
drop function if exists public.novig_depth_guard();
drop function if exists public.novig_market_links_guard();
drop function if exists public.novig_keep();
drop function if exists public.novig_rule(text);
commit;

notify pgrst, 'reload schema';

select 'the Novig layer is removed' as piece,
       case when to_regclass('public.novig_book_snapshots') is null and to_regclass('public.novig_market_links') is null
             and to_regprocedure('public.novig_poke(text)') is null and to_regprocedure('public.novig_compare(text,timestamptz,timestamptz,text)') is null then 'ok' else 'CHECK THIS' end as state;
