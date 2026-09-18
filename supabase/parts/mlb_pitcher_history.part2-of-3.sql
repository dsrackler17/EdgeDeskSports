-- mlb_pitcher_history -- part 2 of 3.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- The player-seasons whose team splits were REPLACED with MLB's individual
-- year-by-year history because the per-team query omitted an earlier club.
-- Kept so a traded pitcher's record can be shown to have been repaired rather
-- than silently corrected.
create table if not exists mlbhist.source_repairs (
  season                 int not null,
  player_id              int not null,
  previous_team_rows     int,
  replacement_team_rows  int,
  source_url             text,
  import_id              text,
  imported_at            timestamptz not null default now(),
  constraint mlbhist_source_repairs_key primary key (season, player_id)
);

-- ---------------------------------------------------------------------------
-- Indexes. Player, team, season and the comparison/leaderboard reads named in
-- the query layer (lib/mlb_pitcher_history.js). Everything the UI and the AI
-- ask for lands on one of these.
-- ---------------------------------------------------------------------------
create index if not exists mlbhist_seasons_player_idx        on mlbhist.pitcher_seasons (player_id, season);
create index if not exists mlbhist_seasons_season_idx        on mlbhist.pitcher_seasons (season);
create index if not exists mlbhist_seasons_name_idx          on mlbhist.pitcher_seasons (name_key);
create index if not exists mlbhist_seasons_board_idx         on mlbhist.pitcher_seasons (season, role, outs desc);
create index if not exists mlbhist_seasons_rating_idx        on mlbhist.pitcher_seasons (season, performance_index desc nulls last);
create index if not exists mlbhist_team_seasons_player_idx   on mlbhist.pitcher_team_seasons (player_id, season);
create index if not exists mlbhist_team_seasons_team_idx     on mlbhist.pitcher_team_seasons (team_id, season, outs desc);
create index if not exists mlbhist_team_seasons_season_idx   on mlbhist.pitcher_team_seasons (season, team_id);
create index if not exists mlbhist_team_seasons_name_idx     on mlbhist.pitcher_team_seasons (name_key);
create index if not exists mlbhist_overview_name_idx         on mlbhist.pitcher_overview (name_key);
create index if not exists mlbhist_overview_last_idx         on mlbhist.pitcher_overview (last_observed_season desc, outs desc);
create index if not exists mlbhist_overview_workload_idx     on mlbhist.pitcher_overview (outs desc);
create index if not exists mlbhist_team_history_team_idx     on mlbhist.pitcher_team_history (team_id, outs desc);
create index if not exists mlbhist_team_history_player_idx   on mlbhist.pitcher_team_history (player_id);
create index if not exists mlbhist_runs_player_idx           on mlbhist.observed_team_runs (player_id, first_observed_season);
create index if not exists mlbhist_runs_team_idx             on mlbhist.observed_team_runs (team_id, first_observed_season);
create index if not exists mlbhist_teams_team_idx            on mlbhist.teams (team_id, season desc);

-- ===========================================================================
-- STAGING. A structural copy of every record table. The importer writes here
-- first; promote_import() is the only thing that moves rows across.
-- `create table ... (like ...)` copies columns, types, defaults and not-null
-- but deliberately NOT the primary keys — staging is a landing strip, and a
-- duplicate arriving there is a fact the promote gate should report rather
-- than a write that fails halfway through an import.
-- ===========================================================================
create table if not exists mlbhist.stg_pitcher_seasons      (like mlbhist.pitcher_seasons      including defaults);
create table if not exists mlbhist.stg_pitcher_team_seasons (like mlbhist.pitcher_team_seasons including defaults);
create table if not exists mlbhist.stg_pitcher_overview     (like mlbhist.pitcher_overview     including defaults);
create table if not exists mlbhist.stg_pitcher_team_history (like mlbhist.pitcher_team_history including defaults);
create table if not exists mlbhist.stg_observed_team_runs   (like mlbhist.observed_team_runs   including defaults);
create table if not exists mlbhist.stg_league_seasons       (like mlbhist.league_seasons       including defaults);
create table if not exists mlbhist.stg_teams                (like mlbhist.teams                including defaults);
create table if not exists mlbhist.stg_validation           (like mlbhist.validation           including defaults);
create table if not exists mlbhist.stg_source_repairs       (like mlbhist.source_repairs       including defaults);

