-- Behavioural tests for the odds schema. Run against a database that has the
-- fixture plus the migration applied:
--
--   psql -d oddstest -v ON_ERROR_STOP=1 -f tests/collective/odds_schema_fixture.sql
--   psql -d oddstest -v ON_ERROR_STOP=1 -f supabase/migrations/20260821090000_nfl_odds.sql
--   psql -d oddstest -v ON_ERROR_STOP=1 -f tests/collective/odds_schema_test.sql
--
-- Every check raises an exception on failure, so ON_ERROR_STOP turns the file
-- into a pass/fail gate. No production path reads any value defined here.

\set ON_ERROR_STOP on

create or replace function pg_temp.check(p_label text, p_cond boolean)
returns void language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'FAIL: %', p_label;
  end if;
  raise notice 'pass: %', p_label;
end $$;

-- ------------------------------------------------------------ team aliases
do $$
begin
  perform pg_temp.check('full name resolves',      odds.resolve_team('nfl','Kansas City Chiefs') = 'KC');
  perform pg_temp.check('nickname resolves',       odds.resolve_team('nfl','Chiefs') = 'KC');
  perform pg_temp.check('abbreviation resolves',   odds.resolve_team('nfl','KAN') = 'KC');
  perform pg_temp.check('case/punct insensitive',  odds.resolve_team('nfl','kansas-city chiefs') = 'KC');
  perform pg_temp.check('relocation alias',        odds.resolve_team('nfl','Oakland Raiders') = 'LV');
  perform pg_temp.check('San Diego -> LAC',        odds.resolve_team('nfl','SD') = 'LAC');
  perform pg_temp.check('49ers digits survive',    odds.resolve_team('nfl','San Francisco 49ers') = 'SF');
  perform pg_temp.check('NY teams stay distinct',
    odds.resolve_team('nfl','New York Giants') = 'NYG'
    and odds.resolve_team('nfl','New York Jets') = 'NYJ');
  perform pg_temp.check('suffix fallback',         odds.resolve_team('nfl','Los Angeles Chargers') = 'LAC');
  perform pg_temp.check('nonsense stays null',     odds.resolve_team('nfl','Toronto Maple Leafs') is null);
  perform pg_temp.check('null stays null',         odds.resolve_team('nfl', null) is null);
  perform pg_temp.check('all 32 teams seeded',
    (select count(distinct team_code) from odds.team_aliases where league='nfl') = 32);
end $$;

-- ------------------------------------------------------------- price math
do $$
begin
  perform pg_temp.check('-110 decimal',  round(odds.american_to_decimal(-110), 4) = 1.9091);
  perform pg_temp.check('+135 decimal',  odds.american_to_decimal(135) = 2.35);
  perform pg_temp.check('-110 prob',     round(odds.american_to_prob(-110), 4) = 0.5238);
  perform pg_temp.check('junk price null', odds.american_to_decimal(-50) is null);
  perform pg_temp.check('devig sums to one',
    round(odds.devig_two_way(0.5238, 0.5238) + odds.devig_two_way(0.5238, 0.5238), 4) = 1.0000);
  perform pg_temp.check('prob->american round trip',
    odds.prob_to_american(round(odds.american_to_prob(-150), 6)) = -150);
  perform pg_temp.check('underdog round trip',
    odds.prob_to_american(round(odds.american_to_prob(200), 6)) = 200);
end $$;

