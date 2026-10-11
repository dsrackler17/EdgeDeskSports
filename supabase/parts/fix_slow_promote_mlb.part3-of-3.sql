-- fix_slow_promote_mlb -- part 3 of 3.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

/* ---------------------------------------------------------------------------
   THE STAGING THE TIMED-OUT RUNS LEFT BEHIND.

   Every run cancelled since 2026-10-06 left its staged rows under an import id
   that can never be promoted: the job that opened it is long gone and the next
   run opens its own. They are evidence of nothing the ledger does not already
   hold, and while they sat there they were what staging's statistics
   described.

   Cleared for OFFENSIVE imports only, only for imports that never promoted,
   and only for ones opened more than six hours ago — the job's own limit is 75
   minutes, so nothing in flight is touched. A run the gate left in 'staging' or
   'validated' is marked failed with the reason; a run the gate already refused
   keeps the refusal it recorded, and only its rows go. The pitching staging
   tables, the live record and the promoted import are not touched.
   --------------------------------------------------------------------------- */
do $$
declare
  r record;
  t text;
begin
  for r in select import_id, status from mlbhist.import_runs
            where dataset = 'offense' and status in ('staging', 'validated', 'failed')
              and started_at < now() - interval '6 hours'
  loop
    foreach t in array array['stg_batter_seasons','stg_batter_team_seasons','stg_batter_overview',
                             'stg_batter_team_history','stg_observed_batter_team_runs',
                             'stg_team_offense_seasons','stg_team_offense_overview',
                             'stg_league_offense_seasons','stg_offense_validation',
                             'stg_offense_source_repairs','stg_offense_games_reconciliation'] loop
      execute format('delete from mlbhist.%I where import_id = $1', t) using r.import_id;
    end loop;
    if r.status in ('staging', 'validated') then
      update mlbhist.import_runs
        set status = 'failed', finished_at = coalesce(finished_at, now()),
            message = coalesce(message, 'never promoted and never abandoned: the run that opened it ended '
              || 'without either (from 2026-10-06, the gate''s statement timeout, 57014). Its staged rows '
              || 'were cleared by supabase/fix_slow_promote_mlb.sql')
        where import_id = r.import_id;
    end if;
  end loop;
end $$;

/* ---------------------------------------------------------------------------
   THE REPORT. Every row must read ok.
   --------------------------------------------------------------------------- */
with gate as (
  select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'mlbhist' and p.proname = 'promote_offense_import'
),
checks as (
  select 1 as n, 'the offensive gate exists after being replaced' as guarantee,
    case when to_regprocedure('mlbhist.promote_offense_import(text)') is not null
         then 'ok' else 'CHECK THIS' end as result
  union all select 2, 'its grain check no longer joins staging to an aggregate of staging',
    case when (select prosrc from gate) !~* 'join[[:space:]]*\([[:space:]]*select[[:space:]]+player_id,[[:space:]]*season,[[:space:]]*sum\(plate_appearances\)'
         then 'ok' else 'CHECK THIS — the plan-sensitive join is still in place' end
  union all select 3, 'it checks the two grains in one grouped pass',
    case when (select prosrc from gate) ~* 'bool_or\(g\.combined\)[[:space:]]+and[[:space:]]+bool_or\(not g\.combined\)'
         then 'ok' else 'CHECK THIS' end
  union all select 4, 'it still refuses a grain violation by name',
    case when (select prosrc from gate) ~ '''GRAIN_VIOLATION'''
         then 'ok' else 'CHECK THIS — the grain gate is gone' end
  union all select 5, 'no gate body carries a DELETE without a WHERE (safeupdate)',
    case when not exists (
           select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'mlbhist'
             and p.prosrc ~* 'delete[[:space:]]+from[[:space:]]+[a-z_.]+[[:space:]]*;')
         then 'ok' else 'CHECK THIS — safeupdate will refuse this gate' end
  union all select 6, 'it is still security definer, callable by the importer and by no reader',
    case when (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'mlbhist' and p.proname = 'promote_offense_import')
          and has_function_privilege('service_role', 'mlbhist.promote_offense_import(text)', 'execute')
          and not has_function_privilege('anon', 'mlbhist.promote_offense_import(text)', 'execute')
          and not has_function_privilege('authenticated', 'mlbhist.promote_offense_import(text)', 'execute')
         then 'ok' else 'CHECK THIS' end
  union all select 7, 'no offensive import that died before promotion still holds staged rows',
    case when not exists (
           select 1 from mlbhist.import_runs ir
            where ir.dataset = 'offense' and ir.status <> 'promoted'
              and ir.started_at < now() - interval '6 hours'
              and (exists (select 1 from mlbhist.stg_batter_seasons s where s.import_id = ir.import_id)
                or exists (select 1 from mlbhist.stg_batter_team_seasons s where s.import_id = ir.import_id)))
         then 'ok' else 'CHECK THIS — dead staging is still there' end
  union all select 8, 'no offensive run is left looking in flight after six hours',
    case when not exists (
           select 1 from mlbhist.import_runs
            where dataset = 'offense' and status in ('staging', 'validated')
              and started_at < now() - interval '6 hours')
         then 'ok' else 'CHECK THIS' end
)
select n, guarantee, result from checks order by n;

