-- mlb_pitcher_history -- part 3 of 4.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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
  delete from mlbhist.pitcher_overview where true;
  delete from mlbhist.pitcher_team_history where true;
  delete from mlbhist.observed_team_runs where true;

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

-- ---------------------------------------------------------------------------
-- RLS. The record is public-read like every other EdgeDesk research table; the
-- write path is the service role and nothing else. Staging is NOT readable by
-- clients: an unpromoted dataset has not passed its gate, and a screen that
-- could read it could show numbers the gate was about to refuse.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['pitcher_seasons','pitcher_team_seasons','pitcher_overview',
                           'pitcher_team_history','observed_team_runs','league_seasons',
                           'teams','validation','source_repairs','import_runs','pipeline_runs'] loop
    execute format('alter table mlbhist.%I enable row level security', t);
    execute format('revoke all on mlbhist.%I from anon, authenticated', t);
    execute format('grant select on mlbhist.%I to anon, authenticated', t);
    execute format('grant all on mlbhist.%I to service_role', t);
    execute format('drop policy if exists %I on mlbhist.%I', 'mlbhist_' || t || '_public_read', t);
    execute format('create policy %I on mlbhist.%I for select to anon, authenticated using (true)',
                   'mlbhist_' || t || '_public_read', t);
  end loop;

  foreach t in array array['stg_pitcher_seasons','stg_pitcher_team_seasons','stg_pitcher_overview',
                           'stg_pitcher_team_history','stg_observed_team_runs','stg_league_seasons',
                           'stg_teams','stg_validation','stg_source_repairs'] loop
    execute format('alter table mlbhist.%I enable row level security', t);
    execute format('revoke all on mlbhist.%I from anon, authenticated', t);
    execute format('grant all on mlbhist.%I to service_role', t);
  end loop;
end $$;

grant select on mlbhist.dataset_status to anon, authenticated, service_role;
grant usage, select on all sequences in schema mlbhist to service_role;
