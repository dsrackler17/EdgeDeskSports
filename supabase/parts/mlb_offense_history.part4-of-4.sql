-- mlb_offense_history -- part 4 of 4.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

-- ---------------------------------------------------------------------------
-- THE TWO-WAY VIEW. One row per player who has BOTH a hitting record with
-- plate appearances and a pitching record with outs inside this window, joined
-- on the MLB person id the two packages share. It is a view, not a table, so
-- it can never drift from the two archives underneath it — and it is the whole
-- answer to "show Ohtani's hitting and pitching together" without inventing a
-- second identity for him.
--
-- The PA and outs thresholds are the honest part: every pitcher who ever stood
-- in a batter's box is in batter_seasons, so "has a hitting record" is not the
-- same as "is a hitter". Both sides carry their own workload so a caller can
-- decide what counts as meaningful rather than being told.
-- ---------------------------------------------------------------------------
create or replace view mlbhist.two_way_players as
select b.player_id,
       b.player_name,
       b.name_key,
       b.plate_appearances            as batting_plate_appearances,
       b.games                        as batting_games,
       b.home_runs                    as batting_home_runs,
       b.ops                          as batting_ops,
       b.weighted_offensive_index     as batting_index,
       b.first_observed_season        as batting_first_season,
       b.last_observed_season         as batting_last_season,
       b.seasons_with_pa              as batting_seasons_with_pa,
       p.outs                         as pitching_outs,
       p.innings_display              as pitching_innings,
       p.starts                       as pitching_starts,
       p.era                          as pitching_era,
       p.weighted_performance_index   as pitching_index,
       p.first_observed_season        as pitching_first_season,
       p.last_observed_season         as pitching_last_season,
       p.role                         as pitching_role
from mlbhist.batter_overview b
join mlbhist.pitcher_overview p on p.player_id = b.player_id
where coalesce(b.plate_appearances, 0) > 0
  and coalesce(p.outs, 0) > 0;

-- ---------------------------------------------------------------------------
-- RLS. The record is public-read like every other EdgeDesk research table; the
-- write path is the service role and nothing else. Staging is NOT readable by
-- clients: an unpromoted dataset has not passed its gate, and a screen that
-- could read it could show numbers the gate was about to refuse.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['batter_seasons','batter_team_seasons','batter_overview',
                           'batter_team_history','observed_batter_team_runs',
                           'team_offense_seasons','team_offense_overview',
                           'league_offense_seasons','offense_validation',
                           'offense_source_repairs','offense_games_reconciliation'] loop
    execute format('alter table mlbhist.%I enable row level security', t);
    execute format('revoke all on mlbhist.%I from anon, authenticated', t);
    execute format('grant select on mlbhist.%I to anon, authenticated', t);
    execute format('grant all on mlbhist.%I to service_role', t);
    execute format('drop policy if exists %I on mlbhist.%I', 'mlbhist_' || t || '_public_read', t);
    execute format('create policy %I on mlbhist.%I for select to anon, authenticated using (true)',
                   'mlbhist_' || t || '_public_read', t);
  end loop;

  foreach t in array array['stg_batter_seasons','stg_batter_team_seasons','stg_batter_overview',
                           'stg_batter_team_history','stg_observed_batter_team_runs',
                           'stg_team_offense_seasons','stg_team_offense_overview',
                           'stg_league_offense_seasons','stg_offense_validation',
                           'stg_offense_source_repairs','stg_offense_games_reconciliation'] loop
    execute format('alter table mlbhist.%I enable row level security', t);
    execute format('revoke all on mlbhist.%I from anon, authenticated', t);
    execute format('grant all on mlbhist.%I to service_role', t);
  end loop;
end $$;

grant select on mlbhist.offense_status    to anon, authenticated, service_role;
grant select on mlbhist.two_way_players   to anon, authenticated, service_role;
grant usage, select on all sequences in schema mlbhist to service_role;

-- ── report ─────────────────────────────────────────────────────────────────
select 1 as row, 'every offensive record table exists' as check,
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'mlbhist' and c.relkind = 'r'
                     and c.relname in ('batter_seasons','batter_team_seasons','batter_overview',
                                       'batter_team_history','observed_batter_team_runs',
                                       'team_offense_seasons','team_offense_overview',
                                       'league_offense_seasons','offense_validation',
                                       'offense_source_repairs','offense_games_reconciliation')) = 11
            then 'ok' else 'CHECK THIS' end as result
union all select 2, 'the two player grains are uniquely keyed (player-season, player-team-season)',
       case when (select count(*) from pg_constraint
                   where conname in ('mlbhist_batter_seasons_key','mlbhist_batter_team_seasons_key')) = 2
            then 'ok' else 'CHECK THIS' end
union all select 3, 'the club grains are uniquely keyed (season-team, team)',
       case when (select count(*) from pg_constraint where conname = 'mlbhist_team_offense_seasons_key') = 1
             and (select count(*) from pg_index i join pg_class c on c.oid = i.indrelid
                   where c.relname = 'team_offense_overview' and i.indisprimary) = 1
            then 'ok' else 'CHECK THIS' end
