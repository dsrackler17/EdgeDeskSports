-- Model Collective, migration 21: the live odds provider, in config.
--
-- What to poll, and how a league id from the feed becomes a Collective sport
-- code. Config rather than code so adding a league or a second sportsbook is
-- a row, not a deploy. The provider key itself is never here: it is an Edge
-- Function secret, because anything in a table is one misconfigured policy
-- away from being readable (docs/collective/M-odds.md, section 2).

insert into collective.config (key, value, description) values
  ('odds.provider', '"oddsblaze"',
   'The odds feed collective_odds reads. The key lives only in Edge Function secrets.'),
  ('odds.collect',
   '[{"sportsbook":"draftkings","league":"mlb"},{"sportsbook":"draftkings","league":"nfl"}]',
   'One sportsbook and one league per call, which is how the feed is served. Each entry is one poll.'),
  ('odds.league_sports',
   '{"mlb":"MLB","nfl":"NFL","ncaaf":"NCAAF"}',
   'Feed league id -> Collective sport code. A league absent here is reported unmapped, never guessed.'),
  ('odds.include_live',
   'false',
   'In-progress prices are a different market from the pregame one and would corrupt closing-line value.')
on conflict (key) do nothing;

-- The canonical book defines the closing line, and a closing line is only
-- ever written from a book that was actually collected. Pinnacle was the
-- placeholder default from migration 15; the feed the Collective now runs is
-- DraftKings, so leaving Pinnacle in place would mean every game closes
-- "unavailable" and CLV silently never computes. Named explicitly here, and
-- only where nothing has been collected from Pinnacle: an installation that
-- does collect Pinnacle keeps it.
update collective.config
   set value = '"DraftKings"',
       description = 'The only book whose snapshot may become the closing line. Must be a book that is actually collected.'
 where key = 'market.canonical_book'
   and value = '"Pinnacle"'
   and not exists (
     select 1 from collective.market_snapshots where book = 'Pinnacle'
   );

-- The board's current-market row predates moneyline columns (migration 18
-- added them; migration 17 built this view before they existed), so the
-- moneyline the collector now captures had no way to reach a page. Added
-- here rather than left invisible: a number that is stored and unshowable is
-- a number nobody can check.
create or replace view collective.current_market as
select distinct on (ms.game_id)
  ms.game_id, ms.book, ms.source, ms.market,
  ms.home_line, ms.home_price, ms.away_line, ms.away_price,
  ms.total_line, ms.over_price, ms.under_price,
  ms.captured_at,
  -- Appended, not inserted: create or replace view may only add columns at
  -- the end of the list.
  ms.home_ml_price, ms.away_ml_price
from collective.market_snapshots ms
where ms.market = 'spread'
order by ms.game_id, ms.captured_at desc;

grant select on collective.current_market to service_role;