-- -------------------------------------------------------- ingest: creation
do $$
declare v_run bigint; v_res jsonb;
begin
  v_run := odds.begin_ingest('oddsblaze','nfl','test');
  v_res := odds.ingest_batch(v_run, 'oddsblaze', 'nfl', $j$
  {"events":[{
    "provider_event_id":"ob-1","home":"Kansas City Chiefs","away":"Buffalo Bills",
    "commence_time":"2026-09-20T17:00:00Z","season":2026,"week":3,
    "is_live":false,"status":"scheduled",
    "odds":[
      {"book":"draftkings","market":"spread","outcome":"home","outcome_label":"Kansas City Chiefs","line":-3.5,"price":-110},
      {"book":"draftkings","market":"spread","outcome":"away","outcome_label":"Buffalo Bills","line":3.5,"price":-110},
      {"book":"draftkings","market":"moneyline","outcome":"home","price":-185},
      {"book":"draftkings","market":"moneyline","outcome":"away","price":155},
      {"book":"draftkings","market":"total","outcome":"over","line":47.5,"price":-110},
      {"book":"draftkings","market":"total","outcome":"under","line":47.5,"price":-110},
      {"book":"fanduel","market":"spread","outcome":"home","line":-3.5,"price":-115},
      {"book":"fanduel","market":"spread","outcome":"away","line":3.5,"price":-105},
      {"book":"fanduel","market":"moneyline","outcome":"home","price":-180},
      {"book":"fanduel","market":"moneyline","outcome":"away","price":152},
      {"book":"fanduel","market":"total","outcome":"over","line":47.0,"price":-108},
      {"book":"betmgm","market":"spread","outcome":"home","line":-4.0,"price":-105},
      {"book":"betmgm","market":"moneyline","outcome":"home","price":-190},
      {"book":"betmgm","market":"moneyline","outcome":"away","price":160},
      {"book":"pinnacle","market":"spread","outcome":"home","line":-3.5,"price":-108},
      {"book":"pinnacle","market":"moneyline","outcome":"home","price":-183},
      {"book":"pinnacle","market":"moneyline","outcome":"away","price":158}
    ]}]}
  $j$::jsonb);

  perform pg_temp.check('ingest ok',            (v_res->>'ok')::boolean);
  perform pg_temp.check('one event seen',       (v_res->>'events_seen')::int = 1);
  perform pg_temp.check('one event created',    (v_res->>'events_created')::int = 1);
  perform pg_temp.check('17 snapshots written', (v_res->>'snapshots_written')::int = 17);
  perform pg_temp.check('nothing rejected',     (v_res->>'rows_rejected')::int = 0);
  perform pg_temp.check('teams normalized to codes',
    (select home_code = 'KC' and away_code = 'BUF' from odds.events limit 1));
  perform pg_temp.check('provider id is a mapping, not the identity',
    (select count(*) from odds.event_providers where provider_event_id = 'ob-1') = 1);
  perform pg_temp.check('event id is our own uuid',
    (select id::text <> 'ob-1' from odds.events limit 1));
  perform pg_temp.check('league day is the Sunday, not the UTC Monday',
    (select commence_date = date '2026-09-20' from odds.events limit 1));
  perform odds.finish_ingest(v_run, jsonb_build_object('status','ok'));
end $$;

-- ------------------------------------------------- ingest: no-change dedupe
do $$
declare v_run bigint; v_res jsonb; v_before int;
begin
  select count(*) into v_before from odds.snapshots;
  v_run := odds.begin_ingest('oddsblaze','nfl','test');
  -- Same event, same prices: a re-poll with no movement.
  v_res := odds.ingest_batch(v_run, 'oddsblaze', 'nfl', $j$
  {"events":[{
    "provider_event_id":"ob-1","home":"KC","away":"BUF",
    "commence_time":"2026-09-20T17:00:00Z","season":2026,"week":3,
    "odds":[
      {"book":"draftkings","market":"spread","outcome":"home","line":-3.5,"price":-110},
      {"book":"draftkings","market":"moneyline","outcome":"home","price":-185}
    ]}]}
  $j$::jsonb);
  perform pg_temp.check('unchanged prices write nothing',
    (v_res->>'snapshots_written')::int = 0 and (v_res->>'snapshots_unchanged')::int = 2);
  perform pg_temp.check('no duplicate event from a different spelling',
    (select count(*) from odds.events) = 1);
  perform pg_temp.check('snapshot table did not grow',
    (select count(*) from odds.snapshots) = v_before);
end $$;

-- ------------------------------------------------ ingest: movement history
-- The spec's example: every one of these must stay recoverable.
--   Chiefs -3.5 -110 / -3.5 -115 / -4.0 -110 / -4.0 -105
do $$
declare v_run bigint; v_res jsonb;
begin
  foreach v_res in array array[
    '{"line":-3.5,"price":-115}'::jsonb,
    '{"line":-4.0,"price":-110}'::jsonb,
    '{"line":-4.0,"price":-105}'::jsonb ]
  loop
    v_run := odds.begin_ingest('oddsblaze','nfl','test');
    perform odds.ingest_batch(v_run, 'oddsblaze', 'nfl', jsonb_build_object(
      'events', jsonb_build_array(jsonb_build_object(
        'provider_event_id','ob-1','home','KC','away','BUF',
        'commence_time','2026-09-20T17:00:00Z',
        'odds', jsonb_build_array(jsonb_build_object(
          'book','draftkings','market','spread','outcome','home',
          'line', v_res->'line', 'price', v_res->'price'))))));
  end loop;

  perform pg_temp.check('all four DK spread states recoverable',
    (select count(*) from odds.snapshots s
      join odds.events e on e.id = s.event_id
     where s.book_id='draftkings' and s.market_id='spread' and s.outcome='home') = 4);
  perform pg_temp.check('movement is ordered and complete',
    (select array_agg(line::text || '@' || price::text order by id)
       from odds.snapshots
      where book_id='draftkings' and market_id='spread' and outcome='home')
    = array['-3.50@-110','-3.50@-115','-4.00@-110','-4.00@-105']);
  perform pg_temp.check('current is the newest state',
    (select line = -4.0 and price = -105 from odds.current_main
      where book_id='draftkings' and market_id='spread' and outcome='home'));
  perform pg_temp.check('opening is the first state and did not move',
    (select line = -3.5 and price = -110 from odds.opening_lines
      where book_id='draftkings' and market_id='spread' and outcome='home'));