create index if not exists mlbhist_stg_seasons_import_idx      on mlbhist.stg_pitcher_seasons (import_id);
create index if not exists mlbhist_stg_team_seasons_import_idx on mlbhist.stg_pitcher_team_seasons (import_id);
create index if not exists mlbhist_stg_overview_import_idx     on mlbhist.stg_pitcher_overview (import_id);
create index if not exists mlbhist_stg_team_history_import_idx on mlbhist.stg_pitcher_team_history (import_id);
create index if not exists mlbhist_stg_runs_import_idx         on mlbhist.stg_observed_team_runs (import_id);
create index if not exists mlbhist_stg_league_import_idx       on mlbhist.stg_league_seasons (import_id);
create index if not exists mlbhist_stg_teams_import_idx        on mlbhist.stg_teams (import_id);
create index if not exists mlbhist_stg_validation_import_idx   on mlbhist.stg_validation (import_id);
create index if not exists mlbhist_stg_repairs_import_idx      on mlbhist.stg_source_repairs (import_id);

-- ===========================================================================
-- THE PROMOTE GATE.
--
-- One transaction. It checks the staged rows against what the package said it
-- was shipping and against the keys the record depends on, and only then
-- replaces the live tables. Anything it refuses leaves the last successful
-- dataset exactly where it was, which is the difference between a failed
-- refresh and a lost archive.
--
-- The four refusals, each returned by name rather than as a generic error:
--   EMPTY_STAGING        nothing was staged for this import
--   COUNT_MISMATCH       staged rows disagree with the package's own counts
--   DUPLICATE_KEY        the same (player, season[, team]) arrived twice
--   VALIDATION_FAILED    the package's own per-season reconciliation did not pass
-- ===========================================================================
create or replace function mlbhist.promote_import(p_import_id text)
returns jsonb
language plpgsql
security definer
set search_path = mlbhist, public
as $$
declare
  run           mlbhist.import_runs%rowtype;
  n_seasons     bigint; n_team_seasons bigint; n_overview bigint; n_team_history bigint;
  n_runs        bigint; n_league bigint; n_teams bigint; n_validation bigint; n_repairs bigint;
  dup_seasons   bigint; dup_team_seasons bigint;
  bad_seasons   bigint;
  expected      jsonb;
  staged        jsonb;
  problems      text[] := '{}';
  cov_lo        int; cov_hi int;
