-- college_baseball -- part 4 of 7.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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
    delete from cbb.player_games where true;
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

/* ═══════════════════════════════════════════════════════════════════════════
   THE FOLD

   Both season tables are sums over cbb.player_games and nothing else. Nothing
   in here is fetched, and nothing in here touches the season-to-date rate
   columns except to carry the last one, which is the only place an honest OBP
   or SLG can come from.
   ═══════════════════════════════════════════════════════════════════════════ */
create or replace function cbb.rebuild_player_seasons(p_season int default null)
returns void
language plpgsql
as $$
begin
  if p_season is null then
    delete from cbb.player_seasons where true;
    delete from cbb.team_stat_seasons where true;
  else
    delete from cbb.player_seasons    where season = p_season;
    delete from cbb.team_stat_seasons where season = p_season;
  end if;

  /* ── players ──
     A player's identity for a season is his last club, not his first: a
     transfer's line belongs where he finished. */
  with bat as (
    select season, athlete_id,
           count(*)                     as games_batting,
           sum(coalesce(ab,0))          as ab,
           sum(coalesce(runs,0))        as runs,
           sum(coalesce(hits,0))        as hits,
           sum(coalesce(rbi,0))         as rbi,
           sum(coalesce(hr,0))          as hr,
           sum(coalesce(bb,0))          as bb,
           sum(coalesce(so,0))          as so,
           sum(coalesce(pitches_seen,0)) as pitches_seen,
           sum(coalesce(stolen_bases,0)) as stolen_bases
      from cbb.player_games
     where line_type='batting' and (p_season is null or season=p_season)
     group by 1,2
  ), pit as (
    select season, athlete_id,
           count(*)                     as games_pitching,
           sum(coalesce(outs,0))        as outs,
           sum(coalesce(p_hits,0))      as p_hits,
           sum(coalesce(p_runs,0))      as p_runs,
           sum(coalesce(earned_runs,0)) as earned_runs,
           sum(coalesce(p_bb,0))        as p_bb,
           sum(coalesce(p_so,0))        as p_so,
           sum(coalesce(p_hr,0))        as p_hr,
           sum(coalesce(pitch_count,0)) as pitch_count,
           sum(coalesce(strikes,0))     as strikes
      from cbb.player_games
     where line_type='pitching' and (p_season is null or season=p_season)
     group by 1,2
  ), ident as (
    /* one row per player-season: the last line he appears in */
    select distinct on (season, athlete_id)
           season, athlete_id, athlete_name, team_id, team_name, position,
           game_date as last_game
      from cbb.player_games
     where p_season is null or season=p_season
     order by season, athlete_id, game_date desc, line_type
  ), firsts as (
    select season, athlete_id, min(game_date) as first_game
      from cbb.player_games
     where p_season is null or season=p_season
     group by 1,2
  ), rates as (
    /* the source's own season figures, taken from the LAST game that reported
       them. This is the only OBP and SLG that exists here. */
    select distinct on (season, athlete_id)
           season, athlete_id, season_obp_at_game, season_slg_at_game, game_date
      from cbb.player_games
     where line_type='batting' and season_obp_at_game is not null
       and (p_season is null or season=p_season)
     order by season, athlete_id, game_date desc
  ), erarep as (
    select distinct on (season, athlete_id)
           season, athlete_id, season_era_at_game
      from cbb.player_games
     where line_type='pitching' and season_era_at_game is not null
       and (p_season is null or season=p_season)
     order by season, athlete_id, game_date desc
  )
  insert into cbb.player_seasons (
    season, athlete_id, athlete_name, team_id, team_name, position,
    games_batting, ab, runs, hits, rbi, hr, bb, so, pitches_seen, stolen_bases,
    batting_avg, obp_reported, slg_reported, rates_as_of,
    games_pitching, outs, p_hits, p_runs, earned_runs, p_bb, p_so, p_hr,
    pitch_count, strikes, era, whip, k_per_9, bb_per_9, era_reported,
    first_game, last_game, updated_at)
  select i.season, i.athlete_id, i.athlete_name, i.team_id, i.team_name, i.position,
    coalesce(b.games_batting,0), coalesce(b.ab,0), coalesce(b.runs,0),
    coalesce(b.hits,0), coalesce(b.rbi,0), coalesce(b.hr,0), coalesce(b.bb,0),
    coalesce(b.so,0), coalesce(b.pitches_seen,0), coalesce(b.stolen_bases,0),
    /* a hitter with no at-bats has no average; he does not have .000 */
    case when coalesce(b.ab,0) > 0 then b.hits::double precision / b.ab end,
    r.season_obp_at_game, r.season_slg_at_game, r.game_date,
    coalesce(p.games_pitching,0), coalesce(p.outs,0), coalesce(p.p_hits,0),
    coalesce(p.p_runs,0), coalesce(p.earned_runs,0), coalesce(p.p_bb,0),
    coalesce(p.p_so,0), coalesce(p.p_hr,0), coalesce(p.pitch_count,0),
    coalesce(p.strikes,0),
    /* ERA, WHIP and the per-nine rates all divide by innings, and innings is
       outs/3. With no outs recorded these are a division by zero, which is a
       null rather than an infinity dressed up as a statistic. */
    case when coalesce(p.outs,0) > 0
         then p.earned_runs * 27.0 / p.outs end,
    case when coalesce(p.outs,0) > 0
         then (p.p_hits + p.p_bb) * 3.0 / p.outs end,
    case when coalesce(p.outs,0) > 0
         then p.p_so * 27.0 / p.outs end,
    case when coalesce(p.outs,0) > 0
         then p.p_bb * 27.0 / p.outs end,
    e.season_era_at_game,
    f.first_game, i.last_game, now()
    from ident i
    left join bat    b on b.season=i.season and b.athlete_id=i.athlete_id
    left join pit    p on p.season=i.season and p.athlete_id=i.athlete_id
    left join firsts f on f.season=i.season and f.athlete_id=i.athlete_id
    left join rates  r on r.season=i.season and r.athlete_id=i.athlete_id
    left join erarep e on e.season=i.season and e.athlete_id=i.athlete_id;

  /* ── clubs ──
     games_with_lines counts distinct games this club has ANY line for, which
     is not the number of games it played. games_played comes from
     cbb.team_seasons, which folds the game log, and the ratio of the two is
     the coverage figure the brief shows instead of hiding. */
  with tb as (
    select season, team_id, max(team_name) as team_name,
           count(distinct game_id)       as games_with_lines,
           count(distinct athlete_id)    as batters_used,
           sum(coalesce(ab,0))           as ab,
           sum(coalesce(runs,0))         as runs,
           sum(coalesce(hits,0))         as hits,
           sum(coalesce(rbi,0))          as rbi,
           sum(coalesce(hr,0))           as hr,
           sum(coalesce(bb,0))           as bb,
           sum(coalesce(so,0))           as so,
           sum(coalesce(stolen_bases,0)) as stolen_bases,
           min(game_date) as first_game, max(game_date) as last_game
      from cbb.player_games
     where line_type='batting' and team_id is not null
       and (p_season is null or season=p_season)
     group by 1,2
  ), tp as (
    select season, team_id,
           count(distinct athlete_id)   as pitchers_used,
           sum(coalesce(outs,0))        as outs,
           sum(coalesce(p_hits,0))      as p_hits,
           sum(coalesce(earned_runs,0)) as earned_runs,
           sum(coalesce(p_bb,0))        as p_bb,
           sum(coalesce(p_so,0))        as p_so,
           sum(coalesce(p_hr,0))        as p_hr,
           count(distinct game_id)      as pgames
      from cbb.player_games
     where line_type='pitching' and team_id is not null
       and (p_season is null or season=p_season)
     group by 1,2
  ), allteams as (
    select coalesce(tb.season, tp.season) as season,
           coalesce(tb.team_id, tp.team_id) as team_id
      from tb full outer join tp on tb.season=tp.season and tb.team_id=tp.team_id
  ), gamecount as (
    /* THE UNION OF THE TWO SETS, NOT THE LARGER OF THEM. A club that batted in
       games 1 and 2 and pitched in games 1 and 3 has lines in THREE games; the
       greater of the two counts says two. Counting distinct game ids across
       both line types is the only thing that gets this right, and it matters
       because this figure is the denominator of the coverage a reader is shown. */
    select season, team_id, count(distinct game_id) as games_with_lines
      from cbb.player_games
     where team_id is not null and (p_season is null or season=p_season)
     group by 1,2
  )
  insert into cbb.team_stat_seasons (
    season, team_id, team_name, games_with_lines, games_played, line_coverage,
    ab, runs, hits, rbi, hr, bb, so, stolen_bases, batting_avg,
    outs, p_hits, earned_runs, p_bb, p_so, p_hr, era, whip,
    batters_used, pitchers_used, first_game, last_game, updated_at)
  select a.season, a.team_id,
    coalesce(tb.team_name, ts.team_name, a.team_id),
    coalesce(gc.games_with_lines, 0),
    coalesce(ts.games, 0),
    case when coalesce(ts.games,0) > 0
         then coalesce(gc.games_with_lines,0)::double precision / ts.games end,
    coalesce(tb.ab,0), coalesce(tb.runs,0), coalesce(tb.hits,0), coalesce(tb.rbi,0),
    coalesce(tb.hr,0), coalesce(tb.bb,0), coalesce(tb.so,0), coalesce(tb.stolen_bases,0),
    case when coalesce(tb.ab,0) > 0 then tb.hits::double precision / tb.ab end,
    coalesce(tp.outs,0), coalesce(tp.p_hits,0), coalesce(tp.earned_runs,0),
    coalesce(tp.p_bb,0), coalesce(tp.p_so,0), coalesce(tp.p_hr,0),
    case when coalesce(tp.outs,0) > 0 then tp.earned_runs * 27.0 / tp.outs end,
    case when coalesce(tp.outs,0) > 0 then (tp.p_hits + tp.p_bb) * 3.0 / tp.outs end,
    coalesce(tb.batters_used,0), coalesce(tp.pitchers_used,0),
    tb.first_game, tb.last_game, now()
    from allteams a
    left join tb on tb.season=a.season and tb.team_id=a.team_id
    left join tp on tp.season=a.season and tp.team_id=a.team_id
    left join gamecount gc on gc.season=a.season and gc.team_id=a.team_id
    left join cbb.team_seasons ts on ts.season=a.season and ts.team_id=a.team_id;
end;
$$;
