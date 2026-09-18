/* ===========================================================================
   GIVE THE IMPORTER PERMISSION TO WRITE cbb.

   WHY THIS FILE EXISTS, AND IT IS A DEFECT IN college_baseball.sql. That file
   grants the READERS everything they need and the WRITER nothing at all:

     grant usage on schema cbb to anon, authenticated;     -- no service_role

   It names service_role exactly zero times. supabase/mlb_pitcher_history.sql
   names it ten. So the college importer could never have written to this
   schema under any configuration, and once the schema was finally exposed to
   PostgREST the very next thing it hit was

     INSERT cbb.import_runs -> 403: {"code":"42501",
       "message":"permission denied for schema cbb"}

   after a clean walk of all 437 teams and a 5,500-game union. The data was
   never the problem.

   WORSE, THE REPORT DID NOT CATCH IT. college_baseball.sql ends in 23
   guarantees and every one of them checks that a READER cannot write: staging
   denied, gates not callable by anon, RLS on. Not one checks that the WRITER
   can write. A report that only tests the locks never notices that nobody was
   given a key, which is how 23 rows of ok sat above a schema no import could
   reach. The rows below are the missing half, and they are asserted against
   service_role's real privileges rather than against the text of a grant.

   SAFE TO RUN MORE THAN ONCE, and safe to run before or after any import.
   =========================================================================== */

-- The schema itself. Without this, every statement below is unreachable anyway.
grant usage on schema cbb to service_role;

do $$
declare t text;
begin
  /* Every table the importer stages into or promotes into. Staging included:
     it is denied to readers by RLS with no policy, which is a separate thing
     from the writer's grant and must stay that way. */
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

-- Sequences behind any identity or serial column.
grant usage, select on all sequences in schema cbb to service_role;

do $$
declare f record;
begin
  /* The gates. Granted to service_role ONLY — a reader holding a publishable
     key must not be able to promote, abandon or rebuild anything. Iterating
     pg_proc rather than listing signatures keeps this correct when an argument
     list changes. */
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

/* ---------------------------------------------------------------------------
   THE REPORT. Every row must read ok.

   These are the checks college_baseball.sql should have carried. Rows 1-4 are
   the writer's side; rows 5-6 re-assert the reader's side so that fixing the
   writer cannot quietly have opened the schema to the browser.
   --------------------------------------------------------------------------- */
with checks as (
  select 1 as n, 'the importer may reach into the cbb schema' as guarantee,
    case when has_schema_privilege('service_role','cbb','usage')
         then 'ok' else 'CHECK THIS — this is the 403 the import failed on' end as result

  union all select 2, 'the importer may open and finish an import run',
    case when has_table_privilege('service_role','cbb.import_runs','INSERT')
          and has_table_privilege('service_role','cbb.import_runs','UPDATE')
         then 'ok' else 'CHECK THIS' end

  union all select 3, 'the importer may write every staging table it stages into',
    case when (select bool_and(has_table_privilege('service_role','cbb.'||t,'INSERT'))
               from unnest(array['stg_teams','stg_games','stg_player_games',
                                 'stg_ncaa_player_seasons','stg_club_map']) t
               where to_regclass('cbb.'||t) is not null)
         then 'ok' else 'CHECK THIS' end

  union all select 4, 'the importer may call every gate that promotes a staged import',
    case when (select bool_and(has_function_privilege('service_role', p.oid, 'execute'))
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'cbb'
                 and p.proname in ('promote_cbb_import','promote_cbb_stats',
                                   'promote_ncaa_seasons','promote_club_map'))
         then 'ok' else 'CHECK THIS' end

  union all select 5, 'granting the writer did not let a reader write the record',
    case when not exists (
           select 1 from unnest(array['games','teams','team_seasons','import_runs']) t
           where has_table_privilege('anon','cbb.'||t,'INSERT')
              or has_table_privilege('anon','cbb.'||t,'UPDATE')
              or has_table_privilege('anon','cbb.'||t,'DELETE'))
         then 'ok' else 'CHECK THIS — a reader could rewrite the game log' end

  union all select 6, 'granting the writer did not open staging or the gates to a reader',
    case when not exists (
           select 1 from unnest(array['stg_games','stg_teams','stg_player_games']) t
           where to_regclass('cbb.'||t) is not null
             and (has_table_privilege('anon','cbb.'||t,'SELECT')
               or has_table_privilege('authenticated','cbb.'||t,'SELECT')))
          and (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb'
                  and p.proname in ('promote_cbb_import','promote_cbb_stats',
                                    'promote_ncaa_seasons','promote_club_map',
                                    'rebuild_team_seasons','rebuild_player_seasons')
                  and (has_function_privilege('anon', p.oid, 'execute')
                    or has_function_privilege('authenticated', p.oid, 'execute'))) = 0
         then 'ok' else 'CHECK THIS — a reader could rewrite the season archive' end
)
select n, guarantee, result from checks order by n;
