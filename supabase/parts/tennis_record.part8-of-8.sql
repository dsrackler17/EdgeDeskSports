-- tennis_record -- part 8 of 8.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

-- ===========================================================================
-- MAINTENANCE HELPERS. Used by the importer; not reachable from a browser.
-- ===========================================================================

-- Expensive secondary indexes are built AFTER a bulk backfill, not during it.
-- These two calls are what the importer brackets its COPY with.
create or replace function tennis.drop_backfill_indexes()
returns void
language plpgsql
security definer
set search_path = tennis, pg_temp
as $$
declare i text;
begin
  foreach i in array array['tennis_matches_winner_date_idx','tennis_matches_loser_date_idx',
                           'tennis_matches_surface_date_idx','tennis_matches_season_idx',
                           'tennis_matches_uid_idx','tennis_matches_tournament_idx',
                           'tennis_pmf_player_date_idx','tennis_pmf_surface_idx'] loop
    execute format('drop index if exists tennis.%I', i);
  end loop;
end $$;

create or replace function tennis.rebuild_backfill_indexes()
returns void
language plpgsql
security definer
set search_path = tennis, pg_temp
as $$
begin
  create index if not exists tennis_matches_winner_date_idx  on tennis.matches (winner_id, match_date desc);
  create index if not exists tennis_matches_loser_date_idx   on tennis.matches (loser_id, match_date desc);
  create index if not exists tennis_matches_surface_date_idx on tennis.matches (surface, match_date desc);
  create index if not exists tennis_matches_season_idx       on tennis.matches (tour, season desc, match_date desc);
  create index if not exists tennis_matches_uid_idx          on tennis.matches (source_match_uid);
  create index if not exists tennis_matches_tournament_idx   on tennis.matches (tournament_id, round_order);
  create index if not exists tennis_pmf_player_date_idx      on tennis.player_match_features (player_id, match_date desc);
  create index if not exists tennis_pmf_surface_idx          on tennis.player_match_features (surface, match_date);
  analyze tennis.matches;
  analyze tennis.player_match_features;
  analyze tennis.players;
end $$;

revoke all on function tennis.drop_backfill_indexes() from public, anon, authenticated;
revoke all on function tennis.rebuild_backfill_indexes() from public, anon, authenticated;
grant execute on function tennis.drop_backfill_indexes() to service_role;
grant execute on function tennis.rebuild_backfill_indexes() to service_role;

-- Record one data-quality issue, deduplicated. The importer calls this rather
-- than writing the table, so the dedup rule lives in one place.
create or replace function tennis.record_quality_issue(
  p_run_id uuid, p_source_key text, p_issue_type text, p_severity text,
  p_entity_type text, p_entity_key text, p_field text,
  p_observed text, p_expected text, p_detail text, p_payload jsonb default null)
returns bigint
language plpgsql
security definer
set search_path = tennis, pg_temp
as $$
declare id bigint;
begin
  insert into tennis.data_quality_issues
    (run_id, source_key, issue_type, severity, entity_type, entity_key, field,
     observed, expected, detail, payload)
  values (p_run_id, p_source_key, p_issue_type, coalesce(p_severity,'warn'),
          p_entity_type, p_entity_key, p_field, p_observed, p_expected, p_detail, p_payload)
  on conflict (issue_type, coalesce(entity_type,''), coalesce(entity_key,''), coalesce(field,''))
    where resolved_at is null
  do update set occurrences = tennis.data_quality_issues.occurrences + 1,
                last_seen_at = now(),
                run_id = excluded.run_id,
                detail = excluded.detail
  returning issue_id into id;
  return id;
