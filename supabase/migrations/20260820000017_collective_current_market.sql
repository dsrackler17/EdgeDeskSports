-- Model Collective, migration 17: the current market on the board.
--
-- One row per game: the most recent snapshot, whichever book it came from,
-- with its age so a reader can see how fresh it is. Market prices are public
-- information, published on odds pages, so this is not gated: the Collective's
-- paid surface is the models' numbers, never the market's.

create or replace view collective.current_market as
select distinct on (ms.game_id)
  ms.game_id, ms.book, ms.source, ms.market,
  ms.home_line, ms.home_price, ms.away_line, ms.away_price,
  ms.total_line, ms.over_price, ms.under_price,
  ms.captured_at
from collective.market_snapshots ms
where ms.market = 'spread'
order by ms.game_id, ms.captured_at desc;

grant select on collective.current_market to service_role;