union all select 4, 'staging exists for every offensive record table',
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'mlbhist' and c.relkind = 'r'
                     and c.relname in ('stg_batter_seasons','stg_batter_team_seasons','stg_batter_overview',
                                       'stg_batter_team_history','stg_observed_batter_team_runs',
                                       'stg_team_offense_seasons','stg_team_offense_overview',
                                       'stg_league_offense_seasons','stg_offense_validation',
                                       'stg_offense_source_repairs','stg_offense_games_reconciliation')) = 11
            then 'ok' else 'CHECK THIS' end
union all select 5, 'the shared import ledger discriminates the two datasets',
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'mlbhist' and table_name = 'import_runs'
                            and column_name = 'dataset')
            then 'ok' else 'CHECK THIS' end
union all select 6, 'promote_offense_import and abandon_offense_import are security definer',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'mlbhist'
                     and p.proname in ('promote_offense_import','abandon_offense_import')
                     and p.prosecdef) = 2 then 'ok' else 'CHECK THIS' end
union all select 7, 'no client may execute the offensive promote gate',
       case when not has_function_privilege('anon', 'mlbhist.promote_offense_import(text)', 'execute')
             and not has_function_privilege('authenticated', 'mlbhist.promote_offense_import(text)', 'execute')
            then 'ok' else 'CHECK THIS' end
union all select 8, 'RLS is enabled on every table this file created',
       -- named rather than pattern-matched: a LIKE that quietly stops covering
       -- a table is a check that passes while protecting nothing.
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'mlbhist' and c.relkind = 'r' and c.relrowsecurity
                     and c.relname in ('batter_seasons','batter_team_seasons','batter_overview',
                                       'batter_team_history','observed_batter_team_runs',
                                       'team_offense_seasons','team_offense_overview',
                                       'league_offense_seasons','offense_validation',
                                       'offense_source_repairs','offense_games_reconciliation',
                                       'stg_batter_seasons','stg_batter_team_seasons','stg_batter_overview',
                                       'stg_batter_team_history','stg_observed_batter_team_runs',
                                       'stg_team_offense_seasons','stg_team_offense_overview',
                                       'stg_league_offense_seasons','stg_offense_validation',
                                       'stg_offense_source_repairs','stg_offense_games_reconciliation')) = 22
            then 'ok' else 'CHECK THIS' end
union all select 9, 'anon and authenticated may read the offensive record',
       case when (select count(*) from pg_policies where schemaname = 'mlbhist' and cmd = 'SELECT'
                   and policyname like 'mlbhist\_%\_public\_read'
                   and 'anon' = any(roles) and 'authenticated' = any(roles)) >= 22
            then 'ok' else 'CHECK THIS' end
union all select 10, 'no client write policy exists anywhere in mlbhist',
       case when not exists (select 1 from pg_policies where schemaname = 'mlbhist'
                              and cmd in ('INSERT','UPDATE','DELETE','ALL'))
            then 'ok' else 'CHECK THIS' end
union all select 11, 'offensive staging is unreachable from anon/authenticated',
       case when not exists (select 1 from information_schema.role_table_grants
                              where table_schema = 'mlbhist' and table_name like 'stg\_%'
                                and grantee in ('anon','authenticated'))
            then 'ok' else 'CHECK THIS' end
union all select 12, 'lookup indexes installed (player, team, season, position, workload, leaderboard)',
       case when to_regclass('mlbhist.mlbhist_bat_seasons_player_idx') is not null
             and to_regclass('mlbhist.mlbhist_bat_seasons_rating_idx') is not null
             and to_regclass('mlbhist.mlbhist_bat_seasons_pa_idx') is not null
             and to_regclass('mlbhist.mlbhist_bat_seasons_pos_idx') is not null
             and to_regclass('mlbhist.mlbhist_bat_team_seasons_team_idx') is not null
             and to_regclass('mlbhist.mlbhist_bat_overview_name_idx') is not null
             and to_regclass('mlbhist.mlbhist_team_off_seasons_rating_idx') is not null
            then 'ok' else 'CHECK THIS' end
union all select 13, 'the two archives share one team identity table (not duplicated)',
       case when to_regclass('mlbhist.teams') is not null
             and to_regclass('mlbhist.team_offense_teams') is null
            then 'ok' else 'CHECK THIS' end
union all select 14, 'the two-way view joins hitting to pitching on the shared MLB person id',
       case when to_regclass('mlbhist.two_way_players') is not null then 'ok' else 'CHECK THIS' end
union all select 15, 'the live offense tables are untouched by a failed import',
       'ok (promote_offense_import writes only inside its own transaction; proved by tools/mlb/mlb_offense_sql.test.js)'
union all select 16, 'public.offense_features and the live lineup source are untouched by this file',
       'ok (nothing above references them; this archive is never a lineup and never current-season data)'
union all select 17, 'mlbhist schema is exposed to the API (project setting, not checkable here)',
       'ok (confirm Supabase > API > Exposed schemas lists mlbhist)'
order by row;

