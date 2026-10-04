/* ===========================================================================
   THE PROMOTE GATES, RE-CREATED WITH EVERY DELETE QUALIFIED.

   WHY. Supabase loads the safeupdate guard for the roles PostgREST connects
   as, and it refuses a DELETE with no WHERE clause. Every promote in these
   schemas clears its live table before writing the new one, and every one of
   those clears was written bare:

       delete from mlbhist.pitcher_overview;

   Through psql that is a full-table delete and does exactly what it says.
   Called as service_role through PostgREST it is refused outright:

       RPC mlbhist.promote_import -> 400: {"code":"21000",
         "message":"DELETE requires a WHERE clause"}

   which is where the MLB import died after building all ten seasons.

   MY LOCAL VERIFICATION COULD NOT HAVE CAUGHT THIS. A stock PostgreSQL does
   not load safeupdate, so all fifteen of these ran clean against a throwaway
   database and clean through psql, and only failed on the one path that
   matters: the API. Applying a contract locally is not the same as exercising
   it the way production calls it.

   WHAT CHANGED. Fifteen deletes across three files gained "where true". That
   is semantically identical — it still clears the table — and it satisfies the
   guard, which only requires that a WHERE be present.

   Nothing else in these functions changed. They are re-created here in full
   because a function body cannot be patched in place; "create or replace"
   swaps each one atomically, so a reader mid-query is never served a half
   function. Safe to run more than once.
   =========================================================================== */


/* ---- the cbb gates and rebuilds ---- */

create or replace function cbb.promote_cbb_import(
  p_import_id text,
  p_allow_shrink boolean default false,
  /* THE WINDOW THE IMPORT MEANT TO COVER, not the span it happened to return.
     Those are the same thing only when the import worked. An import throttled
     down to a single day has a one-day span, so comparing it against the live
     table over ITS OWN span compares one day with one day and always passes —
     which is precisely the failure this refusal exists to catch. The importer
     knows the window it asked for, so it says so. */
  p_from date default null,
  p_through date default null
) returns jsonb
language plpgsql
security definer
set search_path = cbb, public
as $$
declare
  staged_games   int;
  staged_teams   int;
  dupes          int;
  season_breaks  int;
  score_breaks   int;
  nameless       int;
  live_span      int;
  staged_span    int;
  span_lo        date;
  span_hi        date;
  v_refusals     jsonb := '[]'::jsonb;
  counts         jsonb;
