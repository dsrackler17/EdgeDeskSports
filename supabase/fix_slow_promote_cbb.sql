/* ===========================================================================
   THE PROMOTE TOOK 35 SECONDS AND POSTGREST KILLED IT. THIS IS WHY.

   The college import staged cleanly — 437/437 teams answered, 5,500 games
   unioned, 5,500 games and 437 teams staged — and then died in the gate:

     RPC cbb.promote_cbb_import -> 500: {"code":"57014",
       "message":"canceling statement due to statement timeout"}

   Not a Supabase sizing problem. Timed against a local PostgreSQL on the same
   volume, the promote took 35,560 ms, which is 35 seconds of work for 5,500
   rows. Raising the statement timeout would have hidden it rather than fixed
   it, and the next season would have hit the same wall further along.

   THE CAUSE. cbb.rebuild_team_seasons computed each club's current streak with
   a correlated subquery inside an aggregate filter: for every row it re-scanned
   the same CTE to find the first differing result, and inside THAT re-scanned
   it again to find the most recent one. A season is two rows per fixture, so
   11,000 rows each re-scanning 11,000 rows — quadratic, and entirely invisible
   on a handful of test games.

   THE FIX. The same answer in one ordered pass over the rows. first_value
   carries each club's most recent result down its own partition; a running
   count of rows that differ from it is 0 for exactly the leading run and >= 1
   from the first change onward, so summing under that condition selects the
   same set the old filter did.

     before   35,560 ms
     after       178 ms

   AND IT IS THE SAME ANSWER, not a faster different one. Both forms were run
   against the same 5,500-game season and compared club by club: 437 clubs
   compared, 0 disagreements, streaks ranging -4 to 3 rather than a column of
   zeros that would agree trivially. The two edge cases the old form had are
   preserved deliberately — a club whose results never change keeps all its
   rows (the old coalesce to 1e9), and a tie does not break a run of losses
   while still contributing 0, because both carry won = false.

   Safe to run more than once. It replaces one function and touches no data.
   =========================================================================== */

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
  /* THE STREAK IS THE RUN OF LIKE RESULTS ENDING AT THE MOST RECENT GAME.

     This was written as a correlated subquery inside an aggregate filter: for
     every row of `ranked` it re-scanned `ranked` to find the first differing
     result, and inside THAT it re-scanned `ranked` again for the most recent
     one. Quadratic on both sides of every fixture — 11,000 rows for a 5,500
     game season — which took 35 seconds for a single season and was killed by
     PostgREST's statement timeout before it could ever promote:

       RPC cbb.promote_cbb_import -> 500 {"code":"57014",
         "message":"canceling statement due to statement timeout"}

     Same answer in one ordered pass. `latest` carries each club's most recent
     result down its own rows; `diffs` counts how many rows so far differ from
     it, so it is 0 for exactly the leading run and >= 1 from the first change
     onward. Summing under `diffs = 0` is the same set the old filter selected,
     including its two edge cases: a club whose results never change keeps all
     its rows (the old form's coalesce to 1e9), and a tie is not distinct from
     a loss for run-breaking purposes while still contributing 0 to the total,
     because both carry won = false. */
  with_latest as (
    select r.*,
           first_value(r.won) over (partition by r.season, r.team_id order by r.recency) as latest_won
      from ranked r
  ),
  marked as (
    select w.*,
           sum(case when w.won is distinct from w.latest_won then 1 else 0 end)
             over (partition by w.season, w.team_id order by w.recency
                   rows between unbounded preceding and current row) as diffs
      from with_latest w
  ),
  streaks as (
    select season, team_id,
           coalesce(sum(case when won then 1 when lost then -1 else 0 end)
                    filter (where diffs = 0), 0) as streak
      from marked group by season, team_id
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

/* ---------------------------------------------------------------------------
   THE REPORT. Every row must read ok.
   --------------------------------------------------------------------------- */
with checks as (
  select 1 as n, 'the rebuild exists after being replaced' as guarantee,
    case when to_regprocedure('cbb.rebuild_team_seasons()') is not null
         then 'ok' else 'CHECK THIS' end as result
  union all select 2, 'it no longer re-scans itself per row',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='rebuild_team_seasons') !~* 'from ranked r2'
         then 'ok' else 'CHECK THIS — the quadratic form is still in place' end
  union all select 3, 'it computes the streak in one ordered pass',
    case when (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='cbb' and p.proname='rebuild_team_seasons') ~* 'first_value'
         then 'ok' else 'CHECK THIS' end
  union all select 4, 'the importer may still call it and a reader may not',
    case when has_function_privilege('service_role','cbb.rebuild_team_seasons()','execute')
          and not has_function_privilege('anon','cbb.rebuild_team_seasons()','execute')
         then 'ok' else 'CHECK THIS' end
)
select n, guarantee, result from checks order by n;
