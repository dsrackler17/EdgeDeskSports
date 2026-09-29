-- props_factory -- part 6 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

grant select on props.v_observed_prop_quotes, props.v_training_prop_quotes, props.v_latest_prop_quotes, props.v_prop_line_shopping, props.v_prop_movement,
  props.v_latest_predictions, props.v_prop_quote_eval to authenticated;
grant select on all tables in schema props to service_role;
grant execute on function props.dist_cdf(jsonb, numeric), props.dist_probs(jsonb, numeric), props.american_to_decimal(int), props.fair_american(numeric, numeric) to anon, authenticated, service_role;
revoke all on function props.ingest_prop_quotes(jsonb, text) from public, anon, authenticated;
revoke all on function props.promote_player_games(text) from public, anon, authenticated;
grant execute on function props.ingest_prop_quotes(jsonb, text), props.promote_player_games(text) to service_role;
revoke all on function props.ai_prop_context(text, text, text), props.ai_prop_board(text, int), props.ai_data_health(), props.run_quality_checks() from public;
grant execute on function props.ai_prop_context(text, text, text), props.ai_prop_board(text, int), props.ai_data_health(), props.run_quality_checks() to authenticated, service_role;
grant usage, select on all sequences in schema props to service_role;

notify pgrst, 'reload schema';

-- ===========================================================================
-- THE REPORT. Every row must read ok.
-- ===========================================================================
with checks as (
select 1 as row, 'the props schema and its core tables exist' as guarantee,
  case when to_regclass('props.dim_player') is not null and to_regclass('props.dim_game') is not null and to_regclass('props.fact_player_game') is not null
        and to_regclass('props.fact_prop_quote') is not null and to_regclass('props.fact_prop_result') is not null and to_regclass('props.fact_feature_snapshot') is not null
        and to_regclass('props.model_prediction') is not null and to_regclass('props.bridge_cfb_nfl_player') is not null then 'ok' else 'CHECK THIS' end as status
union all select 2, 'quotes are append-only for every role (update, delete and truncate refused)',
  case when (select count(*) from pg_trigger where tgrelid = 'props.fact_prop_quote'::regclass and tgname in ('props_quote_immutable','props_quote_no_truncate')) = 2 then 'ok' else 'CHECK THIS' end
union all select 3, 'lineage is required, never defaulted, and a reconstructed line cannot name a sportsbook provider',
  case when exists (select 1 from pg_constraint where conname = 'props_quote_lineage') and exists (select 1 from pg_constraint where conname = 'props_quote_lineage_provider')
        and (select column_default from information_schema.columns where table_schema = 'props' and table_name = 'fact_prop_quote' and column_name = 'lineage') is null then 'ok' else 'CHECK THIS' end
union all select 4, 'a backtest decision can only stand on an observed pregame quote',
  case when exists (select 1 from pg_trigger where tgname = 'props_backtest_observed') then 'ok' else 'CHECK THIS' end
union all select 5, 'features obey source_max_timestamp <= asof_at <= kickoff and are append-only',
  case when exists (select 1 from pg_constraint where conname = 'props_feature_pit') and exists (select 1 from pg_trigger where tgname = 'props_feature_pregame')
        and exists (select 1 from pg_trigger where tgname = 'props_feature_immutable') then 'ok' else 'CHECK THIS' end
union all select 6, 'predictions are immutable, pregame and name their model version',
  case when exists (select 1 from pg_trigger where tgname = 'props_prediction_immutable') and exists (select 1 from pg_trigger where tgname = 'props_prediction_pregame')
        and exists (select 1 from pg_constraint where conrelid = 'props.model_prediction'::regclass and contype = 'f' and pg_get_constraintdef(oid) like '%model_registry%') then 'ok' else 'CHECK THIS' end
union all select 7, 'the record is frozen before kickoff and graded once',
  case when exists (select 1 from pg_trigger where tgname = 'props_record_freeze') then 'ok' else 'CHECK THIS' end
union all select 8, 'the catalog is seeded (27 markets, 15 quality rules, 20 folds, 18 jobs)',
  case when (select count(*) from props.prop_catalog) >= 27 and (select count(*) from props.quality_rules) = 15 and (select count(*) from props.backtest_splits) = 20
        and (select count(*) from props.pipeline_jobs) = 18 then 'ok' else 'CHECK THIS' end
union all select 9, 'provider labels map to canonical markets (player_pass_yds -> pass_yards)',
  case when (select market_key from props.provider_market_map where provider = 'the-odds-api' and provider_market_key = 'player_pass_yds') = 'pass_yards' then 'ok' else 'CHECK THIS' end
union all select 10, 'the distribution arithmetic prices a line (dist_probs)',
  case when (select round(p_over, 4) from props.dist_probs('{"t":"bern","p":0.4}'::jsonb, null)) = 0.4
        and (select round(p_push, 4) from props.dist_probs('{"t":"pmf","v":[0.2,0.3,0.5],"tail":0}'::jsonb, 1)) = 0.3 then 'ok' else 'CHECK THIS' end
union all select 11, 'staging, raw payloads, features, quarantine and corrections are private',
  case when not has_table_privilege('anon', 'props.stg_player_game', 'SELECT') and not has_table_privilege('authenticated', 'props.raw_odds_payloads', 'SELECT')
        and not has_table_privilege('authenticated', 'props.fact_feature_snapshot', 'SELECT') and not has_table_privilege('authenticated', 'props.quarantine', 'SELECT')
        and not has_table_privilege('anon', 'props.fact_corrections', 'SELECT') then 'ok' else 'CHECK THIS' end
union all select 12, 'the website board view and the AI doors exist',
  case when to_regclass('props.v_player_props_board') is not null and to_regprocedure('props.ai_prop_context(text,text,text)') is not null
        and to_regprocedure('props.ai_data_health()') is not null then 'ok' else 'CHECK THIS' end
union all select 13, 'every quality rule has a query',
  case when (select count(*) from props.run_quality_checks()) = 15 then 'ok' else 'CHECK THIS' end
union all select 14, 'the ingestion doors belong to the service role only',
  case when not has_function_privilege('anon', 'props.ingest_prop_quotes(jsonb,text)', 'EXECUTE') and not has_function_privilege('authenticated', 'props.ingest_prop_quotes(jsonb,text)', 'EXECUTE')
        and has_function_privilege('service_role', 'props.ingest_prop_quotes(jsonb,text)', 'EXECUTE') then 'ok' else 'CHECK THIS' end
)
select row, guarantee, status from checks order by row;