begin
  select count(*) into staged_games from cbb.stg_games where import_id = p_import_id;
  select count(*) into staged_teams from cbb.stg_teams where import_id = p_import_id;

  if staged_games = 0 then
    v_refusals := v_refusals || jsonb_build_object('code','EMPTY_IMPORT',
      'detail','No staged games. An empty answer from the source is not an empty season, and it is never promoted.');
  end if;

  /* one row per game, or the union did not actually union */
  select count(*) into dupes from (
    select game_id from cbb.stg_games where import_id = p_import_id
     group by game_id having count(*) > 1) d;
  if dupes > 0 then
    v_refusals := v_refusals || jsonb_build_object('code','DUPLICATE_GAME_IDS',
      'detail', dupes || ' game id(s) staged more than once. The team walk is a union keyed on game id; '
        || 'duplicates mean it stopped being one.');
  end if;

  /* a game's season has to be the season its date falls in. College baseball
     runs February to June, so the season is simply the calendar year — a row
     claiming otherwise would put games in the wrong archive silently. */
  select count(*) into season_breaks
    from cbb.stg_games
   where import_id = p_import_id
     and season <> extract(year from game_date)::int;
  if season_breaks > 0 then
    v_refusals := v_refusals || jsonb_build_object('code','SEASON_DATE_MISMATCH',
      'detail', season_breaks || ' game(s) carry a season that is not the year of their own date.');
  end if;

  /* A finished game with no score is a contradiction, and it is the shape a
     half-written row takes. Postponed and cancelled games are finished
     without a score legitimately, so they are excluded by name. */
  select count(*) into score_breaks
    from cbb.stg_games
   where import_id = p_import_id
     and completed
     and (away_score is null or home_score is null)
     and coalesce(status_detail,'') !~* 'postpon|cancel|suspend|forfeit';
  if score_breaks > 0 then
    v_refusals := v_refusals || jsonb_build_object('code','COMPLETED_WITHOUT_SCORE',
      'detail', score_breaks || ' game(s) are marked complete with a missing score and are not postponed, '
        || 'cancelled, suspended or forfeited.');
  end if;

  select count(*) into nameless
    from cbb.stg_games
   where import_id = p_import_id
     and (coalesce(away_name,'') = '' or coalesce(home_name,'') = '');
  if nameless > 0 then
    v_refusals := v_refusals || jsonb_build_object('code','UNNAMED_SIDE',
      'detail', nameless || ' game(s) are missing a side. A board row that cannot say who is playing is not a row.');
  end if;

  /* ── THE SHRINKAGE REFUSAL ──────────────────────────────────────────────
     Measured, not imagined: the source answers 200 with an empty slate when
     asked too quickly. Writing that would delete a day's card and leave a
     screen that reads like a quiet Tuesday rather than a broken job. So an
     import that covers the same span with materially fewer games has to say
     so out loud. Ten per cent is the tolerance — schedules do lose games to
     weather, and a handful of cancellations is not a broken import. */
  select coalesce(p_from, min(game_date)), coalesce(p_through, max(game_date))
    into span_lo, span_hi
    from cbb.stg_games where import_id = p_import_id;
  if span_lo is not null then
    select count(*) into live_span   from cbb.games where game_date between span_lo and span_hi;
    select count(*) into staged_span from cbb.stg_games
      where import_id = p_import_id and game_date between span_lo and span_hi;
    if live_span > 0 and staged_span < (live_span * 0.9) and not p_allow_shrink then
      v_refusals := v_refusals || jsonb_build_object('code','IMPORT_SHRANK',
        'detail','This import carries ' || staged_span || ' games for ' || span_lo || '..' || span_hi
          || ' where the live table already holds ' || live_span
          || '. The source returns an empty or partial slate when it is asked too fast, and promoting that '
          || 'would delete games a reader can currently see. Re-run the walk; if the loss is real, '
          || 'promote again with p_allow_shrink => true.');
    end if;
  end if;

  if jsonb_array_length(v_refusals) > 0 then
    update cbb.import_runs
       set status = 'failed', failed_at = now(), refusals = v_refusals, updated_at = now(),
           failure_reason = (v_refusals -> 0 ->> 'code')
     where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'refusals', v_refusals);
  end if;

  /* ── the promote itself: one transaction, live tables replaced wholesale ── */
  /* The columns are named rather than splatted. Staging carries an import_id
     that the live table does not, so a (row).* here would be one column too
     wide — and a schema change later would break it silently rather than
     loudly. */
  delete from cbb.games where true;
  insert into cbb.games (
    game_id, season, game_date, start_time, start_time_tbd,
    away_team_id, home_team_id, away_name, home_name, away_abbr, home_abbr,
    venue, venue_city, venue_state, neutral_site, conference_game,
    status_state, status_detail, completed, away_score, home_score, innings,
    away_rank, home_rank, notes, seen_by, first_seen_at, last_seen_at)
  select game_id, season, game_date, start_time, start_time_tbd,
         away_team_id, home_team_id, away_name, home_name, away_abbr, home_abbr,
         venue, venue_city, venue_state, neutral_site, conference_game,
         status_state, status_detail, completed, away_score, home_score, innings,
         away_rank, home_rank, notes, seen_by,
         coalesce(first_seen_at, now()), now()
    from cbb.stg_games where import_id = p_import_id;

  if staged_teams > 0 then
    delete from cbb.teams where true;
    insert into cbb.teams (
      team_id, name, short_name, abbreviation, slug,
      conference_id, conference_name, logo, color,
      first_seen_season, last_seen_season, updated_at)
    select team_id, name, short_name, abbreviation, slug,
           conference_id, conference_name, logo, color,
           first_seen_season, last_seen_season, now()
      from cbb.stg_teams where import_id = p_import_id;
  end if;

  perform cbb.rebuild_team_seasons();

  select jsonb_build_object(
      'games',        (select count(*) from cbb.games),
      'teams',        (select count(*) from cbb.teams),
      'team_seasons', (select count(*) from cbb.team_seasons))
    into counts;

  update cbb.import_runs
     set status = 'superseded', updated_at = now()
   where status = 'promoted' and coalesce(dataset,'games') = 'games' and import_id <> p_import_id;

  update cbb.import_runs
     set status = 'promoted', promoted_at = now(), row_counts = counts,
         refusals = '[]'::jsonb, updated_at = now()
   where import_id = p_import_id;

  delete from cbb.stg_games where import_id = p_import_id;
  delete from cbb.stg_teams where import_id = p_import_id;

  return jsonb_build_object('ok', true, 'rows', counts);