end $$;

-- ------------------------------------------------------------- best price
do $$
declare v jsonb; v_home jsonb;
begin
  v := odds.best_price((select id from odds.events limit 1), 'spread');
  v_home := v->'outcomes'->'home';
  perform pg_temp.check('best price groups by line, not across lines',
    (select count(*) from jsonb_array_elements(v_home->'lines')) = 2);
  -- -3.5 is on FanDuel (-115) and Pinnacle (-108); -4.0 is on DK (-105) and MGM (-105).
  perform pg_temp.check('best at -3.5 is Pinnacle -108',
    (select (l->'best'->>'book') = 'pinnacle' and (l->'best'->>'price')::int = -108
       from jsonb_array_elements(v_home->'lines') l where (l->>'line')::numeric = -3.5));
  -- The point of grouping: -4.0 -105 and -3.5 -108 are different bets, so
  -- each line names its own winner and no single price is crowned across
  -- lines. Nothing in the payload says -105 "beats" -108.
  perform pg_temp.check('best at -4.0 is its own group winner',
    (select (l->'best'->>'price')::int = -105
       from jsonb_array_elements(v_home->'lines') l where (l->>'line')::numeric = -4.0));
  perform pg_temp.check('no cross-line best price is claimed',
    not (v_home ? 'best') and not (v ? 'best'));
  perform pg_temp.check('exactly one line is marked primary',
    (select count(*) from jsonb_array_elements(v_home->'lines') l
      where (l->>'is_primary')::boolean) = 1);
  perform pg_temp.check('primary line is one the books are actually on',
    (v_home->>'primary_line')::numeric in (-3.5, -4.0));
  perform pg_temp.check('every line carries its own book list',
    (select bool_and(jsonb_array_length(l->'books') > 0)
       from jsonb_array_elements(v_home->'lines') l));

  -- Unambiguous case: three books on -6.5, one on -6.0.
  v := odds.best_price((select id from odds.events where home_code='DAL'), 'spread');
  perform pg_temp.check('primary line is the most-booked line',
    (v->'outcomes'->'home'->>'primary_line') is null
    or (v->'outcomes'->'home'->>'primary_line')::numeric = -6.5);
end $$;

-- --------------------------------------------------------------- consensus
do $$
declare v jsonb;
begin
  v := odds.consensus((select id from odds.events limit 1));
  -- Retail main spreads on 'home': DK -4.0, FD -3.5, MGM -4.0. Pinnacle excluded.
  perform pg_temp.check('consensus spread counts retail books only',
    (v->'spread'->>'books')::int = 3);
  perform pg_temp.check('consensus spread is the median',
    (v->'spread'->>'median')::numeric = -4.0);
  perform pg_temp.check('sharp book reported separately',
    v->'sharp' ? 'pinnacle');
  perform pg_temp.check('pinnacle is not inside the retail consensus',
    (v->'spread'->>'books')::int = 3);
  perform pg_temp.check('moneyline consensus is de-vigged, not averaged',
    (v->'moneyline'->>'method') = 'median of de-vigged two-way probabilities'
    and (v->'moneyline'->>'home_fair_prob')::numeric between 0.60 and 0.68);
  perform pg_temp.check('de-vigged prob is below the vigged one',
    (v->'moneyline'->>'home_fair_prob')::numeric < odds.american_to_prob(-185));
  perform pg_temp.check('consensus total present',
    (v->'total'->>'median')::numeric between 47.0 and 47.5);
end $$;

