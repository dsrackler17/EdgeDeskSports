-- college_baseball -- part 3 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

/* ── the club's batting and pitching season, folded over the same rows ─────
   Deliberately a separate table from cbb.team_seasons, which folds the GAME
   LOG. That one knows every game a club played. This one knows only the games
   whose box score carried player lines, and those two sets are not the same.
   Merging them into one row would let a club's record silently start
   disagreeing with its own hitting line, with nothing to point at. The
   coverage columns below exist so a reader can see the gap instead of
   inheriting it. */
create table if not exists cbb.team_stat_seasons (
  season             int  not null,
  team_id            text not null,
  team_name          text not null,

  games_with_lines   int not null default 0,   -- games whose box score had players
  games_played       int not null default 0,   -- from cbb.team_seasons, for comparison
  /* games_with_lines / games_played. A club at 1.0 has a complete hitting
     line; a club at 0.4 does not, and its rates are a sample rather than a
     season. The brief shows this number rather than hiding behind it. */
  line_coverage      double precision,

  ab                 int not null default 0,
  runs               int not null default 0,
  hits               int not null default 0,
  rbi                int not null default 0,
  hr                 int not null default 0,
  bb                 int not null default 0,
  so                 int not null default 0,
  stolen_bases       int not null default 0,
  batting_avg        double precision,

  outs               int not null default 0,
  p_hits             int not null default 0,
  earned_runs        int not null default 0,
  p_bb               int not null default 0,
  p_so               int not null default 0,
  p_hr               int not null default 0,
  era                double precision,
  whip               double precision,

  batters_used       int not null default 0,
  pitchers_used      int not null default 0,
  first_game         date,
  last_game          date,
  updated_at         timestamptz not null default now(),
  primary key (season, team_id)
);
create index if not exists cbb_tss_season_idx on cbb.team_stat_seasons (season);

/* ── staging for the stats import ───────────────────────────────────────── */
create table if not exists cbb.stg_player_games (like cbb.player_games including defaults);
alter table cbb.stg_player_games add column if not exists import_id text;
create index if not exists cbb_stg_pg_import_idx on cbb.stg_player_games (import_id);

/* ═══════════════════════════════════════════════════════════════════════════
   THE STATS PROMOTE GATE

   Same contract as the games promote: it either takes the whole import or it
   refuses and leaves the previous one untouched. Each refusal is named,
   because "the stats import failed" is not an operational message.

   p_season is THE SEASON THE IMPORT MEANT TO COVER, not the one it happened
   to return — the same distinction the games promote needed. An import
   throttled down to a handful of games has a narrow span, and judging it
   against the live table over its own span compares a handful with a handful
   and always passes, which is exactly the failure the shrink refusal exists
   to catch.
   ═══════════════════════════════════════════════════════════════════════════ */
create or replace function cbb.promote_cbb_stats(
  p_import_id    text,
  p_allow_shrink boolean default false,
  p_season       int     default null
) returns jsonb
language plpgsql
as $$
declare
  v_refusals  jsonb := '[]'::jsonb;
  v_staged    bigint;
  v_live      bigint;
  v_dupes     bigint;
  v_orphans   bigint;
  v_badhits   bigint;
  v_badseason bigint;
  v_season    int := p_season;
  v_players   bigint;
  v_teams     bigint;