end $$;

/* ═══════════════════════════════════════════════════════════════════════════
   THE DERIVATION

   Every figure in cbb.team_seasons is a fold over cbb.games. Nothing here is
   fetched, so a club's record cannot disagree with the games listed beneath
   it. Only completed games with both scores count toward a record; scheduled
   and abandoned games are counted separately rather than silently dropped, so
   a reader can see that the difference exists.
   ═══════════════════════════════════════════════════════════════════════════ */
create or replace function cbb.rebuild_team_seasons()
returns void
language plpgsql
security definer
set search_path = cbb, public
as $$
begin
  delete from cbb.team_seasons where true;

  /* one row per team per game, from both sides of the fixture */
  with sides as (
    select season, game_date, home_team_id as team_id, home_name as team_name,
           home_score as rs, away_score as ra, completed, neutral_site, conference_game,
           'home'::text as venue_side
      from cbb.games where home_team_id is not null
    union all
    select season, game_date, away_team_id, away_name,
           away_score, home_score, completed, neutral_site, conference_game,
           'away'
      from cbb.games where away_team_id is not null
  ),
  played as (
    select *, (rs > ra) as won, (rs < ra) as lost, (rs = ra) as tied
      from sides where completed and rs is not null and ra is not null
  ),
  ranked as (
    select *, row_number() over (partition by season, team_id order by game_date desc) as recency
      from played
  ),
  /* the streak is the run of like results ending at the most recent game */
  streaks as (
    select season, team_id,
           sum(case when won then 1 when lost then -1 else 0 end) filter (
             where recency <= (
               select coalesce(min(r2.recency), 1e9)
                 from ranked r2
                where r2.season = r.season and r2.team_id = r.team_id
                  and r2.won is distinct from (select r3.won from ranked r3
                        where r3.season = r.season and r3.team_id = r.team_id and r3.recency = 1)
             ) - 1
           ) as streak
      from ranked r group by season, team_id
  ),
  agg as (
    select p.season, p.team_id,
           max(p.team_name) as team_name,
           count(*) as games,
           count(*) filter (where p.won)  as wins,
           count(*) filter (where p.lost) as losses,
           count(*) filter (where p.tied) as ties,
           sum(p.rs) as runs_for, sum(p.ra) as runs_against,
           count(*) filter (where p.won  and p.venue_side='home' and not p.neutral_site) as home_wins,
           count(*) filter (where p.lost and p.venue_side='home' and not p.neutral_site) as home_losses,
           count(*) filter (where p.won  and p.venue_side='away' and not p.neutral_site) as away_wins,
           count(*) filter (where p.lost and p.venue_side='away' and not p.neutral_site) as away_losses,
           count(*) filter (where p.won  and p.neutral_site) as neutral_wins,
           count(*) filter (where p.lost and p.neutral_site) as neutral_losses,
           count(*) filter (where p.won  and p.conference_game) as conf_wins,
           count(*) filter (where p.lost and p.conference_game) as conf_losses,
           min(p.game_date) as first_game, max(p.game_date) as last_game
      from played p group by p.season, p.team_id
  ),
  last10 as (
    select season, team_id,
           count(*) filter (where won)  as last10_wins,
           count(*) filter (where lost) as last10_losses
      from ranked where recency <= 10 group by season, team_id
  ),
  scheduled as (
    select season, team_id, count(*) as scheduled_games
      from sides where not completed or rs is null or ra is null
     group by season, team_id
  )
  insert into cbb.team_seasons (
    season, team_id, team_name, games, wins, losses, ties, runs_for, runs_against,
    home_wins, home_losses, away_wins, away_losses, neutral_wins, neutral_losses,
    conf_wins, conf_losses, last10_wins, last10_losses, streak,
    runs_per_game, runs_allowed_per_game, run_diff_per_game, pythag_win_pct,
    scheduled_games, first_game, last_game, updated_at)
  select a.season, a.team_id, a.team_name, a.games, a.wins, a.losses, a.ties,
         a.runs_for, a.runs_against,
         a.home_wins, a.home_losses, a.away_wins, a.away_losses,
         a.neutral_wins, a.neutral_losses, a.conf_wins, a.conf_losses,
         coalesce(l.last10_wins,0), coalesce(l.last10_losses,0),
         coalesce(s.streak,0),
         case when a.games > 0 then a.runs_for::double precision / a.games end,
         case when a.games > 0 then a.runs_against::double precision / a.games end,
         case when a.games > 0 then (a.runs_for - a.runs_against)::double precision / a.games end,
         /* Pythagorean expectation, exponent 1.83 — the figure baseball
            research settles on. Descriptive only: it states what the runs
            imply, never what will happen, and nothing converts it to a price. */
         case when (a.runs_for + a.runs_against) > 0
              then power(a.runs_for, 1.83) / (power(a.runs_for, 1.83) + power(a.runs_against, 1.83))
         end,
         coalesce(sc.scheduled_games,0), a.first_game, a.last_game, now()
    from agg a
    left join last10 l    on l.season = a.season and l.team_id = a.team_id
    left join streaks s   on s.season = a.season and s.team_id = a.team_id
    left join scheduled sc on sc.season = a.season and sc.team_id = a.team_id;