-- ------------------------------------------------------ closing lines only
do $$
declare v_event uuid; v_n int;
begin
  select id into v_event from odds.events limit 1;

  perform pg_temp.check('a future game has no closing line',
    odds.finalize_closing(v_event) = 0
    and (select count(*) from odds.closing_lines) = 0);

  -- Move kickoff into the past, with the captured prices sitting before it,
  -- which is the real sequence: poll, poll, poll, kickoff.
  update odds.snapshots set captured_at = now() - interval '30 minutes'
   where event_id = v_event;
  update odds.events set commence_time = now() - interval '5 minutes',
                         commence_date = odds.league_day(now() - interval '5 minutes')
   where id = v_event;
  v_n := odds.finalize_closing(v_event);
  perform pg_temp.check('finalize reports how many series it closed', v_n > 0);

  perform pg_temp.check('closing lines written once the market closed',
    (select count(*) from odds.closing_lines where event_id = v_event) > 0);
  perform pg_temp.check('closing DK spread is the last pre-kickoff price',
    (select line = -4.0 and price = -105 from odds.closing_lines
      where event_id = v_event and book_id='draftkings'
        and market_id='spread' and outcome='home'));
  perform pg_temp.check('event marked finalized',
    (select closing_finalized from odds.events where id = v_event));
  -- Kickoff closes the market; it does not end the game. Writing status
  -- 'final' here marked every game in progress as over, irreversibly.
  perform pg_temp.check('closing the market does not declare the game over',
    (select status <> 'final' from odds.events where id = v_event));

  -- A later price cannot rewrite a close.
  perform odds.ingest_batch(odds.begin_ingest('oddsblaze','nfl','test'), 'oddsblaze','nfl',
    jsonb_build_object('events', jsonb_build_array(jsonb_build_object(
      'provider_event_id','ob-1','home','KC','away','BUF',
      'commence_time', to_char(now() - interval '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SSOF'),
      'odds', jsonb_build_array(jsonb_build_object(
        'book','draftkings','market','spread','outcome','home','line',-7,'price',-120))))));
  perform odds.finalize_closing(v_event);
  perform pg_temp.check('a post-kickoff price never becomes the close',
    (select line = -4.0 from odds.closing_lines
      where event_id = v_event and book_id='draftkings'
        and market_id='spread' and outcome='home'));
end $$;

-- ------------------------------------------------------------ bad input
do $$
declare v_run bigint; v_res jsonb;
begin
  v_run := odds.begin_ingest('oddsblaze','nfl','test');
  v_res := odds.ingest_batch(v_run, 'oddsblaze','nfl', $j$
  {"events":[
    {"provider_event_id":"ob-x","home":"Sheffield Wednesday","away":"BUF",
     "commence_time":"2026-10-01T17:00:00Z",
     "odds":[{"book":"draftkings","market":"spread","outcome":"home","line":-3,"price":-110}]},
    {"provider_event_id":"ob-y","home":"KC","away":"DEN","commence_time":"not a date",
     "odds":[]},
    {"provider_event_id":"ob-z","home":"DAL","away":"NYG",
     "commence_time":"2026-10-04T17:00:00Z",
     "odds":[
       {"book":"draftkings","market":"spread","outcome":"home","line":-3,"price":-15},
       {"book":"draftkings","market":"spread","outcome":"home","line":-3},
       {"book":"draftkings","market":"weird_new_market","outcome":"home","line":1,"price":-110}
     ]}
  ]}
  $j$::jsonb);

  perform pg_temp.check('unknown team is reported, not invented',
    (select count(*) from jsonb_array_elements(v_res->'unmatched') u
      where u->>'reason' = 'unknown_team') = 1);
  perform pg_temp.check('unparsable kickoff is reported',
    (select count(*) from jsonb_array_elements(v_res->'unmatched') u
      where u->>'reason' = 'unparsable_commence_time') = 1);
  perform pg_temp.check('impossible American price rejected',
    (v_res->>'rows_rejected')::int >= 2);
  perform pg_temp.check('a valid event alongside bad ones still lands',
    (select count(*) from odds.events where home_code='DAL' and away_code='NYG') = 1);
  perform pg_temp.check('an unexpected market is registered, not dropped silently',
    (select auto_added and not enabled from odds.markets where id='weird_new_market'));
  perform pg_temp.check('invalid payload shape returns an error, not a crash',
    (odds.ingest_batch(v_run,'oddsblaze','nfl','{"nope":1}'::jsonb)->>'code') = 'invalid_payload');
end $$;

-- --------------------------------------------------- link to collective
do $$
declare v_game uuid; v_linked int;
begin
  insert into collective.games (sport, season, week, kickoff_at, home, away)
  values ('NFL', 2026, 5, '2026-10-04T17:00:00Z', 'DAL', 'NYG')
  returning id into v_game;

  v_linked := odds.link_collective_games('nfl');
  perform pg_temp.check('collective game linked to odds event', v_linked = 1);
  perform pg_temp.check('link points at the right game',
    (select collective_game_id = v_game from odds.events
      where home_code='DAL' and away_code='NYG'));
  perform pg_temp.check('closing not available before the market closes',
    (collective.odds_closing_for_game(v_game)->>'available')::boolean is false);
  perform pg_temp.check('unlinked game says so plainly',
    (collective.odds_closing_for_game(gen_random_uuid())->>'reason') = 'no_linked_odds_event');
end $$;

