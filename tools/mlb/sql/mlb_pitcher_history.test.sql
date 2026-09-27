-- ===========================================================================
-- EdgeDesk MLB — supabase/mlb_pitcher_history.sql, attacked on a real
-- PostgreSQL.
--
-- What must be true, proved rather than reasoned about:
--   * anon and authenticated can READ the record and the status view, and
--     cannot write a single row anywhere in the contract;
--   * STAGING cannot even be read by a client role, and the promote gate is
--     not executable by one — an unpromoted dataset has not passed its checks
--     and no screen may see it;
--   * a good import promotes, and promoting THE SAME dataset a second time
--     leaves exactly the same rows (an import is repeatable, never additive);
--   * the four refusals all leave the previously promoted data untouched:
--       EMPTY_STAGING, COUNT_MISMATCH, DUPLICATE_KEY, VALIDATION_FAILED;
--   * a traded pitcher keeps one row per club and the season row is their sum,
--     with neither grain able to overwrite the other;
--   * the unique keys are enforced on the live tables, not just intended;
--   * a season outside the coverage window survives a promotion that covers a
--     different window — an archive is not silently narrowed by a refresh;
--   * service_role can write mlbhist.meta (the grant a production UFC run
--     discovered it was missing).
-- ===========================================================================
\set ON_ERROR_STOP on
set client_min_messages = notice;