begin
  select count(*) into v_staged from cbb.stg_player_games where import_id = p_import_id;

  /* EMPTY_IMPORT — the source answers 200 with an empty slate when hurried,
     and an empty import must never be allowed to erase a real one. */
  if v_staged = 0 then
    v_refusals := v_refusals || jsonb_build_object(
      'refusal','EMPTY_IMPORT',
      'detail','no staged player lines for this import id');
  end if;

  /* DUPLICATE_LINES — one player, one game, one role. A duplicate means the
     same box score was read twice, and folding it would double a season. */
  select count(*) into v_dupes from (
    select game_id, athlete_id, line_type
      from cbb.stg_player_games where import_id = p_import_id
     group by 1,2,3 having count(*) > 1) d;
  if v_dupes > 0 then
    v_refusals := v_refusals || jsonb_build_object(
      'refusal','DUPLICATE_LINES',
      'detail', v_dupes || ' (game, athlete, role) combinations appear more than once');
  end if;

  /* ORPHAN_GAME — a line for a game the log has never heard of. Either the
     game log is stale or the ids do not match; both mean the fold would
     attribute numbers to a game nobody can look up. */
  select count(*) into v_orphans
    from cbb.stg_player_games s
   where s.import_id = p_import_id
     and not exists (select 1 from cbb.games g where g.game_id = s.game_id);
  if v_orphans > 0 then
    v_refusals := v_refusals || jsonb_build_object(
      'refusal','ORPHAN_GAME',
      'detail', v_orphans || ' lines reference a game that is not in cbb.games');
  end if;

  /* HITS_EXCEED_AB — the labelled-array failure mode. A box score arrives as
     a bare list of numbers whose meaning comes from a parallel list of
     labels, so an off-by-one in the column mapping produces numbers that are
     individually plausible and collectively impossible. A hitter with more
     hits than at-bats is the cheapest way to catch that, and it is checked
     here as well as in the table constraint because a refusal that names the
     problem is worth more than a constraint violation that does not. */
  select count(*) into v_badhits
    from cbb.stg_player_games
   where import_id = p_import_id and line_type = 'batting'
     and ab is not null and hits is not null and hits > ab;
  if v_badhits > 0 then
    v_refusals := v_refusals || jsonb_build_object(
      'refusal','HITS_EXCEED_AB',
      'detail', v_badhits || ' batting lines have more hits than at-bats — the '
        || 'column mapping is off, not the source');
  end if;

  /* SEASON_MISMATCH — a line whose season does not match the year of its own
     date. College baseball runs February to June, so season and calendar year
     are the same thing, and a disagreement means one of the two was invented. */
  select count(*) into v_badseason
    from cbb.stg_player_games
   where import_id = p_import_id
     and season <> extract(year from game_date)::int;
  if v_badseason > 0 then
    v_refusals := v_refusals || jsonb_build_object(
      'refusal','SEASON_MISMATCH',
      'detail', v_badseason || ' lines carry a season that is not the year of their date');
  end if;

  /* IMPORT_SHRANK — judged against the season the import MEANT to cover. */
  if v_season is not null then
    select count(*) into v_live from cbb.player_games where season = v_season;
    if v_live > 0 and v_staged < v_live * 0.9 and not p_allow_shrink then
      v_refusals := v_refusals || jsonb_build_object(
        'refusal','IMPORT_SHRANK',
        'detail','staged ' || v_staged || ' lines for season ' || v_season
          || ' against ' || v_live || ' live; pass p_allow_shrink to override');
    end if;
  end if;

  if jsonb_array_length(v_refusals) > 0 then
    update cbb.import_runs
       set status='failed', failed_at=now(), refusals=v_refusals, updated_at=now(),
           failure_reason = (v_refusals->0->>'refusal')
     where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'refusals', v_refusals);
  end if;

  /* One transaction. A reader never lands on a half-imported season. */
  if v_season is not null then
    delete from cbb.player_games where season = v_season;
  else
    delete from cbb.player_games;
  end if;

  insert into cbb.player_games (
    game_id, athlete_id, line_type, season, game_date, team_id, team_name,
    opponent_team_id, athlete_name, position, jersey, starter,
    ab, runs, hits, rbi, hr, bb, so, pitches_seen, stolen_bases,
    outs, p_hits, p_runs, earned_runs, p_bb, p_so, p_hr, pitch_count, strikes,
    season_avg_at_game, season_obp_at_game, season_slg_at_game, season_era_at_game,
    source, updated_at)
  select
    game_id, athlete_id, line_type, season, game_date, team_id, team_name,
    opponent_team_id, athlete_name, position, jersey, starter,
    ab, runs, hits, rbi, hr, bb, so, pitches_seen, stolen_bases,
    outs, p_hits, p_runs, earned_runs, p_bb, p_so, p_hr, pitch_count, strikes,
    season_avg_at_game, season_obp_at_game, season_slg_at_game, season_era_at_game,
    source, now()
    from cbb.stg_player_games where import_id = p_import_id;

  perform cbb.rebuild_player_seasons(v_season);

  select count(*) into v_players from cbb.player_seasons
   where v_season is null or season = v_season;
  select count(*) into v_teams from cbb.team_stat_seasons
   where v_season is null or season = v_season;

  update cbb.import_runs
     set status='promoted', promoted_at=now(), refusals='[]'::jsonb, updated_at=now(),
         row_counts = jsonb_build_object(
           'player_games', v_staged, 'player_seasons', v_players,
           'team_stat_seasons', v_teams)
   where import_id = p_import_id;

  update cbb.import_runs
     set status='superseded', updated_at=now()
   where dataset='stats' and status='promoted' and import_id <> p_import_id;

  delete from cbb.stg_player_games where import_id = p_import_id;

  return jsonb_build_object('ok', true, 'player_games', v_staged,
    'player_seasons', v_players, 'team_stat_seasons', v_teams);
end;
$$;