end $$;
revoke all on function tennis.record_quality_issue(uuid, text, text, text, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function tennis.record_quality_issue(uuid, text, text, text, text, text, text, text, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- The freshness stamp the Tennis panel reads. Written here so a database that
-- has the contract but no rows yet still says which contract it has.
-- ---------------------------------------------------------------------------
insert into tennis.meta (key, value)
values ('record_contract', 'tennis_record.sql')
on conflict (key) do update set value = excluded.value;

notify pgrst, 'reload schema';

-- ===========================================================================
-- THE REPORT. Every row must read ok.
-- ===========================================================================
with checks as (
select 1::numeric as row, 'the licensing gate exists and the archive is registered non-commercial' as check,
       case when to_regclass('tennis.source_licenses') is not null
             and exists (select 1 from tennis.source_licenses
                          where source_key = 'archive' and commercial_use = false)
            then 'ok' else 'CHECK THIS' end as result
union all select 2, 'an unregistered source cannot be stored',
       case when (select count(*) from pg_trigger
                   where tgname in ('tennis_matches_license','tennis_players_license')) = 2
            then 'ok' else 'CHECK THIS' end
union all select 3, 'the record tables exist (players, matches, rankings)',
       case when to_regclass('tennis.players') is not null
             and to_regclass('tennis.matches') is not null
             and to_regclass('tennis.rankings_current') is not null then 'ok' else 'CHECK THIS' end
union all select 4, 'the five record views app.html has always read exist',
       case when to_regclass('tennis.player_career') is not null
             and to_regclass('tennis.player_season') is not null
             and to_regclass('tennis.player_surface') is not null
             and to_regclass('tennis.player_form') is not null
             and to_regclass('tennis.h2h') is not null then 'ok' else 'CHECK THIS' end
union all select 5, 'the point-in-time feature table exists and is PRIVATE',
       case when to_regclass('tennis.player_match_features') is not null
             and not has_table_privilege('anon', 'tennis.player_match_features', 'SELECT')
             and not has_table_privilege('authenticated', 'tennis.player_match_features', 'SELECT')
            then 'ok' else 'CHECK THIS' end
union all select 6, 'staging is private too',
       case when to_regclass('tennis.stg_archive_matches') is not null
             and not has_table_privilege('anon', 'tennis.stg_archive_matches', 'SELECT')
             and not has_table_privilege('authenticated', 'tennis.stg_archive_matches', 'SELECT')
            then 'ok' else 'CHECK THIS' end
union all select 7, 'ratings, venues and weather exist',
       case when to_regclass('tennis.player_ratings_current') is not null
             and to_regclass('tennis.venues') is not null
             and to_regclass('tennis.weather_observations') is not null then 'ok' else 'CHECK THIS' end
union all select 8, 'the market, model and research layers exist',
       case when to_regclass('tennis.odds_snapshots') is not null
             and to_regclass('tennis.model_registry') is not null
             and to_regclass('tennis.model_predictions') is not null
             and to_regclass('tennis.research_opportunities') is not null then 'ok' else 'CHECK THIS' end
union all select 9, 'a prediction cannot be rewritten and a model version cannot be edited',
       case when (select count(*) from pg_trigger
                   where tgname in ('tennis_pred_freeze','tennis_model_freeze','tennis_rec_freeze')) = 3
            then 'ok' else 'CHECK THIS' end
union all select 10, 'at most one active model per family',
       case when to_regclass('tennis.tennis_model_one_active_idx') is not null then 'ok' else 'CHECK THIS' end
union all select 11, 'operations tables exist (runs, data quality)',
       case when to_regclass('tennis.ingestion_runs') is not null
             and to_regclass('tennis.data_quality_issues') is not null then 'ok' else 'CHECK THIS' end
union all select 12, 'anon may READ the public record layer',
       case when has_table_privilege('anon', 'tennis.players', 'SELECT')
             and has_table_privilege('anon', 'tennis.matches', 'SELECT')
             and has_table_privilege('anon', 'tennis.player_ratings_current', 'SELECT')
            then 'ok' else 'CHECK THIS' end
union all select 13, 'anon may NOT read predictions, prices or opportunities',
       case when not has_table_privilege('anon', 'tennis.model_predictions', 'SELECT')
             and not has_table_privilege('anon', 'tennis.odds_snapshots', 'SELECT')
             and not has_table_privilege('anon', 'tennis.research_opportunities', 'SELECT')
            then 'ok' else 'CHECK THIS' end
union all select 14, 'no client role may WRITE anything in this contract',
       case when not exists (
              select 1 from information_schema.role_table_grants
               where table_schema = 'tennis'
                 and grantee in ('anon','authenticated')
                 and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
                 and table_name in ('players','matches','rankings_current','player_ratings_current',
                                    'venues','weather_observations','odds_snapshots','model_registry',
                                    'model_predictions','research_opportunities','prediction_record',
                                    'player_match_features','stg_archive_matches','ingestion_runs',
                                    'data_quality_issues','source_licenses'))
            then 'ok' else 'CHECK THIS' end
union all select 15, 'row level security is on for every table this file creates',
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'tennis' and c.relkind = 'r' and c.relrowsecurity
                     and c.relname in ('players','matches','rankings_current','player_ratings_current',
                                       'venues','weather_observations','odds_snapshots','model_registry',
                                       'model_predictions','research_opportunities','prediction_record',
                                       'player_match_features','stg_archive_matches','ingestion_runs',
                                       'data_quality_issues','source_licenses')) = 16
            then 'ok' else 'CHECK THIS' end
union all select 16, 'the subscriber policies use the project entitlement rule',
       case when (select count(*) from pg_policies
                   where schemaname = 'tennis'
                     and policyname like '%subscriber_read'
                     and qual like '%viewer_is_entitled%') >= 3
            then 'ok' else 'CHECK THIS' end
union all select 17, 'the exposed views are security_invoker',
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'tennis' and c.relkind = 'v'
                     and c.relname in ('player_career','player_surface','player_form','h2h',
                                       'player_profile','board_public','board_research',
                                       'board_current','match_context','record_health')
                     and c.reloptions::text like '%security_invoker=true%') = 10
            then 'ok' else 'CHECK THIS' end
union all select 18, 'anon cannot reach the priced views',
       case when not has_table_privilege('anon', 'tennis.board_research', 'SELECT')
             and not has_table_privilege('anon', 'tennis.board_current', 'SELECT')
             and not has_table_privilege('anon', 'tennis.match_context', 'SELECT')
            then 'ok' else 'CHECK THIS' end
union all select 19, 'every privileged function has a fixed search_path and no public execute',
       case when not exists (
              select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'tennis' and p.prosecdef
                 and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c
                                  where c like 'search_path=%'))
            and not exists (
              select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'tennis' and p.prosecdef
                 and has_function_privilege('public', p.oid, 'EXECUTE'))
            then 'ok' else 'CHECK THIS' end
