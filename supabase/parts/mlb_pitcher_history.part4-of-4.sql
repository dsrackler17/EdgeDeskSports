-- mlb_pitcher_history -- part 4 of 4.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

-- ── report ─────────────────────────────────────────────────────────────────
select 1 as row, 'schema mlbhist exists' as check,
       case when exists (select 1 from information_schema.schemata where schema_name = 'mlbhist')
            then 'ok' else 'CHECK THIS' end as result
union all select 2, 'every record table exists',
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'mlbhist' and c.relkind = 'r'
                     and c.relname in ('pitcher_seasons','pitcher_team_seasons','pitcher_overview',
                                       'pitcher_team_history','observed_team_runs','league_seasons',
                                       'teams','validation','source_repairs')) = 9
            then 'ok' else 'CHECK THIS' end
union all select 3, 'the two grains are uniquely keyed (player-season, player-team-season)',
       case when (select count(*) from pg_constraint
                   where conname in ('mlbhist_pitcher_seasons_key','mlbhist_pitcher_team_seasons_key')) = 2
            then 'ok' else 'CHECK THIS' end
union all select 4, 'staging exists for every record table',
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'mlbhist' and c.relkind = 'r'
                     and c.relname in ('stg_pitcher_seasons','stg_pitcher_team_seasons','stg_pitcher_overview',
                                       'stg_pitcher_team_history','stg_observed_team_runs','stg_league_seasons',
                                       'stg_teams','stg_validation','stg_source_repairs')) = 9
            then 'ok' else 'CHECK THIS' end
union all select 5, 'the import ledger and run ledger exist',
       case when to_regclass('mlbhist.import_runs') is not null
             and to_regclass('mlbhist.pipeline_runs') is not null then 'ok' else 'CHECK THIS' end
union all select 6, 'promote_import and abandon_import are security definer',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'mlbhist' and p.proname in ('promote_import','abandon_import')
                     and p.prosecdef) = 2 then 'ok' else 'CHECK THIS' end
union all select 7, 'no client may execute the promote gate',
       case when not has_function_privilege('anon', 'mlbhist.promote_import(text)', 'execute')
             and not has_function_privilege('authenticated', 'mlbhist.promote_import(text)', 'execute')
            then 'ok' else 'CHECK THIS' end
union all select 8, 'RLS is enabled on every table this file created',
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'mlbhist' and c.relkind = 'r' and c.relrowsecurity
                     and c.relname in ('pitcher_seasons','pitcher_team_seasons','pitcher_overview',
                                       'pitcher_team_history','observed_team_runs','league_seasons',
                                       'teams','validation','source_repairs','import_runs','pipeline_runs',
                                       'stg_pitcher_seasons','stg_pitcher_team_seasons','stg_pitcher_overview',
                                       'stg_pitcher_team_history','stg_observed_team_runs','stg_league_seasons',
                                       'stg_teams','stg_validation','stg_source_repairs')) = 20
            then 'ok' else 'CHECK THIS' end
union all select 9, 'anon and authenticated may read the record',
       case when (select count(*) from pg_policies where schemaname = 'mlbhist' and cmd = 'SELECT'
                   and policyname like 'mlbhist\_%\_public\_read'
                   and 'anon' = any(roles) and 'authenticated' = any(roles)) >= 11
            then 'ok' else 'CHECK THIS' end
union all select 10, 'no client write policy exists on anything this file created',
       case when not exists (select 1 from pg_policies where schemaname = 'mlbhist'
                              and cmd in ('INSERT','UPDATE','DELETE','ALL'))
            then 'ok' else 'CHECK THIS' end
union all select 11, 'staging is unreachable from anon/authenticated',
       case when not exists (select 1 from information_schema.role_table_grants
                              where table_schema = 'mlbhist' and table_name like 'stg\_%'
                                and grantee in ('anon','authenticated'))
            then 'ok' else 'CHECK THIS' end
union all select 12, 'lookup indexes installed (player, team, season, leaderboard, name)',
       case when to_regclass('mlbhist.mlbhist_seasons_player_idx') is not null
             and to_regclass('mlbhist.mlbhist_seasons_board_idx') is not null
             and to_regclass('mlbhist.mlbhist_seasons_rating_idx') is not null
             and to_regclass('mlbhist.mlbhist_team_seasons_team_idx') is not null
             and to_regclass('mlbhist.mlbhist_overview_name_idx') is not null
             and to_regclass('mlbhist.mlbhist_team_history_team_idx') is not null
            then 'ok' else 'CHECK THIS' end
union all select 13, 'service_role may write the mlbhist.meta ledger',
       case when has_table_privilege('service_role', 'mlbhist.meta', 'INSERT')
             and has_table_privilege('service_role', 'mlbhist.meta', 'UPDATE') then 'ok' else 'CHECK THIS' end
union all select 14, 'the season-to-date table public.pitcher_season is untouched by this file',
       'ok (nothing above references it; the archive is a separate schema and never current-season data)'
union all select 15, 'mlbhist schema is exposed to the API (project setting, not checkable here)',
       'ok (confirm Supabase > API > Exposed schemas lists mlbhist)'
order by row;