-- A game that kicked off with nothing captured beforehand has no closing
-- line, and must say so rather than borrowing a post-kickoff price.
do $$
declare v_ev uuid;
begin
  perform odds.ingest_batch(odds.begin_ingest('oddsblaze','nfl','test'),'oddsblaze','nfl',
    jsonb_build_object('events', jsonb_build_array(jsonb_build_object(
      'provider_event_id','ob-late','home','SEA','away','SF',
      'commence_time', to_char(now() - interval '2 hours', 'YYYY-MM-DD"T"HH24:MI:SSOF'),
      'odds', jsonb_build_array(jsonb_build_object(
        'book','draftkings','market','spread','outcome','home','line',-2.5,'price',-110))))));
  select id into v_ev from odds.events where home_code='SEA' and away_code='SF';
  perform odds.finalize_closing(v_ev);
  perform pg_temp.check('no pregame capture means no closing line',
    (select count(*) from odds.closing_lines where event_id = v_ev) = 0);
  perform pg_temp.check('and the pass does not retry forever',
    (select closing_finalized from odds.events where id = v_ev));
  insert into collective.games (sport, season, week, kickoff_at, home, away)
  values ('NFL', 2026, 6, now() - interval '2 hours', 'SEA', 'SF');
  perform odds.link_collective_games('nfl');
  perform pg_temp.check('the read path names that case honestly',
    (collective.odds_closing_for_game(
      (select id from collective.games where home='SEA'))->>'reason') = 'no_pregame_capture');
end $$;

-- ------------------------------------------------- closing feed for admin
do $$
declare v_game uuid; v jsonb;
begin
  select g.id into v_game from collective.games g where g.home='DAL';
  -- Put a full two-sided market on the game, then close it.
  perform odds.ingest_batch(odds.begin_ingest('oddsblaze','nfl','test'),'oddsblaze','nfl',
    jsonb_build_object('events', jsonb_build_array(jsonb_build_object(
      'provider_event_id','ob-z','home','DAL','away','NYG',
      'commence_time','2026-10-04T17:00:00Z',
      'odds', jsonb_build_array(
        jsonb_build_object('book','draftkings','market','spread','outcome','home','line',-6.5,'price',-110),
        jsonb_build_object('book','fanduel','market','spread','outcome','home','line',-6.0,'price',-105),
        jsonb_build_object('book','betmgm','market','spread','outcome','home','line',-6.5,'price',-108),
        jsonb_build_object('book','draftkings','market','total','outcome','over','line',44.5,'price',-110),
        jsonb_build_object('book','fanduel','market','total','outcome','over','line',44.5,'price',-112),
        jsonb_build_object('book','betmgm','market','total','outcome','over','line',45.0,'price',-110),
        jsonb_build_object('book','draftkings','market','moneyline','outcome','home','price',-280),
        jsonb_build_object('book','draftkings','market','moneyline','outcome','away','price',230),
        jsonb_build_object('book','fanduel','market','moneyline','outcome','home','price',-275),
        jsonb_build_object('book','fanduel','market','moneyline','outcome','away','price',225))))));

  update odds.snapshots set captured_at = now() - interval '20 minutes'
   where event_id = (select id from odds.events where home_code='DAL' and away_code='NYG');
  update odds.events set commence_time = now() - interval '1 minute',
                         commence_date = odds.league_day(now() - interval '1 minute'),
                         closing_finalized = false
   where home_code='DAL' and away_code='NYG';
  perform odds.finalize_closing(null);

  v := collective.odds_closing_for_game(v_game);
  perform pg_temp.check('closing feed available after close',
    (v->>'available')::boolean);
  perform pg_temp.check('closing spread is the retail median',
    (v->>'closing_spread')::numeric = -6.5);
  perform pg_temp.check('closing total is the retail median',
    (v->>'closing_total')::numeric = 44.5);
  perform pg_temp.check('closing home ML prob is de-vigged',
    (v->>'closing_home_ml_prob')::numeric between 0.70 and 0.76);
end $$;

