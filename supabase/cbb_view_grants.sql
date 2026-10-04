/* ===========================================================================
   LET A READER READ THE FOUR cbb VIEWS.

   WHY. The college card asks for cbb.season_status and gets

     db 403        (college archive: forbidden)

   because college_baseball.sql grants select on its TABLES and never on its
   VIEWS. The grants are written as loops over table-name arrays:

     execute format('grant select on cbb.%I to anon, authenticated', t);

   and no loop, and no line anywhere in that file, names season_status,
   stats_coverage, ncaa_archive_status or archive_by_espn_club. All four were
   left ungranted. The MLB contract does not have this hole — it grants its
   equivalent explicitly, "grant select on mlbhist.dataset_status to anon,
   authenticated, service_role" — which is why the MLB panels came up as soon
   as the schema was exposed and the college card did not.

   Measured on a database built from the contract, before this file:

     cbb.season_status        anon = false
     cbb.stats_coverage       anon = false
     cbb.ncaa_archive_status  anon = false
     cbb.archive_by_espn_club anon = false
     mlbhist.dataset_status   anon = true

   THIS WIDENS NOTHING. Each view reads only live tables a reader may already
   select from, and none of them touches a staging table:

     season_status        <- games, teams, team_seasons, import_runs
     stats_coverage       <- games, player_games, player_seasons
     ncaa_archive_status  <- ncaa_player_seasons
     archive_by_espn_club <- club_map, ncaa_player_seasons

   AND THE VIEWS NOW HONOUR RLS RATHER THAN BYPASSING IT. A Postgres view runs
   as its owner unless security_invoker is set, so all four were reading the
   record with the owner's rights and skipping the policies underneath. It made
   no difference today, because every one of those tables has a read-all policy
   for anon. It would make a difference the first time anyone narrowed one, and
   the hole would be invisible: the policy would look right and the view would
   quietly ignore it. Setting security_invoker makes the view read as whoever
   called it, which is what the RLS in that file was written to mean.

   Safe to run more than once.
   =========================================================================== */

do $$
declare v text;
begin
  foreach v in array array['season_status','stats_coverage',
                           'ncaa_archive_status','archive_by_espn_club'] loop
    if to_regclass('cbb.' || v) is not null then
      execute format('alter view cbb.%I set (security_invoker = true)', v);
      execute format('grant select on cbb.%I to anon, authenticated', v);
    end if;
  end loop;
end $$;

-- The importer reads these back to report coverage after a promote.
do $$
declare v text;
begin
  foreach v in array array['season_status','stats_coverage',
                           'ncaa_archive_status','archive_by_espn_club'] loop
    if to_regclass('cbb.' || v) is not null then
      execute format('grant select on cbb.%I to service_role', v);
    end if;
  end loop;
end $$;

/* ---------------------------------------------------------------------------
   THE REPORT. Every row must read ok.
   --------------------------------------------------------------------------- */
with checks as (
  select 1 as n, 'a reader may select from all four cbb views' as guarantee,
    case when (select bool_and(has_table_privilege('anon','cbb.'||v,'SELECT'))
               from unnest(array['season_status','stats_coverage',
                                 'ncaa_archive_status','archive_by_espn_club']) v
               where to_regclass('cbb.'||v) is not null)
         then 'ok' else 'CHECK THIS — this is the db 403 on the college card' end as result

  union all select 2, 'the views read as their caller, so RLS is not bypassed',
    case when (select bool_and(c.reloptions::text like '%security_invoker=true%')
               from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'cbb' and c.relkind = 'v')
         then 'ok' else 'CHECK THIS — a view would read past the policies under it' end

  union all select 3, 'no granted view reaches a staging table',
    case when not exists (
           select 1
           from pg_depend d
           join pg_rewrite r on r.oid = d.objid
           join pg_class vw on vw.oid = r.ev_class
           join pg_class src on src.oid = d.refobjid
           join pg_namespace sn on sn.oid = src.relnamespace
           join pg_namespace vn on vn.oid = vw.relnamespace
           where vn.nspname = 'cbb' and vw.relkind = 'v'
             and sn.nspname = 'cbb' and src.relname like 'stg\_%')
         then 'ok' else 'CHECK THIS — staging would be readable through a view' end

  union all select 4, 'granting the views did not grant the staging tables themselves',
    case when not exists (
           select 1 from unnest(array['stg_games','stg_teams','stg_player_games',
                                      'stg_ncaa_player_seasons','stg_club_map']) t
           where to_regclass('cbb.'||t) is not null
             and (has_table_privilege('anon','cbb.'||t,'SELECT')
               or has_table_privilege('authenticated','cbb.'||t,'SELECT')))
         then 'ok' else 'CHECK THIS' end

  union all select 5, 'a reader still cannot write the record through anything',
    case when not exists (
           select 1 from unnest(array['games','teams','team_seasons','import_runs']) t
           where has_table_privilege('anon','cbb.'||t,'INSERT')
              or has_table_privilege('anon','cbb.'||t,'UPDATE')
              or has_table_privilege('anon','cbb.'||t,'DELETE'))
         then 'ok' else 'CHECK THIS' end
)
select n, guarantee, result from checks order by n;
