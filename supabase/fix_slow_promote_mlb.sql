/* ===========================================================================
   THE OFFENSIVE PROMOTE NEEDED 47 SECONDS AND POSTGREST STOPPED IT AT 36.

   Every scheduled run of the MLB refresh from 2026-10-06 rebuilt the
   offensive dataset, validated it, staged all of it — 10,849 batter-seasons,
   11,868 player-team rows — and then died in the gate, 36 seconds in:

     RPC mlbhist.promote_offense_import -> 500: {"code":"57014",
       "message":"canceling statement due to statement timeout"}

   The pitching gate beside it promotes the same night in 3.5 seconds.

   NOT A SIZING PROBLEM, AND NOT A TIMEOUT TO RAISE. The two gates do the same
   linear work; the offensive one has one statement the pitching one does not,
   the GRAIN check, and that statement was the whole 47 seconds. Raising the
   timeout would not have fixed it — a function's own SET statement_timeout
   does not extend the request PostgREST is already timing — and the work grows
   with the square of the archive, so the wall would only have moved.

   THE CAUSE. The grain check joined the staged seasons to an aggregate of the
   staged splits. How long that takes depends on what the planner believes
   staging holds, and staging is the table whose statistics are least likely
   to be right: it is bulk-filled and bulk-emptied, so they describe an
   earlier import, or an empty table, and rarely the one being promoted. Told
   to expect one row a side, the planner chose a nested loop and re-ran the
   aggregate once per player-season. Against a local PostgreSQL 16 holding
   the committed 2016–2025 dataset, with staging's statistics as a run leaves
   them:

     Nested Loop  (rows=1)  (actual rows=0 loops=1)
       Rows Removed by Join Filter: 101,969,604      -- 10,098 squared
       ->  Index Scan on stg_batter_seasons  (rows=1)  (actual rows=10,098)
       ->  GroupAggregate  (rows=1)  (actual rows=10,098 loops=10,098)

   And the whole gate, timed at production's volume (10,863 batter-seasons and
   11,883 splits: the package plus a 2026 cloned from 2025), by what staging's
   statistics described when it was called:

     staging's statistics described               before      after
     only an earlier import that never promoted   46,863 ms   1,811 ms
     the empty table the last promote left        46,981 ms     955 ms
     this import (autovacuum got there first)      1,124 ms   1,239 ms
     nothing (never gathered)                        781 ms   1,657 ms

   Production gave up at 36 s: that is where its statement timeout fell, not
   where the work ended. And that plan's work grows with the SQUARE of the
   archive — every in-season night adds player-seasons to both sides of the
   loop.

   No index fixes this. Staging is already indexed on import_id, and both
   scans in the plan above use it; the cost is the loop around them.

   A FAILED RUN THEN KEPT IT FAILING. A gate cancelled by a timeout rolls back,
   so its staged rows stay — and tools/mlb/refresh_offense.js never abandoned
   a failed import (it does now). Each night left about 40,000 more rows under
   an import id that can never be promoted, staging's statistics came to
   describe those dead imports, and whenever the next night's promote reached
   the planner before autovacuum reached staging, the estimate was one row
   again — the first row of the table above.

   THE FIX. The same question asked without a join: stack the two grains and
   group once. A key counts only when it has a combined row AND at least one
   split — exactly what the inner join kept — and the duplicate check before it
   has already proved the combined row unique, so the count is the same count.
   There is no plan to get wrong: whatever staging's statistics say, it is one
   sort of about 21,000 rows. The grain check alone, on the same misestimated
   staging: 58,832 ms under EXPLAIN ANALYZE before, 28 ms after.

   AND IT IS THE SAME ANSWER, not a faster different one. Both forms were run
   against the same staged import in seven cases — untouched; combined
   rows off by one; one split of a traded player off by three; null PA against
   zero and null splits; non-zero splits nulled; mismatches with orphans on
   both sides; another import's rows mutated — and agreed every time, on counts
   of 0, 25, 40, 0, 1,253, 313 and 0 rather than a column of zeros that would
   agree trivially.

   STILL ONE TRANSACTION. Nothing about the gate's shape changed: one call,
   every refusal before any live row moves, and a gate that fails for any
   reason leaves the previously promoted dataset exactly where it was. The
   gate was not split into several calls to fit the timeout, because once the
   quadratic statement is gone it does not need to be.

   PROVED, NOT REASONED. tools/mlb/offense_import.test.js puts a database in
   exactly this state — a cancelled import's rows left in staging and
   analyzed, the next import staged on top — checks that the planner really
   does expect one row, and calls the gate through the shipped importer under
   a 10 s statement timeout. Against the previous gate it fails with this same
   57014; against this one it promotes.

   Also here: the staged rows the timed-out runs left behind are cleared (see
   below), because they are what kept the estimate wrong night after night.

   HOW TO APPLY. psql against the Session pooler connection string:

       psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/fix_slow_promote_mlb.sql

   or paste supabase/parts/fix_slow_promote_mlb.part1-of-*.sql and the parts
   after it, in order, into the SQL editor. Every row of the report the last
   part prints must read ok. Then re-run the "MLB historical archives" workflow
   by hand (Run workflow, commit checked).

   Safe to run more than once. It replaces one function, re-states its grants
   and clears only staging that belongs to an offensive import that never
   promoted and was opened more than six hours ago. No live table is written.
   =========================================================================== */