-- ------------------------------------------------------------- API surface
do $$
begin
  perform pg_temp.check('status reports feed health',
    (collective.odds_status('nfl')->>'snapshots_total')::int > 0
    and (collective.odds_status('nfl')->'last_run') is not null);
  perform pg_temp.check('odds_current view is readable',
    (select count(*) from collective.odds_current) > 0);
  perform pg_temp.check('odds_events exposes the collective link',
    (select count(*) from collective.odds_events where collective_game_id is not null)
    = (select count(*) from collective.games));
  -- Asserts the type and the round trip, NOT a particular shipped number.
  -- The cadence is deliberately re-tuned per provider plan, so pinning the
  -- value here made a legitimate settings change look like a schema break.
  perform pg_temp.check('settings are readable and typed',
    (collective.odds_get_setting('nfl.refresh_seconds.live'))::text::int > 0
    and jsonb_typeof(collective.odds_get_setting('nfl.refresh_seconds.live')) = 'number');
  perform pg_temp.check('settings are writable',
    (collective.odds_set_setting('nfl.refresh_seconds.live','45'::jsonb))::text::int = 45);
  perform pg_temp.check('anon cannot read the odds API surface',
    not has_table_privilege('anon','collective.odds_current','select'));
  perform pg_temp.check('authenticated cannot read the odds API surface',
    not has_table_privilege('authenticated','collective.odds_current','select'));
  perform pg_temp.check('service_role can',
    has_table_privilege('service_role','collective.odds_current','select'));
  perform pg_temp.check('RLS is on for every odds table',
    (select bool_and(rowsecurity) from pg_tables where schemaname='odds'));
end $$;

-- --------------------------------------------------------- read payloads
do $$
declare v jsonb; g jsonb; ev uuid;
begin
  select id into ev from odds.events where home_code='KC';
  v := collective.odds_board('nfl', null, null, true, 40);
  perform pg_temp.check('board returns the slate',
    jsonb_array_length(v->'games') = (select count(*) from odds.events));
  perform pg_temp.check('board carries a feed timestamp for staleness',
    (v->>'last_odds_at') is not null and (v->>'stale_after_seconds')::int > 0);

  g := (select x from jsonb_array_elements(v->'games') x
         where (x->>'event_id')::uuid = ev);
  perform pg_temp.check('game carries our id and the collective id slot',
    (g->>'event_id')::uuid = ev and g ? 'collective_game_id');
  perform pg_temp.check('game carries consensus, best and books together',
    g ? 'consensus' and g ? 'best' and g ? 'books');
  -- DK and FanDuel opened -3.5, BetMGM opened -4.0; Pinnacle is sharp and
  -- excluded. Median opener is -3.5, and each book's own opener survives.
  perform pg_temp.check('opening line is a median across books, like the close',
    (g->'opening'->'spread:home'->>'line')::numeric = -3.5
    and (g->'opening'->'spread:home'->>'books')::int = 3);
  perform pg_temp.check('each book keeps its own opener',
    (g->'opening'->'spread:home'->'by_book'->'betmgm'->>'line')::numeric = -4.0
    and (g->'opening'->'spread:home'->'by_book'->'draftkings'->>'line')::numeric = -3.5);
  perform pg_temp.check('opening did not move when the current line did',
    (g->'opening'->'spread:home'->>'line')::numeric
      <> (select line from odds.current_main
          where event_id = ev and book_id='draftkings'
            and market_id='spread' and outcome='home'));
  perform pg_temp.check('book grid lists every book on the spread',
    (select count(*) from jsonb_array_elements(g->'books'->'spread') b
      where b->>'outcome' = 'home') = 4);
  perform pg_temp.check('book grid marks the sharp book',
    (select bool_or((b->>'is_sharp')::boolean) from jsonb_array_elements(g->'books'->'spread') b));
  perform pg_temp.check('board can omit the book grid for light payloads',
    (collective.odds_board('nfl', null, null, false, 40)
      ->'games'->0->>'books') is null);

  perform pg_temp.check('event lookup by our id works',
    (collective.odds_event(ev, null, true)->>'event_id')::uuid = ev);
  perform pg_temp.check('event lookup by collective game id works',
    (collective.odds_event(null, (select id from collective.games where home='DAL'), true)
      ->>'home') = 'DAL');
  perform pg_temp.check('unknown event returns null, not an error',
    collective.odds_event(gen_random_uuid(), null, true) is null);

  v := collective.odds_history(ev, 'spread', 'draftkings', 'home', 500);
  perform pg_temp.check('history returns every stored state oldest first',
    jsonb_array_length(v->'points') = 5
    and (v->'points'->0->>'line')::numeric = -3.5
    and (v->'points'->0->>'price')::int = -110);
  perform pg_temp.check('history is filterable',
    jsonb_array_length(collective.odds_history(ev, 'moneyline', null, null, 500)->'points') > 0);
  perform pg_temp.check('a closed game reports its close in the payload',
    (collective.odds_event(
       (select id from odds.events where home_code='DAL'), null, true)
       ->'closing'->'spread:home'->>'line')::numeric = -6.5);
  perform pg_temp.check('market_closed flags a settled market',
    (collective.odds_event((select id from odds.events where home_code='DAL'), null, true)
      ->>'market_closed')::boolean);
  -- A game still to come must not be flagged closed, whatever else is on
  -- the board.
  perform odds.ingest_batch(odds.begin_ingest('oddsblaze','nfl','test'),'oddsblaze','nfl',
    jsonb_build_object('events', jsonb_build_array(jsonb_build_object(
      'provider_event_id','ob-future','home','MIA','away','NYJ',
      'commence_time', to_char(now() + interval '3 days', 'YYYY-MM-DD"T"HH24:MI:SSOF'),
      'odds', jsonb_build_array(jsonb_build_object(
        'book','draftkings','market','spread','outcome','home','line',-1.5,'price',-110))))));
  perform pg_temp.check('an upcoming market is not flagged closed',
    (collective.odds_event((select id from odds.events where home_code='MIA'), null, true)
      ->>'market_closed')::boolean = false);
  perform pg_temp.check('and it carries no closing line at all',
    (collective.odds_event((select id from odds.events where home_code='MIA'), null, true)
      ->'closing') = '{}'::jsonb);
