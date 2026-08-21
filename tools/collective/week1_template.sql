-- Build the Week 1 upload CSV from YOUR OWN captured odds.
--
-- Paste into the Supabase SQL editor, run, then Export -> CSV.
--
-- Every number below came from sportsbooks through your own feed. Nothing here
-- is estimated, and nothing here is a prediction: the `pick` column is left
-- EMPTY on purpose, for your model to fill. That is the one column the
-- Collective grades you on, and it is the one column that has to be yours.
--
-- The output matches the uploader's expected shape exactly, so it drops
-- straight onto the dashboard with no editing:
--
--   date, game_id, season, week, away, home, pick,
--   market_line, market_total, home_fair_prob, books
--
-- market_line is in HOME convention: negative means the home team is favoured.
-- So "SEA -3.5" appears as -3.5 on the NE @ SEA row. Write your pick as the
-- team and the number you are taking, e.g. "NE +3.5" or "SEA -3.5"; the
-- uploader reads both facts out of that one cell.
--
-- market_line, market_total, home_fair_prob and books are extra context for
-- you while you decide. The uploader ignores every column it does not
-- recognise, so you can leave them in the file or delete them.

with wk as (
  select
    e.id,
    e.commence_time,
    e.home_code,
    e.away_code,
    coalesce(e.season, 2026)                       as season,
    coalesce(e.week, 1)                            as week,
    odds.consensus(e.id)                           as c
  from odds.events e
  where e.league = 'nfl'
    -- Week 1 by the calendar rather than by e.week, because week is only
    -- populated once an event has been linked to the Collective's own slate.
    and e.commence_time >= timestamptz '2026-09-08 00:00-04'
    and e.commence_time <  timestamptz '2026-09-16 00:00-04'
)
select
  to_char(commence_time at time zone 'America/New_York', 'YYYY-MM-DD')  as date,
  '2026_01_' || away_code || '_' || home_code                           as game_id,
  season,
  week,
  away_code                                                             as away,
  home_code                                                             as home,
  ''                                                                    as pick,
  (c -> 'spread'    ->> 'median')::numeric                              as market_line,
  (c -> 'total'     ->> 'median')::numeric                              as market_total,
  (c -> 'moneyline' ->> 'home_fair_prob')::numeric                      as home_fair_prob,
  (c -> 'spread'    ->> 'books')::int                                   as books
from wk
order by commence_time;

-- A blank market_line on a row means no book has posted that game's spread
-- yet, not that the row is broken. Leave it; the Collective grades against the
-- closing line it captures itself, not against whatever was showing today.