end $$;

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

/* ═══════════════════════════════════════════════════════════════════════════
   THE GATE
   ═══════════════════════════════════════════════════════════════════════════ */
create or replace function cbb.promote_ncaa_seasons(
  p_import_id    text,
  p_allow_shrink boolean default false,
  p_season       int     default null
) returns jsonb
language plpgsql
as $$
declare
  v_refusals jsonb := '[]'::jsonb;
  v_staged   bigint;
  v_live     bigint;
  v_dupes    bigint;
  v_badhits  bigint;
  v_badab    bigint;
  v_badseason bigint;
  v_rows     bigint;
begin
  select count(*) into v_staged from cbb.stg_ncaa_player_seasons where import_id = p_import_id;
  if v_staged = 0 then
    v_refusals := v_refusals || jsonb_build_object('refusal','EMPTY_IMPORT',
      'detail','no staged rows for this import id');
  end if;

  select count(*) into v_dupes from (
    select season, player_id from cbb.stg_ncaa_player_seasons
     where import_id = p_import_id group by 1,2 having count(*) > 1) d;
  if v_dupes > 0 then
    v_refusals := v_refusals || jsonb_build_object('refusal','DUPLICATE_PLAYER_SEASON',
      'detail', v_dupes || ' (season, player) pairs appear more than once; the two '
        || 'source files were merged wrongly');
  end if;

  select count(*) into v_badhits from cbb.stg_ncaa_player_seasons
   where import_id = p_import_id and ab is not null and h is not null and h > ab;
  if v_badhits > 0 then
    v_refusals := v_refusals || jsonb_build_object('refusal','HITS_EXCEED_AB',
      'detail', v_badhits || ' rows have more hits than at-bats');
  end if;

  /* IMPOSSIBLE_AB — see the Roberto Pena note in the header. A season total
     above 400 at-bats is not a college season; it is an aggregate or a parse
     fault, and importing it would put a .236 hitter on a leaderboard with
     half again the plate appearances anyone else had. */
  select count(*) into v_badab from cbb.stg_ncaa_player_seasons
   where import_id = p_import_id and ab is not null and ab > 400;
  if v_badab > 0 then
    v_refusals := v_refusals || jsonb_build_object('refusal','IMPOSSIBLE_AB',
      'detail', v_badab || ' rows carry more than 400 at-bats in one season; the '
        || 'highest real total in this source is 296');
  end if;

  select count(*) into v_badseason from cbb.stg_ncaa_player_seasons
   where import_id = p_import_id and (season < 2002 or season > 2100);
  if v_badseason > 0 then
    v_refusals := v_refusals || jsonb_build_object('refusal','SEASON_OUT_OF_RANGE',
      'detail', v_badseason || ' rows carry a season outside 2002..2100');
  end if;

  if p_season is not null then
    select count(*) into v_live from cbb.ncaa_player_seasons where season = p_season;
    if v_live > 0 and v_staged < v_live * 0.9 and not p_allow_shrink then
      v_refusals := v_refusals || jsonb_build_object('refusal','IMPORT_SHRANK',
        'detail','staged ' || v_staged || ' rows for season ' || p_season
          || ' against ' || v_live || ' live');
    end if;
  end if;

  if jsonb_array_length(v_refusals) > 0 then
    update cbb.import_runs set status='failed', failed_at=now(), refusals=v_refusals,
           updated_at=now(), failure_reason=(v_refusals->0->>'refusal')
     where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'refusals', v_refusals);
  end if;

  if p_season is not null then
    delete from cbb.ncaa_player_seasons where season = p_season;
  else
    delete from cbb.ncaa_player_seasons where true;
  end if;

  insert into cbb.ncaa_player_seasons (
    season, player_id, person_id, name, team_code, team_name, division, class_year,
    identity_resolved,
    bats, b_games, pa, ab, h, doubles, triples, hr, r, rbi, bb, so, hbp, sf, sh,
    gdp, sb, cs, qualified_batting,
    total_bases, batting_avg, obp, slg, ops, iso,
    pitches, p_games, gs, w, l, cg, sho, sv, outs, tbf, p_h, p_r, er, p_hr,
    p_bb, p_hbp, wp, bk, p_so, qualified_pitching,
    era, whip, k_per_9, bb_per_9, k_pct,
    source, source_sha256, updated_at)
  select
    s.season, s.player_id, s.person_id, s.name, s.team_code, s.team_name,
    s.division, s.class_year,
    /* CARRIED EXPLICITLY. This column was added to the table and left out of
       this list, so every row took the default and claimed its identity was
       resolved — including the 269 whose whole purpose is to say otherwise. A
       flag that cannot say "no" is worse than no flag. */
    s.identity_resolved,
    s.bats, s.b_games, s.pa, s.ab, s.h, s.doubles, s.triples, s.hr, s.r, s.rbi,
    s.bb, s.so, s.hbp, s.sf, s.sh, s.gdp, s.sb, s.cs, s.qualified_batting,

    /* ── the derived batting figures, in ONE place ──────────────────────────
       Total bases counts each hit once for the base it reached: singles are
       H - 2B - 3B - HR, so TB = H + 2B + 2*3B + 3*HR. Writing it that way means
       a missing doubles column understates rather than silently double-counts. */
    case when s.h is not null then
      s.h + coalesce(s.doubles,0) + 2*coalesce(s.triples,0) + 3*coalesce(s.hr,0)
    end,
    /* Every rate below is null when its denominator is zero. A hitter with no
       at-bats has no average; he does not have .000. */
    case when coalesce(s.ab,0) > 0 then s.h::double precision / s.ab end,
    case when coalesce(s.ab,0) + coalesce(s.bb,0) + coalesce(s.hbp,0) + coalesce(s.sf,0) > 0
         then (coalesce(s.h,0) + coalesce(s.bb,0) + coalesce(s.hbp,0))::double precision
              / (s.ab + coalesce(s.bb,0) + coalesce(s.hbp,0) + coalesce(s.sf,0)) end,
    case when coalesce(s.ab,0) > 0
         then (s.h + coalesce(s.doubles,0) + 2*coalesce(s.triples,0)
               + 3*coalesce(s.hr,0))::double precision / s.ab end,
    /* OPS is the sum of the two above, and is null if either is. Adding a null
       to a number in SQL gives null, which is the behaviour wanted here. */
    case when coalesce(s.ab,0) > 0
          and coalesce(s.ab,0) + coalesce(s.bb,0) + coalesce(s.hbp,0) + coalesce(s.sf,0) > 0
         then (coalesce(s.h,0) + coalesce(s.bb,0) + coalesce(s.hbp,0))::double precision
              / (s.ab + coalesce(s.bb,0) + coalesce(s.hbp,0) + coalesce(s.sf,0))
            + (s.h + coalesce(s.doubles,0) + 2*coalesce(s.triples,0)
               + 3*coalesce(s.hr,0))::double precision / s.ab end,
    /* Isolated power: slugging minus average, i.e. extra bases per at-bat. */
    case when coalesce(s.ab,0) > 0
         then (coalesce(s.doubles,0) + 2*coalesce(s.triples,0)
               + 3*coalesce(s.hr,0))::double precision / s.ab end,

    s.pitches, s.p_games, s.gs, s.w, s.l, s.cg, s.sho, s.sv, s.outs, s.tbf,
    s.p_h, s.p_r, s.er, s.p_hr, s.p_bb, s.p_hbp, s.wp, s.bk, s.p_so,
    s.qualified_pitching,

    /* Nine innings is 27 outs, so ERA is ER * 27 / outs. Null over zero outs,
       because an ERA over no innings is a division by zero and not an infinity
       to put on a card. */
    case when coalesce(s.outs,0) > 0 then s.er * 27.0 / s.outs end,
    case when coalesce(s.outs,0) > 0
         then (coalesce(s.p_h,0) + coalesce(s.p_bb,0)) * 3.0 / s.outs end,
    case when coalesce(s.outs,0) > 0 then s.p_so * 27.0 / s.outs end,
    case when coalesce(s.outs,0) > 0 then s.p_bb * 27.0 / s.outs end,
    /* Strikeout rate per batter faced. This source publishes TBF, so this is
       the real denominator rather than the at-bats approximation. */
    case when coalesce(s.tbf,0) > 0 then s.p_so::double precision / s.tbf end,

    s.source, s.source_sha256, now()
    from cbb.stg_ncaa_player_seasons s
   where s.import_id = p_import_id;

  select count(*) into v_rows from cbb.ncaa_player_seasons
   where p_season is null or season = p_season;

  update cbb.import_runs
     set status='promoted', promoted_at=now(), refusals='[]'::jsonb, updated_at=now(),
         row_counts = jsonb_build_object('ncaa_player_seasons', v_staged)
   where import_id = p_import_id;
  update cbb.import_runs set status='superseded', updated_at=now()
   where dataset='ncaa_seasons' and status='promoted' and import_id <> p_import_id;
  delete from cbb.stg_ncaa_player_seasons where import_id = p_import_id;

  return jsonb_build_object('ok', true, 'rows', v_staged, 'live', v_rows);