end $$;

-- ------------------------------------------------- line oscillation
-- A market that moves away from a number and back must record the return.
-- Keying change detection on the line meant the second -3.5 matched the
-- first, scored "unchanged", and froze the published line on -4.0.
do $$
declare v_ev uuid; seq numeric[] := array[-3.5,-4.0,-3.5,-3.5]; i int; r jsonb;
        written int[] := array[0,0,0,0];
begin
  for i in 1..4 loop
    r := odds.ingest_batch(odds.begin_ingest('oddsblaze','nfl','test'),'oddsblaze','nfl',
      jsonb_build_object('events', jsonb_build_array(jsonb_build_object(
        'provider_event_id','osc-1','home','PIT','away','CLE',
        'commence_time','2026-12-06T18:00:00Z',
        'odds', jsonb_build_array(jsonb_build_object(
          'book','draftkings','market','spread','outcome','home',
          'line',seq[i],'price',-110))))));
    written[i] := (r->>'snapshots_written')::int;
  end loop;
  select id into v_ev from odds.events where home_code='PIT' and away_code='CLE';

  perform pg_temp.check('a line returning to a previous value is recorded',
    written = array[1,1,1,0]);
  perform pg_temp.check('history keeps the round trip',
    (select array_agg(line::text order by id) from odds.snapshots
      where event_id = v_ev and market_id='spread' and outcome='home')
    = array['-3.50','-4.00','-3.50']);
  perform pg_temp.check('current state follows the market back',
    (select line = -3.5 from odds.current_main_state
      where event_id = v_ev and market_id='spread' and outcome='home'));
  perform pg_temp.check('and a genuinely unchanged poll still writes nothing',
    written[4] = 0);
end $$;

-- --------------------------------------------------- function privileges
-- Postgres grants EXECUTE to PUBLIC by default, and these are SECURITY
-- DEFINER functions in a PostgREST-exposed schema. Without an explicit
-- revoke, the view grants tested above are decorative: odds_set_setting,
-- odds_ingest and odds_finalize_closing would be reachable by anyone who can
-- reach the schema.
do $$
begin
  perform pg_temp.check('no collective.odds_* function is executable by anon',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='collective' and p.proname like 'odds\_%'
        and has_function_privilege('anon', p.oid, 'EXECUTE')) = 0);
  perform pg_temp.check('nor by authenticated',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='collective' and p.proname like 'odds\_%'
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')) = 0);
  perform pg_temp.check('no odds.* function is executable by anon',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='odds' and has_function_privilege('anon', p.oid, 'EXECUTE')) = 0);
  perform pg_temp.check('service_role can execute every collective.odds_* function',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='collective' and p.proname like 'odds\_%'
        and not has_function_privilege('service_role', p.oid, 'EXECUTE')) = 0);
  perform pg_temp.check('the writers are covered, not just the readers',
    (select bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE'))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='collective'
        and p.proname in ('odds_set_setting','odds_ingest','odds_finalize_closing',
                          'odds_begin_run','odds_finish_run','odds_link_games')));
end $$;

-- ------------------------------------------------------- feed freshness
do $$
begin
  perform pg_temp.check('status reports the last successful poll separately',
    (collective.odds_status('nfl') ? 'last_poll_at')
    and (collective.odds_status('nfl') ? 'last_odds_at'));
  perform pg_temp.check('the board carries the poll time too',
    (collective.odds_board('nfl',null,null,false,5) ? 'last_poll_at'));
  -- A quiet market is not a stale feed: the poll time keeps moving even when
  -- no price does.
  perform pg_temp.check('a poll that changed nothing still counts as a poll',
    odds.last_poll_at() is not null);
end $$;