union all select 19.5, 'the health line is readable WITHOUT reading a private table',
       case when (select count(*) from tennis.record_health) = 1
             and to_regprocedure('tennis.ops_health()') is not null
             and has_function_privilege('anon', 'tennis.ops_health()', 'EXECUTE')
             and not has_table_privilege('anon', 'tennis.ingestion_runs', 'SELECT')
            then 'ok' else 'CHECK THIS' end
union all select 20, 'the AI context functions exist',
       case when to_regprocedure('tennis.ai_surface_leaders(text, text, integer)') is not null
             and to_regprocedure('tennis.ai_market_disagreement(text, integer)') is not null
             and to_regprocedure('tennis.ai_player_context(text)') is not null
             and to_regprocedure('tennis.ai_match_context(text)') is not null
             and to_regprocedure('tennis.ai_data_health()') is not null then 'ok' else 'CHECK THIS' end
union all select 21, 'the public record and calibration views exist',
       case when to_regclass('tennis.prediction_record') is not null
             and to_regclass('tennis.public_record_summary') is not null
             and to_regclass('tennis.public_record_calibration') is not null then 'ok' else 'CHECK THIS' end
union all select 22, 'the LIVE contract is untouched by this file',
       case when to_regclass('tennis.live_matches') is null then 'ok (live contract not installed)'
            when (select count(*) from pg_policies
                   where schemaname = 'tennis' and tablename = 'live_matches') >= 1
            then 'ok (live tables keep their own policies)' else 'CHECK THIS' end
union all select 23, 'tennis.tournaments gained the archive columns and kept its own door',
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'tennis' and table_name = 'tournaments'
                            and column_name = 'season')
             and has_table_privilege('anon', 'tennis.tournaments', 'SELECT')
             and not has_table_privilege('anon', 'tennis.tournaments', 'INSERT')
            then 'ok' else 'CHECK THIS' end
union all select 24, 'the schema is served by the Data API',
       case when exists (select 1 from pg_roles r, unnest(coalesce(r.rolconfig, '{}')) c
                          where r.rolname = 'authenticator' and c like 'pgrst.db_schemas=%'
                            and c like '%tennis%')
            then 'ok'
            when not exists (select 1 from pg_roles where rolname = 'authenticator')
            then 'ok (no authenticator role — not a Supabase project)'
            else 'CHECK THIS — add tennis under Project Settings > API > Exposed schemas' end
)
select "row"::text as row, "check", result from checks order by "row";