-- This amends the offensive contract; it cannot stand in for it.
do $$
begin
  if to_regclass('mlbhist.stg_batter_seasons') is null
     or to_regprocedure('mlbhist.abandon_offense_import(text,text)') is null then
    raise exception 'the offensive archive is not installed — run supabase/mlb_offense_history.sql first';
  end if;
end $$;

-- ===========================================================================
-- THE PROMOTE GATE.
--
-- One transaction. It checks the staged rows against what the package said it
-- was shipping and against the keys the record depends on, and only then
-- replaces the live tables. Anything it refuses leaves the last successful
-- dataset exactly where it was, which is the difference between a failed
-- refresh and a lost archive.
--
-- The five refusals, each returned by name rather than as a generic error:
--   EMPTY_STAGING        nothing was staged for this import
--   COUNT_MISMATCH       staged rows disagree with the package's own counts
--   DUPLICATE_KEY        the same (player, season[, team]) arrived twice
--   VALIDATION_FAILED    the package's own per-season reconciliation did not
--                        pass, at the player grain or the team grain
--   GRAIN_VIOLATION      a player-season's combined totals disagree with the
--                        sum of its own team splits on plate appearances. The
--                        two grains describe the same performance; if they
--                        disagree, one of them is wrong and neither may ship.
-- ===========================================================================
create or replace function mlbhist.promote_offense_import(p_import_id text)
returns jsonb
language plpgsql
security definer
set search_path = mlbhist, public
as $$
declare
  run             mlbhist.import_runs%rowtype;
  n_seasons       bigint; n_team_seasons bigint; n_overview bigint; n_team_history bigint;
  n_runs          bigint; n_team_off bigint; n_team_off_ov bigint; n_league bigint;
  n_validation    bigint; n_repairs bigint; n_games bigint;
  dup_seasons     bigint; dup_team_seasons bigint; dup_overview bigint;
  bad_players     bigint; bad_teams bigint;
  grain_breaks    bigint;
  expected        jsonb;
  staged          jsonb;
  problems        text[] := '{}';
  cov_lo          int; cov_hi int;
