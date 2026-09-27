-- college_baseball -- part 7 of 7.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

/* ═══════════════════════════════════════════════════════════════════════════
   THE REPORT

   Every SQL file here ends by saying what it just guaranteed, so applying it
   is not an act of faith. A row reading anything but ok is a thing to chase.
   ═══════════════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════════════
   THE IMPORTER'S OWN GRANTS.

   This file named service_role exactly zero times while mlb_pitcher_history.sql
   named it ten, so the college importer could not write this schema under any
   configuration. Once the schema was exposed to PostgREST the first insert came
   straight back as

     INSERT cbb.import_runs -> 403 {"code":"42501",
       "message":"permission denied for schema cbb"}

   after a clean walk of all 437 teams. The 23 guarantees above did not catch it
   because every one of them checks that a READER cannot write, and none checked
   that the WRITER can. Row 25 is that missing check.
   ═══════════════════════════════════════════════════════════════════════════ */
grant usage on schema cbb to service_role;
grant usage, select on all sequences in schema cbb to service_role;

do $$
declare t text;
begin
  foreach t in array array[
    'import_runs','teams','games','team_seasons',
    'player_games','player_seasons','team_stat_seasons',
    'ncaa_player_seasons','club_map',
    'stg_teams','stg_games','stg_player_games',
    'stg_ncaa_player_seasons','stg_club_map'
  ] loop
    if to_regclass('cbb.' || t) is not null then
      execute format('grant all on cbb.%I to service_role', t);
    end if;
  end loop;
end $$;

do $$
declare f record;
begin
  /* The gates, to the writer only. Iterating pg_proc rather than listing
     signatures keeps this right when an argument list changes. */
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'cbb'
      and p.proname in ('promote_cbb_import','abandon_cbb_import','rebuild_team_seasons',
                        'promote_cbb_stats','rebuild_player_seasons',
                        'promote_ncaa_seasons','promote_club_map')
  loop
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

/* ═══════════════════════════════════════════════════════════════════════════
   THE VIEWS, GRANTED AND MADE TO HONOUR RLS.

   Every grant above is a loop over TABLE names, so all four views were left
   ungranted and the college card answered db 403 while the MLB panels, whose
   contract grants mlbhist.dataset_status by name, came up fine. Granted here
   as one list rather than inside the loops, so adding a view cannot silently
   skip its grant again.

   security_invoker makes a view read as whoever called it. Without it a view
   runs as its owner and reads straight past the policies on the tables under
   it — which changes nothing while every one of those tables has a read-all
   policy, and becomes an invisible hole the first time one is narrowed.
   ═══════════════════════════════════════════════════════════════════════════ */
do $$
declare v text;
begin
  foreach v in array array['season_status','stats_coverage',
                           'ncaa_archive_status','archive_by_espn_club'] loop
    if to_regclass('cbb.' || v) is not null then
      execute format('alter view cbb.%I set (security_invoker = true)', v);
      execute format('grant select on cbb.%I to anon, authenticated, service_role', v);
    end if;
  end loop;
end $$;