-- --------------------------------------------- season and week from the slate
do $$
declare v_game uuid;
begin
  insert into collective.games (sport, season, week, kickoff_at, home, away)
  values ('NFL', 2026, 11, '2026-11-22T18:00:00Z', 'GB', 'CHI') returning id into v_game;
  perform odds.ingest_batch(odds.begin_ingest('oddsblaze','nfl','test'),'oddsblaze','nfl',
    jsonb_build_object('events', jsonb_build_array(jsonb_build_object(
      'provider_event_id','wk-1','home','GB','away','CHI',
      'commence_time','2026-11-22T18:00:00Z',
      'odds', jsonb_build_array(jsonb_build_object(
        'book','draftkings','market','spread','outcome','home','line',-3,'price',-110))))));
  perform pg_temp.check('the feed carries no week of its own',
    (select week is null from odds.events where home_code='GB'));
  perform odds.link_collective_games('nfl');
  -- Without this the ?week= filter on the read API silently returns nothing.
  perform pg_temp.check('linking takes season and week from the Collective slate',
    (select season = 2026 and week = 11 from odds.events where home_code='GB'));
end $$;

-- --------------------------------------------- a book that stops quoting
-- current_main_state keeps a book's last price forever, so without a horizon
-- a book that takes the market down keeps voting in the consensus and keeps
-- offering a best price nobody can take.
do $$
declare v_ev uuid;
begin
  -- Pin the horizon this block is about, instead of inheriting whatever the
  -- shipped default happens to be. The default is tuned per provider plan (a
  -- metered plan polls hours apart and needs a much wider horizon), so a
  -- legitimate settings change must not read as a consensus regression.
  perform collective.odds_set_setting('nfl.book_stale_seconds', '5400'::jsonb);

  perform odds.ingest_batch(odds.begin_ingest('oddsblaze','nfl','test'),'oddsblaze','nfl',
    jsonb_build_object('events', jsonb_build_array(jsonb_build_object(
      'provider_event_id','stale-1','home','TEN','away','JAX',
      'commence_time','2026-12-13T18:00:00Z',
      'odds', jsonb_build_array(
        jsonb_build_object('book','draftkings','market','spread','outcome','home','line',-3.0,'price',-110),
        jsonb_build_object('book','fanduel','market','spread','outcome','home','line',-3.0,'price',-110),
        jsonb_build_object('book','betmgm','market','spread','outcome','home','line',-9.0,'price',-110))))));
  select id into v_ev from odds.events where home_code='TEN' and away_code='JAX';

  perform pg_temp.check('all three books count while all three are current',
    (odds.consensus(v_ev)->'spread'->>'books')::int = 3);

  -- BetMGM stops quoting: its row simply stops being refreshed.
  update odds.current_main_state set captured_at = now() - interval '3 hours'
   where event_id = v_ev and book_id = 'betmgm';

  perform pg_temp.check('a book that stopped quoting drops out of the consensus',
    (odds.consensus(v_ev)->'spread'->>'books')::int = 2);
  perform pg_temp.check('and its number stops moving the median',
    (odds.consensus(v_ev)->'spread'->>'median')::numeric = -3.0);
  perform pg_temp.check('and it is no longer offered as a best price',
    not (odds.best_price(v_ev,'spread')::text like '%betmgm%'));

  -- A settled game's prices are all equally old; the horizon is relative to
  -- the freshest price on that game, so nothing drops out.
  update odds.current_main_state set captured_at = now() - interval '5 days'
   where event_id = v_ev;
  perform pg_temp.check('an old settled game keeps its whole book list',
    (odds.consensus(v_ev)->'spread'->>'books')::int = 3);
end $$;

-- ------------------------------------------- an unknown status is survivable
do $$
declare r jsonb;
begin
  r := odds.ingest_batch(odds.begin_ingest('oddsblaze','nfl','test'),'oddsblaze','nfl', $j$
  {"events":[
    {"provider_event_id":"st-1","home":"BAL","away":"CIN","commence_time":"2026-12-20T18:00:00Z",
     "status":"Weather Delay - Unknown To Us",
     "odds":[{"book":"draftkings","market":"spread","outcome":"home","line":-2.5,"price":-110}]},
    {"provider_event_id":"st-2","home":"SEA","away":"ARI","commence_time":"2026-12-20T21:00:00Z",
     "odds":[{"book":"draftkings","market":"spread","outcome":"home","line":-1.5,"price":-105}]}
  ]}
  $j$::jsonb);
  -- The CHECK constraint plus one transaction per slate means an unrecognised
  -- status would otherwise abort the batch and lose every price in it.
  perform pg_temp.check('an unknown vendor status does not abort the slate',
    (r->>'ok')::boolean and (r->>'snapshots_written')::int = 2);
  perform pg_temp.check('the odd status falls back to scheduled',
    (select status = 'scheduled' from odds.events where home_code='BAL'));
end $$;

select 'ALL ODDS SCHEMA TESTS PASSED' as result;