begin
  select * into run from mlbhist.import_runs where import_id = p_import_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'UNKNOWN_IMPORT',
      'detail', format('no import_runs row for %s', p_import_id));
  end if;

  select count(*) into n_seasons      from mlbhist.stg_batter_seasons            where import_id = p_import_id;
  select count(*) into n_team_seasons from mlbhist.stg_batter_team_seasons       where import_id = p_import_id;
  select count(*) into n_overview     from mlbhist.stg_batter_overview           where import_id = p_import_id;
  select count(*) into n_team_history from mlbhist.stg_batter_team_history       where import_id = p_import_id;
  select count(*) into n_runs         from mlbhist.stg_observed_batter_team_runs where import_id = p_import_id;
  select count(*) into n_team_off     from mlbhist.stg_team_offense_seasons      where import_id = p_import_id;
  select count(*) into n_team_off_ov  from mlbhist.stg_team_offense_overview     where import_id = p_import_id;
  select count(*) into n_league       from mlbhist.stg_league_offense_seasons    where import_id = p_import_id;
  select count(*) into n_validation   from mlbhist.stg_offense_validation        where import_id = p_import_id;
  select count(*) into n_repairs      from mlbhist.stg_offense_source_repairs    where import_id = p_import_id;
  select count(*) into n_games        from mlbhist.stg_offense_games_reconciliation where import_id = p_import_id;

  staged := jsonb_build_object(
    'batter_seasons', n_seasons, 'batter_team_seasons', n_team_seasons,
    'batter_overview', n_overview, 'batter_team_history', n_team_history,
    'observed_team_runs', n_runs, 'team_offense_seasons', n_team_off,
    'team_offense_overview', n_team_off_ov, 'league_seasons', n_league,
    'validation', n_validation, 'source_repairs', n_repairs,
    'games_reconciliation', n_games);

  if n_seasons = 0 or n_team_seasons = 0 or n_overview = 0 or n_team_off = 0 then
    update mlbhist.import_runs set status = 'failed', staged_counts = staged,
      message = 'nothing was staged for this import', finished_at = now()
      where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'code', 'EMPTY_STAGING', 'staged', staged);
  end if;

  -- The package's own counts, from build_report.json. A dataset that claims
  -- 10,098 batter-seasons and stages 10,000 has lost rows somewhere between
  -- the file and here, and the live table is a better answer than a truncated
  -- refresh.
  expected := coalesce(run.expected_counts, '{}'::jsonb);
  if expected ? 'batter_seasons'        and (expected->>'batter_seasons')::bigint        <> n_seasons      then problems := problems || format('batter_seasons expected %s staged %s',        expected->>'batter_seasons',        n_seasons); end if;
  if expected ? 'batter_team_seasons'   and (expected->>'batter_team_seasons')::bigint   <> n_team_seasons then problems := problems || format('batter_team_seasons expected %s staged %s',   expected->>'batter_team_seasons',   n_team_seasons); end if;
  if expected ? 'batter_overview'       and (expected->>'batter_overview')::bigint       <> n_overview     then problems := problems || format('batter_overview expected %s staged %s',       expected->>'batter_overview',       n_overview); end if;
  if expected ? 'batter_team_history'   and (expected->>'batter_team_history')::bigint   <> n_team_history then problems := problems || format('batter_team_history expected %s staged %s',   expected->>'batter_team_history',   n_team_history); end if;
  if expected ? 'observed_team_runs'    and (expected->>'observed_team_runs')::bigint    <> n_runs         then problems := problems || format('observed_team_runs expected %s staged %s',    expected->>'observed_team_runs',    n_runs); end if;
  if expected ? 'team_offense_seasons'  and (expected->>'team_offense_seasons')::bigint  <> n_team_off     then problems := problems || format('team_offense_seasons expected %s staged %s',  expected->>'team_offense_seasons',  n_team_off); end if;
  if expected ? 'team_offense_overview' and (expected->>'team_offense_overview')::bigint <> n_team_off_ov  then problems := problems || format('team_offense_overview expected %s staged %s', expected->>'team_offense_overview', n_team_off_ov); end if;
  if expected ? 'league_seasons'        and (expected->>'league_seasons')::bigint        <> n_league       then problems := problems || format('league_seasons expected %s staged %s',        expected->>'league_seasons',        n_league); end if;

  if array_length(problems, 1) is not null then
    update mlbhist.import_runs set status = 'failed', staged_counts = staged,
      message = 'staged rows disagree with the package: ' || array_to_string(problems, '; '), finished_at = now()
      where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'code', 'COUNT_MISMATCH', 'staged', staged,
      'expected', expected, 'problems', to_jsonb(problems));
  end if;

  select count(*) into dup_seasons from (
    select player_id, season from mlbhist.stg_batter_seasons where import_id = p_import_id
    group by 1, 2 having count(*) > 1) d;
  select count(*) into dup_team_seasons from (
    select player_id, season, team_id from mlbhist.stg_batter_team_seasons where import_id = p_import_id
    group by 1, 2, 3 having count(*) > 1) d;
  select count(*) into dup_overview from (
    select player_id from mlbhist.stg_batter_overview where import_id = p_import_id
    group by 1 having count(*) > 1) d;
  if dup_seasons > 0 or dup_team_seasons > 0 or dup_overview > 0 then
    update mlbhist.import_runs set status = 'failed', staged_counts = staged,
      message = format('duplicate keys staged: %s player-seasons, %s player-team-seasons, %s players',
                       dup_seasons, dup_team_seasons, dup_overview),
      finished_at = now() where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'code', 'DUPLICATE_KEY', 'staged', staged,
      'duplicate_player_seasons', dup_seasons,
      'duplicate_player_team_seasons', dup_team_seasons,
      'duplicate_players', dup_overview);
  end if;

  select count(*) into bad_players from mlbhist.stg_offense_validation
    where import_id = p_import_id and player_totals_reconcile is distinct from true;
  select count(*) into bad_teams from mlbhist.stg_offense_validation
    where import_id = p_import_id and team_totals_reconcile is distinct from true;
  if bad_players > 0 or bad_teams > 0 then
    update mlbhist.import_runs set status = 'failed', staged_counts = staged,
      message = format('%s season(s) failed the player reconciliation and %s the team reconciliation',
                       bad_players, bad_teams), finished_at = now()
      where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'staged', staged,
      'unreconciled_player_seasons', bad_players, 'unreconciled_team_seasons', bad_teams);
  end if;

  -- THE TWO GRAINS MUST AGREE. batter_seasons is the combined total and
  -- batter_team_seasons is the same performance split by club, so their plate
  -- appearances must be equal for every player-season that has splits. This is
  -- the check that would catch a package which lost a traded player's second
  -- club — the exact failure that makes a career look smaller than it was.
  --
  -- ONE GROUPED PASS, NO JOIN (supabase/fix_slow_promote_mlb.sql). This was a
  -- join of the staged seasons to an aggregate of the staged splits, and how
  -- long it took depended on what the planner believed staging held. Staging
  -- is bulk-filled and bulk-emptied, so its statistics routinely describe an
  -- earlier import or none; the planner then expected one row a side, chose a
  -- nested loop and re-ran the aggregate once per player-season — 118 million
  -- comparisons at 2026's volume, 47 s — and PostgREST cancelled the gate
  -- (57014) on every run from 2026-10-06. Stacking the grains and grouping once
  -- asks the same question with no plan to get wrong: a key counts only when
  -- it has a combined row AND at least one split, exactly what the inner join
  -- kept, and the duplicate check above has already proved the combined row
  -- unique.
  select count(*) into grain_breaks from (
    select g.player_id, g.season
      from (select player_id, season, plate_appearances, true as combined
              from mlbhist.stg_batter_seasons where import_id = p_import_id
            union all
            select player_id, season, plate_appearances, false
              from mlbhist.stg_batter_team_seasons where import_id = p_import_id) g
     group by g.player_id, g.season
    having bool_or(g.combined) and bool_or(not g.combined)
       and coalesce(sum(g.plate_appearances) filter (where g.combined), 0)
        <> coalesce(sum(g.plate_appearances) filter (where not g.combined), 0)) d;
  if grain_breaks > 0 then
    update mlbhist.import_runs set status = 'failed', staged_counts = staged,
      message = format('%s player-season(s) disagree with the sum of their own team splits on plate appearances', grain_breaks),
      finished_at = now() where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'code', 'GRAIN_VIOLATION', 'staged', staged,
      'player_seasons_disagreeing', grain_breaks);
  end if;

  -- ---- the swap -----------------------------------------------------------
  -- Season-keyed tables are replaced for the seasons this dataset covers, so a
  -- record MLB has since removed disappears instead of lingering, and a season
  -- outside the coverage window is left alone. The window-wide summaries are
  -- replaced whole, because that is what they are.
  cov_lo := coalesce(run.coverage_start, (select min(season) from mlbhist.stg_batter_seasons where import_id = p_import_id));
  cov_hi := coalesce(run.coverage_end,   (select max(season) from mlbhist.stg_batter_seasons where import_id = p_import_id));

  delete from mlbhist.batter_seasons               where season between cov_lo and cov_hi;
  delete from mlbhist.batter_team_seasons          where season between cov_lo and cov_hi;
  delete from mlbhist.team_offense_seasons         where season between cov_lo and cov_hi;
  delete from mlbhist.league_offense_seasons       where season between cov_lo and cov_hi;
  delete from mlbhist.offense_validation           where season between cov_lo and cov_hi;
  delete from mlbhist.offense_source_repairs       where season between cov_lo and cov_hi;
  delete from mlbhist.offense_games_reconciliation where season between cov_lo and cov_hi;
  delete from mlbhist.batter_overview where true;
  delete from mlbhist.batter_team_history where true;
  delete from mlbhist.observed_batter_team_runs where true;
  delete from mlbhist.team_offense_overview where true;

  insert into mlbhist.batter_seasons               select * from mlbhist.stg_batter_seasons            where import_id = p_import_id;
  insert into mlbhist.batter_team_seasons          select * from mlbhist.stg_batter_team_seasons       where import_id = p_import_id;
  insert into mlbhist.batter_overview              select * from mlbhist.stg_batter_overview           where import_id = p_import_id;
  insert into mlbhist.batter_team_history          select * from mlbhist.stg_batter_team_history       where import_id = p_import_id;
  insert into mlbhist.observed_batter_team_runs    select * from mlbhist.stg_observed_batter_team_runs where import_id = p_import_id;
  insert into mlbhist.team_offense_seasons         select * from mlbhist.stg_team_offense_seasons      where import_id = p_import_id;
  insert into mlbhist.team_offense_overview        select * from mlbhist.stg_team_offense_overview     where import_id = p_import_id;
  insert into mlbhist.league_offense_seasons       select * from mlbhist.stg_league_offense_seasons    where import_id = p_import_id;
  insert into mlbhist.offense_validation           select * from mlbhist.stg_offense_validation        where import_id = p_import_id;
  insert into mlbhist.offense_source_repairs       select * from mlbhist.stg_offense_source_repairs    where import_id = p_import_id;
  insert into mlbhist.offense_games_reconciliation select * from mlbhist.stg_offense_games_reconciliation where import_id = p_import_id;

  -- Only OFFENSE runs are superseded. The pitching archive's promoted import
  -- is a different dataset in the same ledger and is none of this gate's
  -- business.
  update mlbhist.import_runs set status = 'superseded'
    where status = 'promoted' and dataset = 'offense' and import_id <> p_import_id;
  update mlbhist.import_runs
    set status = 'promoted', staged_counts = staged, promoted_counts = staged,
        promoted_at = now(), finished_at = now(), message = null
    where import_id = p_import_id;

  insert into mlbhist.meta (key, value) values
    ('offense_last_import_id', p_import_id),
    ('offense_last_import_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    ('offense_coverage_start', cov_lo::text),
    ('offense_coverage_end', cov_hi::text),
    ('offense_rating_version', coalesce(run.rating_version, 'ED_BAT_PERF_V1'))
  on conflict (key) do update set value = excluded.value;

  delete from mlbhist.stg_batter_seasons               where import_id = p_import_id;
  delete from mlbhist.stg_batter_team_seasons          where import_id = p_import_id;
  delete from mlbhist.stg_batter_overview              where import_id = p_import_id;
  delete from mlbhist.stg_batter_team_history          where import_id = p_import_id;
  delete from mlbhist.stg_observed_batter_team_runs    where import_id = p_import_id;
  delete from mlbhist.stg_team_offense_seasons         where import_id = p_import_id;
  delete from mlbhist.stg_team_offense_overview        where import_id = p_import_id;
  delete from mlbhist.stg_league_offense_seasons       where import_id = p_import_id;
  delete from mlbhist.stg_offense_validation           where import_id = p_import_id;
  delete from mlbhist.stg_offense_source_repairs       where import_id = p_import_id;
  delete from mlbhist.stg_offense_games_reconciliation where import_id = p_import_id;

  return jsonb_build_object('ok', true, 'import_id', p_import_id,
    'coverage', jsonb_build_object('start', cov_lo, 'end', cov_hi), 'rows', staged);
end $$;

revoke all on function mlbhist.promote_offense_import(text) from public, anon, authenticated;
grant execute on function mlbhist.promote_offense_import(text) to service_role;

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
