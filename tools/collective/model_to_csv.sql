-- Turn what YOUR model wrote into the Collective upload CSV.
--
-- Paste into the Supabase SQL editor, run, then Export -> CSV and drop the
-- file on edgedesksports.com/collective. The headers below are the ones the
-- uploader recognises by name, so nothing needs mapping by hand and the
-- "which number is this?" question never comes up.
--
-- READS ONLY public.model_predictions. Every number in the output was written
-- by nfl_game_v1 on a real run; this file computes no probabilities and
-- invents no picks. If the model has not run, this returns zero rows, and
-- that is the correct answer rather than something to work around. Run
-- tools/collective/nfl_preflight.sql to find out why.
--
-- WHAT THE PICK COLUMN CONTAINS
--   The spread selection the model likes best on each game, written the way
--   the uploader reads it: team then number, e.g. "NE +3.5". Best = largest
--   model_edge, which is the probability gap between the model and the
--   de-vigged market. That is the price discrepancy, stated as a number.
--
-- HOME CONVENTION
--   market_line and projected_spread are both the HOME team's number.
--   Negative means the home team is favoured. sim_mean_margin runs the other
--   way (home minus away, positive = home wins), so projected_spread is its
--   negation. Get this backwards and every game on the board inverts while
--   still looking entirely reasonable.
--
-- THE LAST FOUR COLUMNS ARE FOR YOU, NOT FOR THE UPLOAD
--   model_edge_pct, model_ev_pct, market_prob_pct and best_price are ignored
--   by the uploader. They are there so you can sort the file, throw out the
--   thin ones, and upload what is left. Delete them or leave them in.

with params as (
  select
    -- Edit these three. Everything else follows.
    date '2026-09-08'  as week_start,     -- inclusive, Eastern
    date '2026-09-16'  as week_end,       -- exclusive, Eastern
    1                  as week_number,
    2026               as season,
    'nfl_game_v1'      as model_version
),
p as (
  select mp.*
    from public.model_predictions mp, params q
   where mp.model_version = q.model_version
     and mp.commence_time >= (q.week_start::timestamp at time zone 'America/New_York')
     and mp.commence_time <  (q.week_end::timestamp   at time zone 'America/New_York')
),
-- One spread pick per game. distinct on + a total order makes the choice
-- deterministic: the same table always exports the same file, so two runs
-- can be diffed against each other.
spread as (
  select distinct on (event_id) *
    from p
   where market = 'spreads' and point is not null
   order by event_id,
            coalesce(model_edge, -1) desc,
            model_prob desc,
            selection
),
-- The moneyline row for the HOME side, which is what home_win_probability
-- means. Taking whichever h2h row happened to sort first would file the away
-- team's win probability under the home team's name.
h2h_home as (
  select distinct on (event_id) event_id, model_prob
    from p
   where market = 'h2h' and selection = home_team
   order by event_id, model_prob desc
),
-- model_detail is identical across a game's rows, so any one of them carries
-- the simulation summary.
det as (
  select distinct on (event_id) event_id, home_team, away_team, commence_time, model_detail
    from p
   where model_detail is not null
   order by event_id, market, selection
)
select
  to_char(d.commence_time at time zone 'America/New_York', 'YYYY-MM-DD')  as date,
  q.season                                                               as season,
  q.week_number                                                          as week,
  d.away_team                                                            as away,
  d.home_team                                                            as home,

  -- "NE +3.5" / "SEA -3.5" / "BUF PK". The uploader reads the side and the
  -- number out of this one cell.
  -- to_char with a decimal place renders a whole number as "3." , and the
  -- uploader refuses "SEA -3." because a trailing dot with no digit after it
  -- is not a number. Whole and half points are formatted separately for that
  -- one reason.
  s.selection || ' ' ||
    case when s.point = 0 then 'PK' else
      (case when s.point > 0 then '+' else '' end) ||
      (case when s.point = trunc(s.point)
            then to_char(s.point, 'FM999990')
            else to_char(s.point, 'FM999990.9') end)
    end                                                                  as pick,

  -- The market number the pick was taken at, in home convention. This is the
  -- CLV baseline: the Collective grades the closing line against it.
  case when s.selection = d.home_team then s.point else -s.point end     as market_line,

  -- The model's own numbers.
  -(d.model_detail ->> 'sim_mean_margin')::numeric                       as projected_spread,
  (d.model_detail  ->> 'sim_mean_total')::numeric                        as projected_total,
  (d.model_detail  ->> 'expected_home_points')::numeric                  as proj_home_score,
  (d.model_detail  ->> 'expected_away_points')::numeric                  as proj_away_score,
  round(hh.model_prob, 4)                                                as home_win_probability,
  round(s.model_prob, 4)                                                 as cover_probability,

  -- Context columns. The uploader ignores every header it does not know.
  round(s.model_edge * 100, 2)                                           as model_edge_pct,
  round(s.model_ev   * 100, 2)                                           as model_ev_pct,
  round(s.market_prob_at_pred * 100, 2)                                  as market_prob_pct,
  s.best_am_at_pred                                                      as best_price
from det d
join params q on true
join spread s on s.event_id = d.event_id
left join h2h_home hh on hh.event_id = d.event_id
order by d.commence_time, d.home_team;

-- Zero rows is a real answer, not a broken query. It means nfl_game_v1 has
-- written nothing in that window. nfl_preflight.sql says which of the three
-- reasons it is.