create or replace function pg_temp.ok(p_name text, p_cond boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  if p_cond then raise notice 'ok   %', p_name;
  else raise exception 'FAIL: % %', p_name, coalesce('— ' || p_detail, '');
  end if;
end; $$;
create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin execute 'set local role anon'; end; $$;
create or replace function pg_temp.as_user() returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', false); execute 'set local role authenticated'; end; $$;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin execute 'set local role service_role'; end; $$;
create or replace function pg_temp.as_owner() returns void language plpgsql as $$
begin execute 'reset role'; end; $$;

-- One helper that stages a complete, minimal but REALISTIC import: two
-- pitchers in 2024, one of whom was traded mid-season and therefore has two
-- club rows summing to one season row — the exact shape the record is built
-- around and the exact shape a careless import breaks.
create or replace function pg_temp.stage(p_import text, p_season int default 2024)
returns void language plpgsql as $$
begin
  insert into mlbhist.stg_pitcher_seasons
    (player_id, season, player_name, name_key, position_reported, team_count, team_ids, teams,
     games, starts, outs, hits, runs, earned_runs, home_runs, strikeouts, walks, hit_batters, batters_faced,
     innings_display, innings_decimal, era, whip, k_pct, bb_pct, k_minus_bb_pct, role, sample_flag,
     league_era, fip_constant, fip, performance_index, rating_version, rating_sample_weight, import_id)
  values
    (472610, p_season, 'Luis García', 'luis garcia', 'P', 2, '{108,111}', 'Los Angeles Angels; Boston Red Sox',
     60, 0, 177, 60, 30, 28, 6, 55, 25, 2, 250,
     '59.0', 59.0, 4.271186, 1.440678, 0.22, 0.10, 0.12, 'reliever', '40_plus_IP',
     4.080000, 3.100000, 4.012000, 99.100000, 'ED_PITCH_PERF_V1', 0.595960, p_import),
    (543037, p_season, 'Gerrit Cole', 'gerrit cole', 'P', 1, '{147}', 'New York Yankees',
     17, 17, 285, 85, 40, 38, 10, 99, 25, 3, 380,
     '95.0', 95.0, 3.600000, 1.157895, 0.26, 0.066, 0.194, 'starter', '40_plus_IP',
     4.080000, 3.100000, 3.400000, 111.000000, 'ED_PITCH_PERF_V1', 0.703704, p_import);

  insert into mlbhist.stg_pitcher_team_seasons
    (player_id, season, team_id, player_name, name_key, team_name, position_reported,
     games, starts, outs, hits, runs, earned_runs, home_runs, strikeouts, walks, hit_batters, batters_faced,
     innings_display, innings_decimal, era, whip, role, sample_flag,
     league_era, fip_constant, fip, performance_index, rating_version, import_id)
  values
    (472610, p_season, 108, 'Luis García', 'luis garcia', 'Los Angeles Angels', 'P',
     45, 0, 131, 44, 20, 18, 4, 40, 18, 1, 185, '43.2', 43.666667, 3.709924, 1.419847,
     'reliever', '40_plus_IP', 4.080000, 3.100000, 3.693197, 104.872000, 'ED_PITCH_PERF_V1', p_import),
    (472610, p_season, 111, 'Luis García', 'luis garcia', 'Boston Red Sox', 'P',
     15, 0, 46, 16, 10, 10, 2, 15, 7, 1, 65, '15.1', 15.333333, 8.217391, 1.500000,
     'reliever', '10_to_39_IP', 4.080000, 3.100000, 5.057784, 86.911000, 'ED_PITCH_PERF_V1', p_import),
    (543037, p_season, 147, 'Gerrit Cole', 'gerrit cole', 'New York Yankees', 'P',
     17, 17, 285, 85, 40, 38, 10, 99, 25, 3, 380, '95.0', 95.0, 3.600000, 1.157895,
     'starter', '40_plus_IP', 4.080000, 3.100000, 3.400000, 111.000000, 'ED_PITCH_PERF_V1', p_import);

  insert into mlbhist.stg_pitcher_overview
    (player_id, player_name, name_key, games, starts, outs, innings_display, innings_decimal, era, whip,
     role, sample_flag, first_observed_season, last_observed_season, seasons_with_appearances,
     observed_seasons, boundary_start, boundary_end, weighted_performance_index,
     latest_observed_performance_index, latest_observed_role, best_season_by_index, team_count, teams,
     rating_version, import_id)
  values
    (472610, 'Luis García', 'luis garcia', 60, 0, 177, '59.0', 59.0, 4.271186, 1.440678,
     'reliever', '40_plus_IP', p_season, p_season, 1, p_season::text, false, true, 99.100000,
     99.100000, 'reliever', p_season, 2, 'Los Angeles Angels; Boston Red Sox', 'ED_PITCH_PERF_V1', p_import),
    (543037, 'Gerrit Cole', 'gerrit cole', 17, 17, 285, '95.0', 95.0, 3.600000, 1.157895,
     'starter', '40_plus_IP', p_season, p_season, 1, p_season::text, false, true, 111.000000,
     111.000000, 'starter', p_season, 1, 'New York Yankees', 'ED_PITCH_PERF_V1', p_import);

  insert into mlbhist.stg_pitcher_team_history
    (player_id, team_id, player_name, name_key, team_names_observed, games, starts, outs,
     innings_display, innings_decimal, era, role, sample_flag, first_observed_season, last_observed_season,
     seasons_with_appearances, observed_seasons, weighted_performance_index, rating_version, import_id)
  values
    (472610, 108, 'Luis García', 'luis garcia', 'Los Angeles Angels', 45, 0, 131, '43.2', 43.666667, 3.709924,
     'reliever', '40_plus_IP', p_season, p_season, 1, p_season::text, 104.872000, 'ED_PITCH_PERF_V1', p_import),
    (472610, 111, 'Luis García', 'luis garcia', 'Boston Red Sox', 15, 0, 46, '15.1', 15.333333, 8.217391,
     'reliever', '10_to_39_IP', p_season, p_season, 1, p_season::text, 86.911000, 'ED_PITCH_PERF_V1', p_import),
    (543037, 147, 'Gerrit Cole', 'gerrit cole', 'New York Yankees', 17, 17, 285, '95.0', 95.0, 3.600000,
     'starter', '40_plus_IP', p_season, p_season, 1, p_season::text, 111.000000, 'ED_PITCH_PERF_V1', p_import);

  insert into mlbhist.stg_observed_team_runs
    (player_id, team_id, observed_run_number, player_name, name_key, team_names_observed,
     games, starts, outs, innings_display, innings_decimal, first_observed_season, last_observed_season,
     seasons_with_appearances, observed_seasons, weighted_performance_index, rating_version, import_id)
  values
    (472610, 108, 1, 'Luis García', 'luis garcia', 'Los Angeles Angels', 45, 0, 131, '43.2', 43.666667,
     p_season, p_season, 1, p_season::text, 104.872000, 'ED_PITCH_PERF_V1', p_import),
    (472610, 111, 1, 'Luis García', 'luis garcia', 'Boston Red Sox', 15, 0, 46, '15.1', 15.333333,
     p_season, p_season, 1, p_season::text, 86.911000, 'ED_PITCH_PERF_V1', p_import),
    (543037, 147, 1, 'Gerrit Cole', 'gerrit cole', 'New York Yankees', 17, 17, 285, '95.0', 95.0,
     p_season, p_season, 1, p_season::text, 111.000000, 'ED_PITCH_PERF_V1', p_import);

  insert into mlbhist.stg_league_seasons
    (season, games, starts, outs, earned_runs, home_runs, strikeouts, walks, hit_batters, batters_faced,
     league_era, fip_constant, rating_version, import_id)
  values (p_season, 100000, 4860, 130000, 19600, 5400, 41000, 15000, 2000, 185000,
          4.080000, 3.100000, 'ED_PITCH_PERF_V1', p_import);

  insert into mlbhist.stg_teams (season, team_id, team_name, abbreviation, league, division, import_id)
  values (p_season, 108, 'Los Angeles Angels', 'LAA', 'American League', 'American League West', p_import),
         (p_season, 111, 'Boston Red Sox', 'BOS', 'American League', 'American League East', p_import),
         (p_season, 147, 'New York Yankees', 'NYY', 'American League', 'American League East', p_import);

  insert into mlbhist.stg_validation (season, teams, pitchers, pitcher_team_rows, player_totals_reconcile, import_id)
  values (p_season, 30, 2, 3, true, p_import);

  insert into mlbhist.stg_source_repairs (season, player_id, previous_team_rows, replacement_team_rows, source_url, import_id)
  values (p_season, 472610, 1, 2,
          'https://statsapi.mlb.com/api/v1/people/472610/stats?stats=yearByYear&group=pitching&sportIds=1&gameType=R', p_import);
end; $$;

create or replace function pg_temp.open_run(p_import text, p_season int default 2024, p_expected jsonb default null)
returns void language plpgsql as $$
begin
  insert into mlbhist.import_runs
    (import_id, coverage_start, coverage_end, rating_version, source, expected_counts)
  values (p_import, p_season, p_season, 'ED_PITCH_PERF_V1', 'test',
          coalesce(p_expected, jsonb_build_object(
            'pitcher_seasons', 2, 'pitcher_team_seasons', 3, 'pitcher_overview', 2,
            'pitcher_team_history', 3, 'observed_team_runs', 3, 'league_seasons', 1, 'teams', 3)));
end; $$;

do $test$
declare
  n integer; failed boolean; j jsonb; era1 double precision; era2 double precision;
begin
  -- ── a good import promotes ───────────────────────────────────────────────
  perform pg_temp.as_service();
  perform pg_temp.open_run('imp-1');
  perform pg_temp.stage('imp-1');

  select count(*) into n from mlbhist.pitcher_seasons;
  perform pg_temp.ok('the record is empty before any promotion', n = 0);

  j := mlbhist.promote_import('imp-1');
  perform pg_temp.ok('a validated import promotes', (j->>'ok')::boolean, j::text);

  select count(*) into n from mlbhist.pitcher_seasons;
  perform pg_temp.ok('two player-seasons are live', n = 2, 'got ' || n);
  select count(*) into n from mlbhist.pitcher_team_seasons;
  perform pg_temp.ok('three player-team-seasons are live', n = 3, 'got ' || n);

  -- the shape the whole record turns on
  select count(*) into n from mlbhist.pitcher_team_seasons where player_id = 472610 and season = 2024;
  perform pg_temp.ok('a traded pitcher keeps one row per club', n = 2, 'got ' || n);
  select sum(outs) into n from mlbhist.pitcher_team_seasons where player_id = 472610 and season = 2024;
  perform pg_temp.ok('the club rows sum to the season row (177 outs)',
    n = (select outs from mlbhist.pitcher_seasons where player_id = 472610 and season = 2024), 'club sum ' || n);
  perform pg_temp.ok('both clubs are named, not just the last one',
    (select count(distinct team_id) from mlbhist.pitcher_team_seasons where player_id = 472610) = 2);

  select count(*) into n from mlbhist.stg_pitcher_seasons where import_id = 'imp-1';
  perform pg_temp.ok('staging is cleared for a promoted import', n = 0, 'got ' || n);
  perform pg_temp.ok('the import ledger records the promotion',
    (select status from mlbhist.import_runs where import_id = 'imp-1') = 'promoted');
  perform pg_temp.ok('meta carries the coverage window',
    (select value from mlbhist.meta where key = 'coverage_end') = '2024');

  -- ── the same dataset twice is the same database ──────────────────────────
  select era into era1 from mlbhist.pitcher_seasons where player_id = 543037 and season = 2024;
  perform pg_temp.open_run('imp-2');
  perform pg_temp.stage('imp-2');
  j := mlbhist.promote_import('imp-2');
  perform pg_temp.ok('re-importing the same dataset promotes again', (j->>'ok')::boolean, j::text);
  select count(*) into n from mlbhist.pitcher_seasons;
  perform pg_temp.ok('a repeat import does NOT duplicate player-seasons', n = 2, 'got ' || n);
  select count(*) into n from mlbhist.pitcher_team_seasons;
  perform pg_temp.ok('a repeat import does NOT duplicate player-team-seasons', n = 3, 'got ' || n);
  select era into era2 from mlbhist.pitcher_seasons where player_id = 543037 and season = 2024;
  perform pg_temp.ok('a repeat import leaves the values identical', era1 = era2);
  perform pg_temp.ok('the previous import is marked superseded',
    (select status from mlbhist.import_runs where import_id = 'imp-1') = 'superseded');

  -- ── refusal 1: nothing staged ────────────────────────────────────────────
  perform pg_temp.open_run('imp-empty');
  j := mlbhist.promote_import('imp-empty');
  perform pg_temp.ok('an empty import is refused', (j->>'ok')::boolean is false and j->>'code' = 'EMPTY_STAGING', j::text);
  select count(*) into n from mlbhist.pitcher_seasons;
  perform pg_temp.ok('EMPTY_STAGING left the live record intact', n = 2, 'got ' || n);

  -- ── refusal 2: the package's own counts disagree ─────────────────────────
  perform pg_temp.open_run('imp-short', 2024, jsonb_build_object('pitcher_seasons', 8233));
  perform pg_temp.stage('imp-short');
  j := mlbhist.promote_import('imp-short');
  perform pg_temp.ok('a short dataset is refused', (j->>'ok')::boolean is false and j->>'code' = 'COUNT_MISMATCH', j::text);
  select count(*) into n from mlbhist.pitcher_seasons;
  perform pg_temp.ok('COUNT_MISMATCH left the live record intact', n = 2, 'got ' || n);
  perform pg_temp.ok('the refused import is marked failed, not promoted',
    (select status from mlbhist.import_runs where import_id = 'imp-short') = 'failed');

  -- ── refusal 3: a duplicate key ───────────────────────────────────────────
  perform pg_temp.open_run('imp-dup', 2024, jsonb_build_object('pitcher_seasons', 3, 'pitcher_team_seasons', 3));
  perform pg_temp.stage('imp-dup');
  insert into mlbhist.stg_pitcher_seasons (player_id, season, player_name, name_key, outs, import_id)
    values (543037, 2024, 'Gerrit Cole', 'gerrit cole', 285, 'imp-dup');
  j := mlbhist.promote_import('imp-dup');
  perform pg_temp.ok('a duplicate player-season is refused', (j->>'ok')::boolean is false and j->>'code' = 'DUPLICATE_KEY', j::text);
  select count(*) into n from mlbhist.pitcher_seasons;
  perform pg_temp.ok('DUPLICATE_KEY left the live record intact', n = 2, 'got ' || n);

  -- ── refusal 4: the package did not reconcile ─────────────────────────────
  perform pg_temp.open_run('imp-bad');
  perform pg_temp.stage('imp-bad');
  update mlbhist.stg_validation set player_totals_reconcile = false where import_id = 'imp-bad';
  j := mlbhist.promote_import('imp-bad');
  perform pg_temp.ok('an unreconciled season is refused', (j->>'ok')::boolean is false and j->>'code' = 'VALIDATION_FAILED', j::text);
  select count(*) into n from mlbhist.pitcher_seasons;
  perform pg_temp.ok('VALIDATION_FAILED left the live record intact', n = 2, 'got ' || n);

  -- ── abandoning clears staging and touches nothing live ───────────────────
  j := mlbhist.abandon_import('imp-bad', 'test abandon');
  select count(*) into n from mlbhist.stg_pitcher_seasons where import_id = 'imp-bad';
  perform pg_temp.ok('abandon clears the staged rows', n = 0);
  select count(*) into n from mlbhist.pitcher_seasons;
  perform pg_temp.ok('abandon left the live record intact', n = 2, 'got ' || n);

  -- ── a refresh of one window does not narrow the archive ──────────────────
  perform pg_temp.open_run('imp-2023', 2023, jsonb_build_object(
    'pitcher_seasons', 2, 'pitcher_team_seasons', 3, 'pitcher_overview', 2,
    'pitcher_team_history', 3, 'observed_team_runs', 3, 'league_seasons', 1, 'teams', 3));
  perform pg_temp.stage('imp-2023', 2023);
  j := mlbhist.promote_import('imp-2023');
  perform pg_temp.ok('a 2023-only dataset promotes', (j->>'ok')::boolean, j::text);
  select count(*) into n from mlbhist.pitcher_seasons where season = 2024;
  perform pg_temp.ok('the 2024 seasons survive a 2023-only refresh', n = 2, 'got ' || n);
  select count(*) into n from mlbhist.pitcher_seasons where season = 2023;
  perform pg_temp.ok('the 2023 seasons are now live too', n = 2, 'got ' || n);

  -- ── the unique keys are enforced, not merely intended ────────────────────
  failed := false;
  begin
    insert into mlbhist.pitcher_seasons (player_id, season, player_name, name_key)
      values (543037, 2024, 'Gerrit Cole', 'gerrit cole');
  exception when unique_violation then failed := true;
  end;
  perform pg_temp.ok('a duplicate (player_id, season) is rejected by the table', failed);
  failed := false;
  begin
    insert into mlbhist.pitcher_team_seasons (player_id, season, team_id, player_name, name_key)
      values (472610, 2024, 108, 'Luis García', 'luis garcia');
  exception when unique_violation then failed := true;
  end;
  perform pg_temp.ok('a duplicate (player_id, season, team_id) is rejected by the table', failed);

  -- ── nulls survive the round trip ─────────────────────────────────────────
  insert into mlbhist.pitcher_seasons (player_id, season, player_name, name_key, games, starts, outs, sample_flag)
    values (467827, 2019, 'Gerardo Parra', 'gerardo parra', 1, 0, 0, 'zero_outs');
  perform pg_temp.ok('a zero-out appearance stores NULL rates, not zeros',
    (select era is null and fip is null and whip is null and performance_index is null
       from mlbhist.pitcher_seasons where player_id = 467827 and season = 2019));

  perform pg_temp.ok('service role can write mlbhist.meta',
    (select value from mlbhist.meta where key = 'last_import_id') is not null);

  -- ── the client roles: read the record, write nothing, see no staging ─────
  perform pg_temp.as_anon();
  select count(*) into n from mlbhist.pitcher_seasons;
  perform pg_temp.ok('anon can read the record', n > 0, 'got ' || n);
  select count(*) into n from mlbhist.dataset_status;
  perform pg_temp.ok('anon can read the dataset status view', n = 1, 'got ' || n);

  failed := false;
  begin insert into mlbhist.pitcher_seasons (player_id, season, player_name, name_key)
    values (1, 2024, 'Nobody', 'nobody');
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot insert a player-season', failed);
  failed := false;
  begin update mlbhist.pitcher_seasons set era = 0.00 where player_id = 543037;
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot rewrite a rating', failed
    or (select era from mlbhist.pitcher_seasons where player_id = 543037 and season = 2024) <> 0.0);
  failed := false;
  begin delete from mlbhist.pitcher_team_seasons where player_id = 472610;
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot delete a club row', failed
    or (select count(*) from mlbhist.pitcher_team_seasons where player_id = 472610) = 2);

  failed := false;
  begin select count(*) into n from mlbhist.stg_pitcher_seasons;
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot read staging at all', failed);

  failed := false;
  begin perform mlbhist.promote_import('imp-1');
  exception when others then failed := true; end;
  perform pg_temp.ok('anon cannot execute the promote gate', failed);

  perform pg_temp.as_user();
  select count(*) into n from mlbhist.pitcher_team_history;
  perform pg_temp.ok('authenticated can read the club record', n > 0, 'got ' || n);
  failed := false;
  begin insert into mlbhist.import_runs (import_id) values ('client-forged');
  exception when others then failed := true; end;
  perform pg_temp.ok('authenticated cannot open an import run', failed);
  failed := false;
  begin perform mlbhist.abandon_import('imp-1', 'nope');
  exception when others then failed := true; end;
  perform pg_temp.ok('authenticated cannot abandon an import', failed);

  perform pg_temp.as_owner();
  raise notice 'ALL GREEN mlb_pitcher_history.sql';
end $test$;
