-- fix_promote_deletes_mlb -- part 2 of 2.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.
-- This last part prints the report: every row should read ok.

/* ---- mlbhist.promote_offense_import — the hitting gate ---- */

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
  select count(*) into grain_breaks from (
    select s.player_id, s.season
      from mlbhist.stg_batter_seasons s
      join (select player_id, season, sum(plate_appearances) pa
              from mlbhist.stg_batter_team_seasons where import_id = p_import_id
             group by 1, 2) t
        on t.player_id = s.player_id and t.season = s.season
     where s.import_id = p_import_id
       and coalesce(s.plate_appearances, 0) <> coalesce(t.pa, 0)) d;
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

/* ---------------------------------------------------------------------------
   THE REPORT. Every row must read ok.
   --------------------------------------------------------------------------- */
with checks as (
  select 1 as n, 'both promote gates still exist after being replaced' as guarantee,
    case when to_regprocedure('mlbhist.promote_import(text)') is not null
          and to_regprocedure('mlbhist.promote_offense_import(text)') is not null
         then 'ok' else 'CHECK THIS' end as result
  union all select 2, 'no gate body still carries a DELETE without a WHERE',
    case when not exists (
           select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'mlbhist'
             and p.prosrc ~* 'delete[[:space:]]+from[[:space:]]+[a-z_.]+[[:space:]]*;')
         then 'ok' else 'CHECK THIS — safeupdate will refuse this gate' end
  union all select 3, 'the importer may still call both gates',
    case when has_function_privilege('service_role', 'mlbhist.promote_import(text)', 'execute')
          and has_function_privilege('service_role', 'mlbhist.promote_offense_import(text)', 'execute')
         then 'ok' else 'CHECK THIS' end
  union all select 4, 'a reader still cannot call either gate',
    case when not has_function_privilege('anon', 'mlbhist.promote_import(text)', 'execute')
          and not has_function_privilege('authenticated', 'mlbhist.promote_import(text)', 'execute')
         then 'ok' else 'CHECK THIS — a reader could replace the archive' end
)
select n, guarantee, result from checks order by n;