begin
  select * into run from mlbhist.import_runs where import_id = p_import_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'UNKNOWN_IMPORT',
      'detail', format('no import_runs row for %s', p_import_id));
  end if;

  select count(*) into n_seasons      from mlbhist.stg_pitcher_seasons      where import_id = p_import_id;
  select count(*) into n_team_seasons from mlbhist.stg_pitcher_team_seasons where import_id = p_import_id;
  select count(*) into n_overview     from mlbhist.stg_pitcher_overview     where import_id = p_import_id;
  select count(*) into n_team_history from mlbhist.stg_pitcher_team_history where import_id = p_import_id;
  select count(*) into n_runs         from mlbhist.stg_observed_team_runs   where import_id = p_import_id;
  select count(*) into n_league       from mlbhist.stg_league_seasons       where import_id = p_import_id;
  select count(*) into n_teams        from mlbhist.stg_teams                where import_id = p_import_id;
  select count(*) into n_validation   from mlbhist.stg_validation           where import_id = p_import_id;
  select count(*) into n_repairs      from mlbhist.stg_source_repairs       where import_id = p_import_id;

  staged := jsonb_build_object(
    'pitcher_seasons', n_seasons, 'pitcher_team_seasons', n_team_seasons,
    'pitcher_overview', n_overview, 'pitcher_team_history', n_team_history,
    'observed_team_runs', n_runs, 'league_seasons', n_league,
    'teams', n_teams, 'validation', n_validation, 'source_repairs', n_repairs);

  if n_seasons = 0 or n_team_seasons = 0 or n_overview = 0 then
    update mlbhist.import_runs set status = 'failed', staged_counts = staged,
      message = 'nothing was staged for this import', finished_at = now()
      where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'code', 'EMPTY_STAGING', 'staged', staged);
  end if;

  -- The package's own counts. A dataset that claims 8,233 pitcher-seasons and
  -- stages 8,000 has lost rows somewhere between the file and here, and the
  -- live table is a better answer than a truncated refresh.
  expected := coalesce(run.expected_counts, '{}'::jsonb);
  if expected ? 'pitcher_seasons'      and (expected->>'pitcher_seasons')::bigint      <> n_seasons      then problems := problems || format('pitcher_seasons expected %s staged %s',      expected->>'pitcher_seasons',      n_seasons); end if;
  if expected ? 'pitcher_team_seasons' and (expected->>'pitcher_team_seasons')::bigint <> n_team_seasons then problems := problems || format('pitcher_team_seasons expected %s staged %s', expected->>'pitcher_team_seasons', n_team_seasons); end if;
  if expected ? 'pitcher_overview'     and (expected->>'pitcher_overview')::bigint     <> n_overview     then problems := problems || format('pitcher_overview expected %s staged %s',     expected->>'pitcher_overview',     n_overview); end if;
  if expected ? 'pitcher_team_history' and (expected->>'pitcher_team_history')::bigint <> n_team_history then problems := problems || format('pitcher_team_history expected %s staged %s', expected->>'pitcher_team_history', n_team_history); end if;
  if expected ? 'observed_team_runs'   and (expected->>'observed_team_runs')::bigint   <> n_runs         then problems := problems || format('observed_team_runs expected %s staged %s',   expected->>'observed_team_runs',   n_runs); end if;
  if expected ? 'league_seasons'       and (expected->>'league_seasons')::bigint       <> n_league       then problems := problems || format('league_seasons expected %s staged %s',       expected->>'league_seasons',       n_league); end if;
  if expected ? 'teams'                and (expected->>'teams')::bigint                <> n_teams        then problems := problems || format('teams expected %s staged %s',                expected->>'teams',                n_teams); end if;

  if array_length(problems, 1) is not null then
    update mlbhist.import_runs set status = 'failed', staged_counts = staged,
      message = 'staged rows disagree with the package: ' || array_to_string(problems, '; '), finished_at = now()
      where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'code', 'COUNT_MISMATCH', 'staged', staged,
      'expected', expected, 'problems', to_jsonb(problems));
  end if;

  select count(*) into dup_seasons from (
    select player_id, season from mlbhist.stg_pitcher_seasons where import_id = p_import_id
    group by 1, 2 having count(*) > 1) d;
  select count(*) into dup_team_seasons from (
    select player_id, season, team_id from mlbhist.stg_pitcher_team_seasons where import_id = p_import_id
    group by 1, 2, 3 having count(*) > 1) d;
  if dup_seasons > 0 or dup_team_seasons > 0 then
    update mlbhist.import_runs set status = 'failed', staged_counts = staged,
      message = format('duplicate keys staged: %s player-seasons, %s player-team-seasons', dup_seasons, dup_team_seasons),
      finished_at = now() where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'code', 'DUPLICATE_KEY', 'staged', staged,
      'duplicate_player_seasons', dup_seasons, 'duplicate_player_team_seasons', dup_team_seasons);
  end if;

  select count(*) into bad_seasons from mlbhist.stg_validation
    where import_id = p_import_id and player_totals_reconcile is distinct from true;
  if bad_seasons > 0 then
    update mlbhist.import_runs set status = 'failed', staged_counts = staged,
      message = format('%s season(s) failed the package reconciliation', bad_seasons), finished_at = now()
      where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'staged', staged,
      'unreconciled_seasons', bad_seasons);
  end if;

  -- ---- the swap -----------------------------------------------------------
  -- Season-keyed tables are replaced for the seasons this dataset covers, so
  -- a record MLB has since removed disappears instead of lingering, and a
  -- season outside the coverage window (an older archive still on file) is
  -- left alone. The window-wide summaries are replaced whole, because that is
  -- what they are: a summary of everything the window holds.
  cov_lo := coalesce(run.coverage_start, (select min(season) from mlbhist.stg_pitcher_seasons where import_id = p_import_id));
  cov_hi := coalesce(run.coverage_end,   (select max(season) from mlbhist.stg_pitcher_seasons where import_id = p_import_id));

  delete from mlbhist.pitcher_seasons      where season between cov_lo and cov_hi;
  delete from mlbhist.pitcher_team_seasons where season between cov_lo and cov_hi;
  delete from mlbhist.league_seasons       where season between cov_lo and cov_hi;
  delete from mlbhist.teams                where season between cov_lo and cov_hi;
  delete from mlbhist.validation           where season between cov_lo and cov_hi;
  delete from mlbhist.source_repairs       where season between cov_lo and cov_hi;
  delete from mlbhist.pitcher_overview;
  delete from mlbhist.pitcher_team_history;
  delete from mlbhist.observed_team_runs;

  insert into mlbhist.pitcher_seasons      select * from mlbhist.stg_pitcher_seasons      where import_id = p_import_id;
  insert into mlbhist.pitcher_team_seasons select * from mlbhist.stg_pitcher_team_seasons where import_id = p_import_id;
  insert into mlbhist.pitcher_overview     select * from mlbhist.stg_pitcher_overview     where import_id = p_import_id;
  insert into mlbhist.pitcher_team_history select * from mlbhist.stg_pitcher_team_history where import_id = p_import_id;
  insert into mlbhist.observed_team_runs   select * from mlbhist.stg_observed_team_runs   where import_id = p_import_id;
  insert into mlbhist.league_seasons       select * from mlbhist.stg_league_seasons       where import_id = p_import_id;
  insert into mlbhist.teams                select * from mlbhist.stg_teams                where import_id = p_import_id;
  insert into mlbhist.validation           select * from mlbhist.stg_validation           where import_id = p_import_id;
  insert into mlbhist.source_repairs       select * from mlbhist.stg_source_repairs       where import_id = p_import_id;

  -- Only PITCHING runs are superseded. The offensive archive shares this
  -- ledger (discriminated by import_runs.dataset) and its promoted import is
  -- none of this gate's business; superseding it here would empty
  -- mlbhist.offense_status without touching a single offensive row.
  update mlbhist.import_runs set status = 'superseded'
    where status = 'promoted' and import_id <> p_import_id
      and coalesce(dataset, 'pitching') = 'pitching';
  update mlbhist.import_runs
    set status = 'promoted', staged_counts = staged, promoted_counts = staged,
        promoted_at = now(), finished_at = now(), message = null
    where import_id = p_import_id;

  insert into mlbhist.meta (key, value) values
    ('last_import_id', p_import_id),
    ('last_import_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    ('coverage_start', cov_lo::text),
    ('coverage_end', cov_hi::text),
    ('rating_version', coalesce(run.rating_version, 'ED_PITCH_PERF_V1'))
  on conflict (key) do update set value = excluded.value;

  -- Staging is cleared for this import only. An older import's staged rows are
  -- someone else's evidence, not this run's litter.
  delete from mlbhist.stg_pitcher_seasons      where import_id = p_import_id;
  delete from mlbhist.stg_pitcher_team_seasons where import_id = p_import_id;
  delete from mlbhist.stg_pitcher_overview     where import_id = p_import_id;
  delete from mlbhist.stg_pitcher_team_history where import_id = p_import_id;
  delete from mlbhist.stg_observed_team_runs   where import_id = p_import_id;
  delete from mlbhist.stg_league_seasons       where import_id = p_import_id;
  delete from mlbhist.stg_teams                where import_id = p_import_id;
  delete from mlbhist.stg_validation           where import_id = p_import_id;
  delete from mlbhist.stg_source_repairs       where import_id = p_import_id;

  return jsonb_build_object('ok', true, 'import_id', p_import_id,
    'coverage', jsonb_build_object('start', cov_lo, 'end', cov_hi), 'rows', staged);
end $$;

revoke all on function mlbhist.promote_import(text) from public, anon, authenticated;
grant execute on function mlbhist.promote_import(text) to service_role;

-- Abandon a staged import without touching anything live. Used by the importer
-- when it decides, before promotion, that what it read is not fit to publish.
create or replace function mlbhist.abandon_import(p_import_id text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = mlbhist, public
as $$
begin
  delete from mlbhist.stg_pitcher_seasons      where import_id = p_import_id;
  delete from mlbhist.stg_pitcher_team_seasons where import_id = p_import_id;
  delete from mlbhist.stg_pitcher_overview     where import_id = p_import_id;
  delete from mlbhist.stg_pitcher_team_history where import_id = p_import_id;
  delete from mlbhist.stg_observed_team_runs   where import_id = p_import_id;
  delete from mlbhist.stg_league_seasons       where import_id = p_import_id;
  delete from mlbhist.stg_teams                where import_id = p_import_id;
  delete from mlbhist.stg_validation           where import_id = p_import_id;
  delete from mlbhist.stg_source_repairs       where import_id = p_import_id;
  update mlbhist.import_runs
    set status = 'failed', message = coalesce(p_reason, 'abandoned before promotion'), finished_at = now()
    where import_id = p_import_id and status <> 'promoted';
  return jsonb_build_object('ok', true, 'import_id', p_import_id, 'abandoned', true);
end $$;
revoke all on function mlbhist.abandon_import(text, text) from public, anon, authenticated;
grant execute on function mlbhist.abandon_import(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- What the shell shows about this pipeline. A view rather than a table so it
-- cannot drift from the ledger it describes.
-- ---------------------------------------------------------------------------
create or replace view mlbhist.dataset_status as
select r.import_id, r.status, r.coverage_start, r.coverage_end, r.provisional_seasons,
       r.rating_version, r.dataset_built_at, r.source, r.promoted_at,
       r.promoted_counts, r.validation, r.source_repairs, r.transformations,
       (select count(*) from mlbhist.pitcher_seasons)      as live_pitcher_seasons,
       (select count(*) from mlbhist.pitcher_team_seasons) as live_pitcher_team_seasons,
       (select count(*) from mlbhist.pitcher_overview)     as live_pitchers
from mlbhist.import_runs r
where r.status = 'promoted' and coalesce(r.dataset, 'pitching') = 'pitching'
order by r.promoted_at desc nulls last
limit 1;