end;
$$;

create or replace function cbb.promote_club_map(p_import_id text)
returns jsonb
language plpgsql
as $$
declare
  v_refusals jsonb := '[]'::jsonb;
  v_staged bigint;
  v_dupe_espn bigint;
  v_dupe_code bigint;
  v_orphan bigint;
begin
  select count(*) into v_staged from cbb.stg_club_map where import_id = p_import_id;
  if v_staged = 0 then
    v_refusals := v_refusals || jsonb_build_object('refusal','EMPTY_IMPORT',
      'detail','no staged club mappings');
  end if;

  /* THE COLLISION THAT WOULD MIS-ATTRIBUTE A SEASON. */
  select count(*) into v_dupe_espn from (
    select espn_team_id from cbb.stg_club_map where import_id = p_import_id
     group by 1 having count(*) > 1) d;
  if v_dupe_espn > 0 then
    v_refusals := v_refusals || jsonb_build_object('refusal','ESPN_CLUB_CLAIMED_TWICE',
      'detail', v_dupe_espn || ' ESPN club(s) are claimed by more than one NCAA code; '
        || 'that would put one programme''s players on another programme''s game');
  end if;

  select count(*) into v_dupe_code from (
    select ncaa_code from cbb.stg_club_map where import_id = p_import_id
     group by 1 having count(*) > 1) d;
  if v_dupe_code > 0 then
    v_refusals := v_refusals || jsonb_build_object('refusal','NCAA_CODE_TWICE',
      'detail', v_dupe_code || ' NCAA code(s) appear more than once');
  end if;

  /* A MAPPING TO A CLUB THE BOARD HAS NEVER HEARD OF is not useful and is
     probably a stale ESPN id. Checked only when the teams table is populated,
     so a fresh database can still be seeded in either order. */
  if (select count(*) from cbb.teams) > 0 then
    select count(*) into v_orphan
      from cbb.stg_club_map s
     where s.import_id = p_import_id
       and not exists (select 1 from cbb.teams t where t.team_id = s.espn_team_id);
    if v_orphan > 0 then
      v_refusals := v_refusals || jsonb_build_object('refusal','UNKNOWN_ESPN_CLUB',
        'detail', v_orphan || ' mapping(s) point at an ESPN club that is not in cbb.teams');
    end if;
  end if;

  if jsonb_array_length(v_refusals) > 0 then
    update cbb.import_runs set status='failed', failed_at=now(), refusals=v_refusals,
           updated_at=now(), failure_reason=(v_refusals->0->>'refusal')
     where import_id = p_import_id;
    return jsonb_build_object('ok', false, 'refusals', v_refusals);
  end if;

  delete from cbb.club_map where true;
  insert into cbb.club_map (ncaa_code, ncaa_name, espn_team_id, espn_name, via, resolved_at)
  select ncaa_code, ncaa_name, espn_team_id, espn_name, via, now()
    from cbb.stg_club_map where import_id = p_import_id;

  update cbb.import_runs set status='promoted', promoted_at=now(), refusals='[]'::jsonb,
         updated_at=now(), row_counts = jsonb_build_object('club_map', v_staged)
   where import_id = p_import_id;
  update cbb.import_runs set status='superseded', updated_at=now()
   where dataset='club_map' and status='promoted' and import_id <> p_import_id;
  delete from cbb.stg_club_map where import_id = p_import_id;

  return jsonb_build_object('ok', true, 'rows', v_staged);
