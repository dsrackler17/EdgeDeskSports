-- MODEL COLLECTIVE, UPGRADE 6: current market on the board.
-- Run after upgrade 5. Adds short team-name aliases that odds pages use and
-- the current_market view the board reads. Safe to run twice.

-- Model Collective, migration 16: short team names used by odds pages.
--
-- The NFL seed deliberately withheld bare city aliases for New York and Los
-- Angeles, because "LA" and "New York" each name two teams. These forms are
-- different: they carry the nickname, so they are unambiguous, and odds pages
-- print them constantly. Adding them by hand rather than loosening matching,
-- which is what would let a pick attach to the wrong team.

do $$
declare
  pairs text[][] := array[
    ['LA Chargers','LAC'], ['L.A. Chargers','LAC'], ['Los Angeles Chargers','LAC'],
    ['LA Rams','LAR'],     ['L.A. Rams','LAR'],
    ['NY Giants','NYG'],   ['N.Y. Giants','NYG'],
    ['NY Jets','NYJ'],     ['N.Y. Jets','NYJ']
  ];
  i int;
  v_team uuid;
begin
  for i in 1 .. array_length(pairs, 1) loop
    select id into v_team from collective.teams
     where sport_code = 'NFL' and code = pairs[i][2];
    if v_team is not null then
      insert into collective.team_aliases (sport_code, alias, team_id)
      values ('NFL', pairs[i][1], v_team)
      on conflict do nothing;
    end if;
  end loop;
end $$;

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