with checks as (
  select 1 as n, 'cbb.games is the union spine and is keyed on the source game id' as guarantee,
    case when exists (select 1 from information_schema.table_constraints
                       where table_schema='cbb' and table_name='games' and constraint_type='PRIMARY KEY')
         then 'ok' else 'CHECK THIS — no primary key on cbb.games' end as result
  union all select 2, 'a game can render even when a side is not a known team',
    case when (select is_nullable from information_schema.columns
                where table_schema='cbb' and table_name='games' and column_name='away_team_id') = 'YES'
          and (select is_nullable from information_schema.columns
                where table_schema='cbb' and table_name='games' and column_name='away_name') = 'NO'
         then 'ok (ids may be absent, names never are — a non-D1 visitor still appears)'
         else 'CHECK THIS — a game with an unknown opponent would be dropped' end
  union all select 3, 'team_seasons is derived from the game log, not fetched',
    case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                       where n.nspname='cbb' and p.proname='rebuild_team_seasons')
         then 'ok (rebuild_team_seasons folds cbb.games; there is no second source to disagree with)'
         else 'CHECK THIS — no derivation function' end
  union all select 4, 'the promote refuses an import that shrank',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='promote_cbb_import') like '%IMPORT_SHRANK%'
         then 'ok (the source answers 200 with an empty slate when hurried; that is never written)'
         else 'CHECK THIS — a partial answer could delete a day of games' end
  union all select 5, 'an empty import is refused outright',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='promote_cbb_import') like '%EMPTY_IMPORT%'
         then 'ok' else 'CHECK THIS' end
  union all select 6, 'a finished game cannot carry no score unless it was abandoned',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='promote_cbb_import') like '%COMPLETED_WITHOUT_SCORE%'
         then 'ok (postponed, cancelled, suspended and forfeited are excluded by name)'
         else 'CHECK THIS' end
  union all select 7, 'the union is actually a union',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='promote_cbb_import') like '%DUPLICATE_GAME_IDS%'
         then 'ok (a duplicated game id means the walk stopped being a union)'
         else 'CHECK THIS' end
  union all select 8, 'anon and authenticated may read the record',
    case when (select count(*) from pg_policies
                where schemaname='cbb' and tablename in ('games','teams','team_seasons','import_runs')) >= 4
         then 'ok' else 'CHECK THIS — a reader cannot see the board' end
  union all select 9, 'staging is readable by nobody',
    case when (select count(*) from pg_policies
                where schemaname='cbb' and tablename in ('stg_games','stg_teams')) = 0
         then 'ok (RLS with no policy denies by default)' else 'CHECK THIS — staging is exposed' end
  union all select 10, 'the gates are not callable by a reader',
    case when has_function_privilege('anon','cbb.promote_cbb_import(text, boolean, date, date)','EXECUTE') = false
         then 'ok' else 'CHECK THIS — anon can promote an import' end
  union all select 11, 'the season is the calendar year of the date',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='promote_cbb_import') like '%SEASON_DATE_MISMATCH%'
         then 'ok (February to June, so the year is the season)' else 'CHECK THIS' end
  union all select 12, 'cbb is exposed to the API (a project setting, not checkable here)',
    'ok (confirm Supabase > API > Exposed schemas lists cbb)'

  /* ── the stats half ── */
  union all select 13, 'innings pitched is stored as outs, not as a decimal',
    case when exists (select 1 from information_schema.columns
                       where table_schema='cbb' and table_name='player_games' and column_name='outs')
          and not exists (select 1 from information_schema.columns
                       where table_schema='cbb' and table_name='player_games'
                         and column_name in ('innings','ip'))
         then 'ok ("6.2" is 20 outs, not 6.2 innings; adding decimals gives 12.4, '
              || 'which is not a possible innings figure)'
         else 'CHECK THIS — a decimal innings column will be summed wrongly sooner or later' end
  union all select 14, 'the season-to-date rates on a box score are never folded',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='rebuild_player_seasons')
              like '%order by season, athlete_id, game_date desc%'
         then 'ok (AVG/OBP/SLG/ERA on a line are the player''s SEASON figures as of '
              || 'that game; the fold carries the last one and never averages them)'
         else 'CHECK THIS — averaging a season-to-date column produces a meaningless number' end
  union all select 15, 'a rate over zero denominator is null, never zero',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='rebuild_player_seasons')
              like '%case when coalesce(b.ab,0) > 0%'
         then 'ok (a hitter with no at-bats has no average; he does not have .000)'
         else 'CHECK THIS' end
  union all select 16, 'OBP and SLG are the source''s own, not computed from what is missing',
    case when exists (select 1 from information_schema.columns
                       where table_schema='cbb' and table_name='player_seasons'
                         and column_name='obp_reported')
          and not exists (select 1 from information_schema.columns
                       where table_schema='cbb' and table_name='player_seasons'
                         and column_name in ('obp','slg'))
         then 'ok (the box score has no HBP, SF, 2B or 3B, so neither can be computed; '
              || 'calling (H+BB)/(AB+BB) "OBP" would be a lie)'
         else 'CHECK THIS — an obp column here would have to be a fabrication' end
  union all select 17, 'a stats import that shrank is refused',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='promote_cbb_stats') like '%IMPORT_SHRANK%'
         then 'ok (judged against the season the import MEANT to cover, not the span it returned)'
         else 'CHECK THIS' end
  union all select 18, 'a misread column mapping is caught before it is promoted',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='promote_cbb_stats') like '%HITS_EXCEED_AB%'
         then 'ok (a box score is a bare list of numbers plus a list of labels, so an '
              || 'off-by-one yields individually plausible, collectively impossible lines)'
         else 'CHECK THIS' end
  union all select 19, 'a line cannot belong to a game the log has never heard of',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='promote_cbb_stats') like '%ORPHAN_GAME%'
         then 'ok' else 'CHECK THIS' end
  union all select 20, 'the stats archive says how much of the season it covers',
    case when exists (select 1 from information_schema.views
                       where table_schema='cbb' and table_name='stats_coverage')
          and exists (select 1 from information_schema.columns
                       where table_schema='cbb' and table_name='team_stat_seasons'
                         and column_name='line_coverage')
         then 'ok (not every college box score carries players; the gap is shown, not inherited)'
         else 'CHECK THIS — a partial archive that looks whole is worse than no archive' end
  union all select 21, 'the club hitting line is kept apart from the club record',
    case when exists (select 1 from information_schema.tables
                       where table_schema='cbb' and table_name='team_stat_seasons')
          and exists (select 1 from information_schema.tables
                       where table_schema='cbb' and table_name='team_seasons')
         then 'ok (team_seasons folds every game played; team_stat_seasons folds only the '
              || 'games with box-score lines, and those two sets differ)'
         else 'CHECK THIS' end
  union all select 22, 'the stats staging table is readable by nobody',
    case when exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                       where n.nspname='cbb' and c.relname='stg_player_games' and c.relrowsecurity)
          and not exists (select 1 from pg_policies
                       where schemaname='cbb' and tablename='stg_player_games')
         then 'ok (RLS with no policy denies by default)'
         else 'CHECK THIS' end
  union all select 24, 'a reader may read the four views the panels actually ask for',
    case when (select bool_and(has_table_privilege('anon','cbb.'||v,'SELECT'))
               from unnest(array['season_status','stats_coverage',
                                 'ncaa_archive_status','archive_by_espn_club']) v
               where to_regclass('cbb.'||v) is not null)
         then 'ok (an ungranted view is a db 403 on the card, not an empty one)'
         else 'CHECK THIS — the college card will answer 403' end
  union all select 25, 'the importer may write this schema',
    case when has_schema_privilege('service_role','cbb','usage')
          and has_table_privilege('service_role','cbb.import_runs','INSERT')
         then 'ok (checking only that a READER cannot write leaves nobody holding a key)'
         else 'CHECK THIS — no import can reach this schema' end
  union all select 23, 'the stats gates are not callable by a reader',
    case when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname in ('promote_cbb_stats','rebuild_player_seasons')
                  and (has_function_privilege('anon', p.oid, 'execute')
                       or has_function_privilege('authenticated', p.oid, 'execute'))) = 0
         then 'ok' else 'CHECK THIS — a reader could rewrite the season archive' end
)
select n, guarantee, result from checks order by n;