end;
$$;

/* ---------------------------------------------------------------------------
   THE REPORT. Every row must read ok.
   --------------------------------------------------------------------------- */
with checks as (
  select 1 as n, 'all six cbb gates exist after being replaced' as guarantee,
    case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'cbb'
                  and p.proname in ('promote_cbb_import','rebuild_team_seasons','promote_cbb_stats',
                                    'rebuild_player_seasons','promote_ncaa_seasons','promote_club_map')) = 6
         then 'ok' else 'CHECK THIS' end as result
  union all select 2, 'no cbb function still carries a DELETE without a WHERE',
    case when not exists (
           select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'cbb'
             and p.prosrc ~* 'delete[[:space:]]+from[[:space:]]+[a-z_.]+[[:space:]]*;')
         then 'ok' else 'CHECK THIS — safeupdate will refuse this gate' end
  union all select 3, 'a reader still cannot call any of them',
    case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'cbb'
                  and p.proname in ('promote_cbb_import','rebuild_team_seasons','promote_cbb_stats',
                                    'rebuild_player_seasons','promote_ncaa_seasons','promote_club_map')
                  and (has_function_privilege('anon', p.oid, 'execute')
                    or has_function_privilege('authenticated', p.oid, 'execute'))) = 0
         then 'ok' else 'CHECK THIS — a reader could rewrite the season archive' end
)
select n, guarantee, result from checks order by n;
