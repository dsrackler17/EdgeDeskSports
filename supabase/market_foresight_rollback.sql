-- =============================================================================
-- market_foresight_rollback.sql — removes the Market Foresight layer
-- (supabase/market_foresight.sql). docs/market-foresight/README.md §Rollback.
--
-- FIRST TRY THE SWITCH. Turning the feature off needs no rollback:
--     select public.mf_owner_set_mode('off', 'why');
-- Every reader door then answers {mode: off}, the pages say so, and the hourly
-- job keeps nothing new public. That is fully reversible.
--
-- THIS FILE removes the layer's own objects: the mf_* tables (and with them
-- every derived measurement, its version history, the run log and any Kalshi
-- settlement verification an operator recorded) and the mf_* functions. It
-- touches NO source data: the forecast ledgers, the DraftKings quote ledger,
-- public.kalshi_* and collective.* are not referenced here. Every derived row
-- can be recomputed from those sources by the worker; operator verifications
-- cannot, so export them first if they matter:
--     select * from public.mf_settlement_verifications;
--
-- No psql meta-commands; ends in a report.
-- =============================================================================

begin;

drop function if exists public.mf_status();
drop function if exists public.mf_overview(jsonb);
drop function if exists public.mf_games_list(jsonb, text, integer);
drop function if exists public.mf_game(text, text);
drop function if exists public.mf_model(jsonb, text, integer);
drop function if exists public.mf_embed(text, text);
drop function if exists public.mf_admin_set_mode(text, text);
drop function if exists public.mf_admin_set_public_timeline(boolean, text);
drop function if exists public.mf_admin_runs(integer);
drop function if exists public.mf_admin_pending_rules();
drop function if exists public.mf_admin_verify_settlement(jsonb);
drop function if exists public.mf_require_admin();
drop function if exists public.mf_owner_set_mode(text, text);
drop function if exists public.mf_set_cfg(text, jsonb, uuid, text);
drop function if exists public.mf_job_begin(jsonb);
drop function if exists public.mf_job_require_run(uuid);
drop function if exists public.mf_job_known(text);
drop function if exists public.mf_job_verifications();
drop function if exists public.mf_job_put_games(uuid, jsonb);
drop function if exists public.mf_job_put_units(uuid, jsonb);
drop function if exists public.mf_job_put_summaries(uuid, jsonb, boolean);
drop function if exists public.mf_job_finish(uuid, jsonb);
drop function if exists public.mf_game_out(jsonb, boolean, boolean);
drop function if exists public.mf_unit_out(public.mf_units, boolean);
drop function if exists public.mf_strip_members(jsonb);
drop function if exists public.mf_visible(text, text);
drop function if exists public.mf_collective_visible(text);
drop function if exists public.mf_current_version();
drop function if exists public.mf_cursor_in(text);
drop function if exists public.mf_cursor_out(jsonb);
drop function if exists public.mf_reader();
drop function if exists public.mf_mode();
drop function if exists public.mf_cfg(text);

drop table if exists public.mf_summaries;
drop table if exists public.mf_unit_versions;
drop table if exists public.mf_units;
drop table if exists public.mf_game_versions;
drop table if exists public.mf_games;
drop table if exists public.mf_runs;
drop table if exists public.mf_settlement_verifications;
drop table if exists public.mf_methodologies;
drop table if exists public.mf_config_log;
drop table if exists public.mf_config;

drop function if exists public.mf_runs_guard();
drop function if exists public.mf_viewer_entitled();
drop function if exists public.mf_is_admin();
drop function if exists public.mf_keep();

commit;

notify pgrst, 'reload schema';

select 1 as row, 'no mf table remains' as check,
       case when not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname like 'mf\_%') then 'ok' else 'CHECK THIS' end as result
union all select 2, 'no mf function remains',
       case when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'mf\_%') then 'ok' else 'CHECK THIS' end;
