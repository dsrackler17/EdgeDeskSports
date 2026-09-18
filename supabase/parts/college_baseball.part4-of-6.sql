-- college_baseball -- part 4 of 6.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

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
    delete from cbb.player_seasons;
    delete from cbb.team_stat_seasons;
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
   THE SAME ACCESS RULES, APPLIED TO THE STATS HALF

   A separate block only because these tables are declared below the first one.
   The rules are identical and deliberately so: a reader's browser holds a
   publishable key, so anything it can reach is effectively public.

   cbb.player_games is readable, which is a decision rather than an oversight.
   A brief showing a game's box score has to read that game's lines, and the
   same is already true of cbb.games. What keeps that from being "ship the
   whole dataset to the browser" is the query layer, which asks for one game or
   one player at a time under an explicit row cap — not this grant. The grant
   makes the archive readable; the limits in lib/college_baseball.js make it
   bounded, and neither is a substitute for the other.

   Staging stays unreadable by anyone, and the gates stay uncallable by
   anyone but the importer's service role.
   ═══════════════════════════════════════════════════════════════════════════ */
alter table cbb.player_games      enable row level security;
alter table cbb.player_seasons    enable row level security;
alter table cbb.team_stat_seasons enable row level security;
alter table cbb.stg_player_games  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['player_games','player_seasons','team_stat_seasons'] loop
    execute format('drop policy if exists %I on cbb.%I', t || '_read', t);
    execute format('create policy %I on cbb.%I for select to anon, authenticated using (true)',
                   t || '_read', t);
    execute format('grant select on cbb.%I to anon, authenticated', t);
  end loop;
  /* no policy at all, so RLS denies everything by default */
  execute 'revoke all on cbb.stg_player_games from anon, authenticated';
end $$;

revoke all on function cbb.promote_cbb_stats(text, boolean, int) from public, anon, authenticated;
revoke all on function cbb.rebuild_player_seasons(int)           from public, anon, authenticated;

/* ── how complete is the stats archive for a season? ──────────────────────
   A reader should be able to see the gap rather than infer it from a club
   whose hitting line looks oddly light. */
create or replace view cbb.stats_coverage as
select g.season,
       count(distinct g.game_id)                                  as completed_games,
       count(distinct pg.game_id)                                 as games_with_lines,
       case when count(distinct g.game_id) > 0
            then count(distinct pg.game_id)::double precision
                 / count(distinct g.game_id) end                  as coverage,
       (select count(*) from cbb.player_seasons ps where ps.season = g.season) as players
  from cbb.games g
  left join cbb.player_games pg on pg.game_id = g.game_id
 where g.completed
 group by g.season
 order by g.season desc;


/* ═══════════════════════════════════════════════════════════════════════════
   THE SEASON ARCHIVE — NCAA'S OWN PUBLISHED SEASON STATISTICS

   A SECOND SOURCE, AND A CORRECTION. Everything above folds season numbers out
   of ESPN box scores, which was the best available when it was written and is
   still the only way to get PER-GAME lines. But I reported that both open-source
   college baseball packages were dead ends from CI because the NCAA site they
   wrap answers 403 to a datacenter address. For ncaa_bbStats that was wrong, and
   wrong in a way worth recording: it does not scrape at read time. It SHIPS the
   parsed data in its repository, so the 403 never enters the picture. My 404 on
   it was a guessed repository owner, and I generalised a real finding about a
   different package onto this one.

   What that mistake cost is visible in the columns below. The box-score labels
   carry no doubles, triples, hit-by-pitch or sacrifice flies, so this project
   documented — correctly, for that source — that on-base and slugging could not
   be computed and had to be carried from the source's own figure. THIS source
   publishes all four. So OBP and SLG here are computed, from the definitions,
   and they are the real ones:

     OBP = (H + BB + HBP) / (AB + BB + HBP + SF)
     SLG = (H + 2B + 2*3B + 3*HR) / AB

   HOW THE TWO SOURCES RELATE, because a reader must never have to guess:
     cbb.player_seasons       per-game box scores, folded. Current season, live,
                              partial coverage, no 2B/3B/HBP/SF.
     cbb.ncaa_player_seasons  NCAA's published season totals. 2021-2026,
                              complete seasons, every counting column.
   They are separate tables carrying a source column, and nothing merges them.
   Two sources that disagree must be able to be seen disagreeing.

   PROVENANCE, since this is somebody else's work:
     package   ncaa_bbStats 1.4.2, MIT, Copyright (c) 2025 Mateo Biggs
               https://github.com/CodeMateo15/ncaa_bbStats
     dataset   src/data/player_stats_cache_ncaa/batting/batting.csv and
               src/data/player_stats_cache_ncaa/pitching/pitching.csv
     upstream  NCAA's own published season statistics. The package is explicit
               that this cache passed through no third-party export at any
               point, which is why it is the one used here and the FanGraphs-
               sourced cache beside it is not.

   VERIFIED BEFORE TRUSTING, not assumed:
     32,161 batting and 31,368 pitching player-seasons, 311 teams, 2021-2026.
     2026 is a COMPLETE season, not the truncated mirror the package warns
     about: mean at-bats 106.5 against 105.2 in 2025, mean games 34.7 against
     34.4. A mid-season cut would have shown roughly half.
     Innings are written as thirds-in-tenths — only .0, .1 and .2 appear across
     4,000 sampled rows — so they are stored as OUTS here for the same reason
     they are everywhere else in this schema.
     One row is corrupt: Roberto Pena, USF, 2021, 450 at-bats with no games
     recorded, where the highest total among all 32,161 rows that do record
     games is 296. IMPOSSIBLE_AB below exists because of that row.
   ═══════════════════════════════════════════════════════════════════════════ */

alter table cbb.import_runs drop constraint if exists cbb_import_runs_dataset_ck;
alter table cbb.import_runs add constraint cbb_import_runs_dataset_ck
  check (dataset in ('games','stats','ncaa_seasons'));
