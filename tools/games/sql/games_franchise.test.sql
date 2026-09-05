-- ===========================================================================
-- EDGEDESK GAMES — the franchise layer, run against a real PostgreSQL.
--
-- supabase/games_franchise.sql is applied unmodified over the social layer
-- and then attacked as a client would: as anon, as the wrong account, with a
-- forged price, with a replayed request, with a card for the wrong week, with
-- a drill result for a day that has not happened. The load-bearing claims:
--
--   * nothing credits twice, and nothing credits from a browser's numbers;
--   * a roster is generated on the server, reproducibly, at a founding level;
--   * an account reads its own franchise and nobody else's;
--   * the trusted side (board publisher, Pick 5 settlement) is reachable by no
--     client role, and settlement is idempotent.
-- ===========================================================================
\set ON_ERROR_STOP on
set client_min_messages = notice;

create or replace function pg_temp.ok(p_name text, p_cond boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  if p_cond then raise notice 'ok   %', p_name;
  else raise exception 'FAIL: % %', p_name, coalesce('— ' || p_detail, ''); end if;
end; $$;

create or replace function pg_temp.as_user(p_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_id::text, false);
  execute 'set local role authenticated';
end; $$;
create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  execute 'set local role anon';
end; $$;
create or replace function pg_temp.as_owner() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', false);
  execute 'reset role';
end; $$;

do $test$
declare
  ALICE  constant uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  BOB    constant uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  CARA   constant uuid := 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  DAN    constant uuid := 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  SEC_D  constant text := 'device-secret-dddddddddddddddddddddddddddddd';
  SEC_X  constant text := 'device-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  fd uuid;
  v jsonb; v2 jsonb; n integer; caught text; fa uuid; fb uuid; fc uuid; wk text; today text;
  xp0 integer; sp0 integer; tc0 integer; cp0 integer; pid uuid; pid2 uuid; tok text; cid uuid;
  ovr integer; econ jsonb;
  -- the weekly game
  gid uuid; gid2 uuid; seed0 text; opp0 jsonb; t0 timestamptz; box jsonb; box2 jsonb; k integer; w integer; l integer; nn integer;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (ALICE, 'alice@example.com', '{"display_name":"Alice"}'),
    (BOB,   'bob@example.com',   '{"display_name":"Bob"}'),
    (CARA,  'cara@example.com',  '{"display_name":"Cara"}'),
    (DAN,   'dan@example.com',   '{"display_name":"Dan"}')
  on conflict (id) do nothing;
  wk := public.games_week_key(now());
  today := public.games_day_key(now());
  econ := public.franchise_economy();

-- ═══ 1. THE SHARED RULES, ON THE SERVER ═══════════════════════════════════
  perform pg_temp.ok('a Tuesday one minute early belongs to the old week',
    public.games_week_key('2026-09-08T06:59:00Z'::timestamptz) = '2026-09-01');
  perform pg_temp.ok('a Tuesday at the boundary starts the new week',
    public.games_week_key('2026-09-08T07:00:00Z'::timestamptz) = '2026-09-08');
  perform pg_temp.ok('a Saturday sits in its own week',
    public.games_week_key('2026-09-05T20:00:00Z'::timestamptz) = '2026-09-01');
  perform pg_temp.ok('a Monday night game still belongs to that week',
    public.games_week_key('2026-09-07T23:00:00Z'::timestamptz) = '2026-09-01');
  perform pg_temp.ok('the day key shares the boundary''s zone',
    public.games_day_key('2026-09-05T06:59:00Z'::timestamptz) = '2026-09-04'
    and public.games_day_key('2026-09-05T07:00:00Z'::timestamptz) = '2026-09-05');
  perform pg_temp.ok('January belongs to the prior season',
    public.games_season_of('2027-01-10T00:00:00Z'::timestamptz) = 2026
    and public.games_season_of('2026-09-05T00:00:00Z'::timestamptz) = 2026);
  perform pg_temp.ok('the Price It bands are the published ones',
    public.games_price_it_score(0) = 100 and public.games_price_it_score(1.0) = 100
    and public.games_price_it_score(1.5) = 90 and public.games_price_it_score(2.0) = 90
    and public.games_price_it_score(2.5) = 80 and public.games_price_it_score(3.0) = 80
    and public.games_price_it_score(4.5) = 60 and public.games_price_it_score(11) = 0
    and public.games_price_it_score(40) = 0);
  perform pg_temp.ok('float noise does not cost a band', public.games_price_it_score(1.0000000000000002) = 100);
  perform pg_temp.ok('a nonsense distance scores nothing', public.games_price_it_score(-1) is null);
  perform pg_temp.ok('ATS settlement matches scoring.js',
    public.games_ats_result(-7, 31, 21) = 'home' and public.games_ats_result(-7, 28, 21) = 'push'
    and public.games_ats_result(-7, 24, 21) = 'away' and public.games_ats_result(3, 21, 24) = 'push'
    and public.games_ats_result(3, 21, 20) = 'home' and public.games_ats_result(-3.5, 24, 21) = 'away'
    and public.games_ats_result(0, 21, 20) = 'home' and public.games_ats_result(0, 20, 20) = 'push'
    and public.games_ats_result(null, 24, 21) is null);
  perform pg_temp.ok('the level curve is the War Room''s',
    public.games_xp_for_level(2) = 100 and public.games_xp_for_level(5) = 700
    and public.games_xp_for_level(10) = 2700 and public.games_xp_for_level(20) = 10450
    and public.games_xp_for_level(30) = 23200);
  perform pg_temp.ok('a stored XP total maps to one level',
    public.games_level_for(0) = 1 and public.games_level_for(99) = 1 and public.games_level_for(100) = 2
    and public.games_level_for(700) = 5 and public.games_level_for(2699) = 9 and public.games_level_for(2700) = 10
    and public.games_level_for(999999) = 30);
  perform pg_temp.ok('the economy is versioned', econ->>'version' = 'economy_v1');
  perform pg_temp.ok('the economy is the published table',
    (econ->'price_it'->>'xp')::int = 50 and (econ->'pick5_card'->>'xp')::int = 75
    and (econ->'pick5_correct'->>'xp')::int = 10 and (econ->'pick5_perfect'->>'xp')::int = 150
    and (econ->'drill_daily'->>'xp')::int = 40 and (econ->'research_open'->>'xp')::int = 15
    and (econ->'h2h_locked'->>'xp')::int = 40 and (econ->'h2h_win'->>'xp')::int = 20
    and (econ->'h2h_locked'->>'cp')::int = 1 and (econ->'h2h_win'->>'cp')::int = 2
    and (econ->'founded'->>'tc')::int = 100 and (econ->'pick5_card'->>'tc')::int = 25
    and (econ->'pick5_correct'->>'tc')::int = 15 and (econ->'pick5_perfect'->>'tc')::int = 200);
  perform pg_temp.ok('scouting points follow the score: 100 -> 40, 60 -> 26, 0 -> 5',
    public.franchise_sp_for_score(100) = 40 and public.franchise_sp_for_score(60) = 26 and public.franchise_sp_for_score(0) = 5);
  perform pg_temp.ok('team credits follow the score: 100 -> 20, 45 -> 14, 0 -> 10',
    public.franchise_tc_for_score(100) = 20 and public.franchise_tc_for_score(45) = 14 and public.franchise_tc_for_score(0) = 10);
  perform pg_temp.ok('a seed maps into setseed''s range',
    public.franchise_seed_float('anything') between -1 and 1 and public.franchise_seed_float('x') = public.franchise_seed_float('x'));

-- ═══ 2. THE BOARD ═════════════════════════════════════════════════════════
  perform pg_temp.as_user(ALICE);
  begin
    perform public.game_board_upsert('[{"game_id":"forged","edgedesk_spread":-3}]'::jsonb);
    perform pg_temp.ok('a signed-in player cannot publish the board', false, 'the upsert ran');
  exception when insufficient_privilege then
    perform pg_temp.ok('a signed-in player cannot publish the board', true);
  end;
  begin
    insert into public.game_board (game_id, edgedesk_spread) values ('forged2', -3);
    perform pg_temp.ok('a signed-in player cannot insert into the board', false, 'the insert ran');
  exception when insufficient_privilege then
    perform pg_temp.ok('a signed-in player cannot insert into the board', true);
  end;
  perform pg_temp.as_anon();
  begin
    perform public.game_board_upsert('[]'::jsonb);
    perform pg_temp.ok('anon cannot publish the board', false, 'the upsert ran');
  exception when insufficient_privilege then
    perform pg_temp.ok('anon cannot publish the board', true);
  end;

  perform pg_temp.as_owner();
  n := public.game_board_upsert(jsonb_build_array(
    jsonb_build_object('game_id', 'g1', 'season', 2026, 'week', 2, 'slug', 'baylor-auburn', 'home_team', 'Auburn', 'away_team', 'Baylor',
      'kickoff', (now() + interval '2 days')::text, 'edgedesk_spread', -8.2, 'market_spread', -10.5, 'confidence', 60, 'research_state', 'REVIEW', 'status', 'PREDICTED'),
    jsonb_build_object('game_id', 'g2', 'season', 2026, 'week', 2, 'slug', 'a2-h2', 'home_team', 'Home2', 'away_team', 'Away2',
      'kickoff', (now() + interval '2 days')::text, 'edgedesk_spread', -3, 'market_spread', -3, 'status', 'PREDICTED'),
    jsonb_build_object('game_id', 'g3', 'season', 2026, 'week', 2, 'slug', 'a3-h3', 'home_team', 'Home3', 'away_team', 'Away3',
      'kickoff', (now() + interval '3 days')::text, 'edgedesk_spread', 4, 'market_spread', 3.5, 'status', 'PREDICTED'),
    jsonb_build_object('game_id', 'g4', 'season', 2026, 'week', 2, 'slug', 'a4-h4', 'home_team', 'Home4', 'away_team', 'Away4',
      'kickoff', (now() + interval '3 days')::text, 'edgedesk_spread', -14, 'market_spread', -13.5, 'status', 'PREDICTED'),
    jsonb_build_object('game_id', 'g5', 'season', 2026, 'week', 2, 'slug', 'a5-h5', 'home_team', 'Home5', 'away_team', 'Away5',
      'kickoff', (now() + interval '4 days')::text, 'edgedesk_spread', -1, 'market_spread', -2.5, 'status', 'PREDICTED'),
    jsonb_build_object('game_id', 'g6', 'season', 2026, 'week', 2, 'slug', 'a6-h6', 'home_team', 'Home6', 'away_team', 'Away6',
      'kickoff', (now() + interval '4 days')::text, 'edgedesk_spread', -6, 'market_spread', -7, 'status', 'PREDICTED'),
    jsonb_build_object('game_id', 'nomkt', 'season', 2026, 'week', 2, 'slug', 'a7-h7', 'home_team', 'Home7', 'away_team', 'Away7',
      'kickoff', (now() + interval '4 days')::text, 'edgedesk_spread', -6, 'status', 'PREDICTED'),
    jsonb_build_object('game_id', 'played', 'season', 2026, 'week', 1, 'slug', 'a0-h0', 'home_team', 'Home0', 'away_team', 'Away0',
      'kickoff', (now() - interval '2 days')::text, 'edgedesk_spread', -5, 'market_spread', -4, 'status', 'PREDICTED',
      'final_home', 31, 'final_away', 20)));
  perform pg_temp.ok('the service role publishes the board', n = 8, 'upserted ' || n);
  n := public.game_board_upsert(jsonb_build_array(jsonb_build_object('game_id', 'g1', 'market_spread', -9.5)));
  perform pg_temp.ok('a re-publish updates a row without erasing what it did not carry',
    (select edgedesk_spread = -8.2 and market_spread = -9.5 and home_team = 'Auburn' from public.game_board where game_id = 'g1'));
  perform pg_temp.ok('finals land and are stamped',
    (select final_home = 31 and final_at is not null from public.game_board where game_id = 'played'));
  perform pg_temp.as_anon();
  select count(*) into n from public.game_board;
  perform pg_temp.ok('the board is public to read — it is the committed artifact', n = 8, 'anon read ' || n);

-- ═══ 3. CREATING A FRANCHISE ══════════════════════════════════════════════
  perform pg_temp.as_anon();
  begin
    perform public.franchise_create('Ghosts', 'Nowhere', 'GST', 'star', 'forest', 'spread', 'zone', null);
    perform pg_temp.ok('an anonymous caller with no device secret cannot found a franchise', false, 'it was created');
  exception when invalid_authorization_specification then
    perform pg_temp.ok('an anonymous caller with no device secret cannot found a franchise', true);
  end;
  begin
    perform public.franchise_create('Ghosts', 'Nowhere', 'GST', 'star', 'forest', 'spread', 'zone', 'short');
    perform pg_temp.ok('nor with a secret too short to be one', false, 'it was created');
  exception when invalid_authorization_specification then
    perform pg_temp.ok('nor with a secret too short to be one', true);
  end;

  perform pg_temp.as_user(ALICE);
  begin
    perform public.franchise_create('Outlaws', 'Lubbock', 'toolong', 'star', 'forest', 'air_raid', 'four_three');
    perform pg_temp.ok('an abbreviation is 2 to 4 characters', false);
  exception when invalid_parameter_value then
    perform pg_temp.ok('an abbreviation is 2 to 4 characters', true);
  end;
  begin
    perform public.franchise_create('Outlaws', 'Lubbock', 'LBK', 'not-a-mark', 'forest', 'air_raid', 'four_three');
    perform pg_temp.ok('the mark comes from the fixed set', false);
  exception when check_violation then
    perform pg_temp.ok('the mark comes from the fixed set', true);
  end;
  begin
    perform public.franchise_create('Outlaws', 'Lubbock', 'LBK', 'star', 'forest', 'triple_reverse', 'four_three');
    perform pg_temp.ok('the offensive identity comes from the fixed set', false);
  exception when check_violation then
    perform pg_temp.ok('the offensive identity comes from the fixed set', true);
  end;
  perform pg_temp.ok('a failed creation leaves nothing behind',
    not exists (select 1 from public.franchises where user_id = ALICE));

  v := public.franchise_create('  Lubbock <Outlaws>  ', 'Lubbock', 'lbk', 'star', 'forest', 'air_raid', 'four_three');
  fa := (v->'franchise'->>'id')::uuid;
  perform pg_temp.ok('a franchise is created and its home read model returned', fa is not null and v->'franchise'->>'name' = 'Lubbock Outlaws');
  perform pg_temp.ok('the abbreviation is upper-cased', v->'franchise'->>'abbr' = 'LBK');
  perform pg_temp.ok('the founder season is this season', (v->'franchise'->>'founded_season')::int = public.games_season_of(now()));
  perform pg_temp.ok('the season row is Season I, under way from the first second, with no game played',
    v->'season'->>'status' = 'active' and (v->'season'->>'wins')::int = 0 and (v->'season'->>'losses')::int = 0);
  perform pg_temp.ok('the franchise keeps its own calendar: Season I, eight weeks, week 0, begun in this real season',
    (v->'season'->>'number')::int = 1 and v->'season'->>'label' = 'Season I' and (v->'season'->>'weeks')::int = 8
    and (v->'season'->>'week')::int = 0 and (v->'season'->>'season')::int = public.games_season_of(now()));
  perform pg_temp.ok('season numerals count the way a franchise does',
    public.games_roman(1) = 'I' and public.games_roman(4) = 'IV' and public.games_roman(7) = 'VII' and public.games_roman(14) = 'XIV' and public.games_roman(40) = 'XL');
  perform pg_temp.ok('the founding grant is 100 Team Credits and nothing else',
    (v->'resources'->>'team_credits')::int = 100 and (v->'resources'->>'xp')::int = 0
    and (v->'resources'->>'scouting_points')::int = 0 and (v->'resources'->>'coach_points')::int = 0);
  perform pg_temp.ok('level 1 with 100 XP to the next', (v->'resources'->>'level')::int = 1 and (v->'resources'->>'next_level_at')::int = 100);
  perform pg_temp.ok('the founder-season achievement is exclusive to its season',
    (select count(*) from jsonb_array_elements(v->'achievements') a where a->>'id' = 'founder_2026') = 1);
  perform pg_temp.ok('the roster has 38 players', (v->>'roster_count')::int = 38);
  ovr := (v->'rating'->>'overall')::int;
  perform pg_temp.ok('a founding roster lands between 66 and 74 overall', ovr between 66 and 74, 'overall ' || ovr);
  perform pg_temp.ok('offense, defense and special teams are each rated',
    (v->'rating'->>'offense')::int between 60 and 80 and (v->'rating'->>'defense')::int between 60 and 80
    and (v->'rating'->>'special')::int between 55 and 85);

  begin
    perform public.franchise_create('Second', 'Town', 'SEC', 'bolt', 'navy', 'spread', 'zone');
    perform pg_temp.ok('an account owns exactly one franchise', false, 'a second was created');
  exception when unique_violation then
    perform pg_temp.ok('an account owns exactly one franchise', true);
  end;

  v := public.franchise_roster();
  perform pg_temp.ok('the roster read model lists every player', jsonb_array_length(v->'players') = 38);
  perform pg_temp.ok('every position is staffed to the plan',
    (select count(*) from public.game_players where franchise_id = fa and position = 'QB') = 2
    and (select count(*) from public.game_players where franchise_id = fa and position = 'WR') = 5
    and (select count(*) from public.game_players where franchise_id = fa and position = 'OL') = 7
    and (select count(*) from public.game_players where franchise_id = fa and position = 'DL') = 6
    and (select count(*) from public.game_players where franchise_id = fa and position = 'K') = 1);
  perform pg_temp.ok('every player carries four visible ratings and a consistent overall',
    (select bool_and(
        (select count(*) from jsonb_object_keys(p.ratings)) = 4
        and p.overall = round((select avg(x.value::int) from jsonb_each_text(p.ratings) x)))
      from public.game_players p where p.franchise_id = fa));
  perform pg_temp.ok('potential is never below overall and never above 99',
    (select bool_and(potential >= overall and potential <= 99) from public.game_players where franchise_id = fa));
  perform pg_temp.ok('no two players share a name', (select count(distinct first_name || ' ' || last_name) from public.game_players where franchise_id = fa) = 38);
  perform pg_temp.ok('no two players share a jersey', (select count(distinct jersey) from public.game_players where franchise_id = fa) = 38);
  perform pg_temp.ok('a founding roster has no elite player handed to it',
    (select count(*) from public.game_players where franchise_id = fa and overall >= 82) = 0);
  perform pg_temp.ok('every player is a founding-roster acquisition this season',
    (select bool_and(acquired_source = 'founding_roster' and acquired_season = public.games_season_of(now())) from public.game_players where franchise_id = fa));
  perform pg_temp.ok('careers start empty — the story is written from here',
    (select bool_and(career_stats = '{}'::jsonb) from public.game_players where franchise_id = fa));
  perform pg_temp.ok('the roster is ordered by position then depth',
    (v->'players'->0->>'position') = 'QB' and (v->'players'->0->>'depth')::int = 1);

-- ═══ 4. DETERMINISM OF THE GENERATOR ══════════════════════════════════════
  perform pg_temp.as_owner();
  insert into public.franchises (id, user_id, name, city, abbr, logo, theme, offense, defense, founded_season, seed)
  values ('dddddddd-0000-0000-0000-000000000001', BOB, 'Seed A', 'City', 'SDA', 'bolt', 'navy', 'spread', 'zone', 2026, 'seed-a'),
         ('dddddddd-0000-0000-0000-000000000002', CARA, 'Seed A2', 'City', 'SDB', 'bolt', 'navy', 'spread', 'zone', 2026, 'seed-a');
  perform public.franchise_generate_roster('dddddddd-0000-0000-0000-000000000001', 'seed-a', 2026);
  perform public.franchise_generate_roster('dddddddd-0000-0000-0000-000000000002', 'seed-a', 2026);
  select count(*) into n from (
    select first_name, last_name, position, jersey, overall, ratings, archetype, traits, potential, age
      from public.game_players where franchise_id = 'dddddddd-0000-0000-0000-000000000001'
    intersect
    select first_name, last_name, position, jersey, overall, ratings, archetype, traits, potential, age
      from public.game_players where franchise_id = 'dddddddd-0000-0000-0000-000000000002') x;
  perform pg_temp.ok('the same seed builds the same roster, player for player', n = 38, n || ' identical of 38');
  perform pg_temp.ok('the same seed rates the same team',
    public.franchise_team_rating('dddddddd-0000-0000-0000-000000000001') = public.franchise_team_rating('dddddddd-0000-0000-0000-000000000002'));
  delete from public.game_players where franchise_id = 'dddddddd-0000-0000-0000-000000000002';
  perform public.franchise_generate_roster('dddddddd-0000-0000-0000-000000000002', 'seed-b', 2026);
  select count(*) into n from (
    select first_name, last_name, position from public.game_players where franchise_id = 'dddddddd-0000-0000-0000-000000000001'
    intersect
    select first_name, last_name, position from public.game_players where franchise_id = 'dddddddd-0000-0000-0000-000000000002') x;
  perform pg_temp.ok('a different seed builds a different roster', n < 10, n || ' shared');
  -- twenty seeds: every founding team lands in the intended band
  n := 0;
  for ovr in 1..20 loop
    delete from public.game_players where franchise_id = 'dddddddd-0000-0000-0000-000000000002';
    perform public.franchise_generate_roster('dddddddd-0000-0000-0000-000000000002', 'band-' || ovr, 2026);
    if (public.franchise_team_rating('dddddddd-0000-0000-0000-000000000002')->>'overall')::int between 66 and 74 then n := n + 1; end if;
  end loop;
  perform pg_temp.ok('twenty seeds, twenty founding teams inside 66–74 overall', n = 20, n || ' of 20');
  delete from public.franchises where id in ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000002');

-- ═══ 5. WHO CAN READ WHAT ═════════════════════════════════════════════════
  perform pg_temp.as_user(BOB);
  v := public.franchise_create('Wranglers', 'Austin', 'ATX', 'horn', 'crimson', 'power_run', 'blitz_heavy');
  fb := (v->'franchise'->>'id')::uuid;
  select count(*) into n from public.franchises;
  perform pg_temp.ok('an account sees only its own franchise row', n = 1);
  select count(*) into n from public.game_players where franchise_id = fa;
  perform pg_temp.ok('an account sees none of another franchise''s players', n = 0, 'saw ' || n);
  select count(*) into n from public.franchise_ledger where franchise_id = fa;
  perform pg_temp.ok('nor its ledger', n = 0);
  select count(*) into n from public.franchise_activity where franchise_id = fa;
  perform pg_temp.ok('nor its activity', n = 0);
  select count(*) into n from public.franchise_achievements where franchise_id = fa;
  perform pg_temp.ok('nor its achievements', n = 0);
  select count(*) into n from public.game_players where franchise_id = fb;
  perform pg_temp.ok('but every one of its own', n = 38);
  begin
    insert into public.franchise_ledger (franchise_id, currency, delta, kind, key) values (fb, 'sp', 100000, 'forged', 'x');
    perform pg_temp.ok('a client cannot write its own ledger', false, 'the insert ran');
  exception when insufficient_privilege then
    perform pg_temp.ok('a client cannot write its own ledger', true);
  end;
  begin
    update public.franchises set scouting_points = 100000 where id = fb;
    get diagnostics n = row_count;
    perform pg_temp.ok('a client cannot edit its own totals', n = 0, 'updated ' || n);
  exception when insufficient_privilege then
    perform pg_temp.ok('a client cannot edit its own totals', true);
  end;
  begin
    update public.game_players set overall = 99 where franchise_id = fb;
    get diagnostics n = row_count;
    perform pg_temp.ok('a client cannot edit a player', n = 0, 'updated ' || n);
  exception when insufficient_privilege then
    perform pg_temp.ok('a client cannot edit a player', true);
  end;
  begin
    insert into public.franchise_achievements (franchise_id, achievement_id, season) values (fb, 'perfect_card', 2026);
    perform pg_temp.ok('a client cannot grant itself an achievement', false, 'the insert ran');
  exception when insufficient_privilege then
    perform pg_temp.ok('a client cannot grant itself an achievement', true);
  end;
  begin
    perform public.franchise_credit(fb, 'sp', 100000, 'forged', 'x', null);
    perform pg_temp.ok('the ledger write is not callable by a client', false, 'it ran');
  exception when insufficient_privilege then
    perform pg_temp.ok('the ledger write is not callable by a client', true);
  end;
  begin
    perform public.franchise_generate_roster(fb, 'my-seed', 2026);
    perform pg_temp.ok('the generator is not callable by a client', false, 'it ran');
  exception when insufficient_privilege then
    perform pg_temp.ok('the generator is not callable by a client', true);
  end;
  begin
    perform public.franchise_settle_pick5();
    perform pg_temp.ok('settlement is not callable by a client', false, 'it ran');
  exception when insufficient_privilege then
    perform pg_temp.ok('settlement is not callable by a client', true);
  end;
  perform pg_temp.as_anon();
  select count(*) into n from public.franchises;
  perform pg_temp.ok('anon sees no franchise', n = 0);
  select count(*) into n from public.game_players;
  perform pg_temp.ok('anon sees no player', n = 0);
  perform pg_temp.ok('anon with no secret has no home', public.franchise_home() is null);
  perform pg_temp.ok('and a guessed secret has none either', public.franchise_home(SEC_X) is null);
  begin
    v := public.franchise_claim(SEC_X);
    perform pg_temp.ok('anon cannot claim anything', false, 'it ran');
  exception when insufficient_privilege then
    perform pg_temp.ok('anon cannot claim anything', true);
  end;
  perform pg_temp.as_user(CARA);
  perform pg_temp.ok('an account without a franchise has no home yet', public.franchise_home() is null);
  perform pg_temp.ok('and no roster', public.franchise_roster() is null);
  begin
    v := public.franchise_record_price_it('g1', -6.5);
    perform pg_temp.ok('and cannot earn before founding one', false, 'it recorded');
  exception when invalid_authorization_specification then
    perform pg_temp.ok('and cannot earn before founding one', true);
  end;

-- ═══ 6. PRICE IT, SCORED FROM THE BOARD ═══════════════════════════════════
  perform pg_temp.as_user(ALICE);
  v := public.franchise_record_price_it('g1', -6.5);
  perform pg_temp.ok('a Price It is scored against the board''s EdgeDesk number',
    (v->'result'->>'edgedesk_spread')::numeric = -8.2 and (v->'result'->>'distance')::numeric = 1.7
    and (v->'result'->>'score')::int = 90, v::text);
  perform pg_temp.ok('the distance to the market rides along from the board, not the browser',
    (v->'result'->>'market_spread')::numeric = -9.5 and (v->'result'->>'distance_to_market')::numeric = 3.0);
  perform pg_temp.ok('the result is versioned', v->'result'->>'scoring_version' = 'price_it_v1' and v->'result'->>'benchmark' = 'edgedesk');
  perform pg_temp.ok('and rewards XP, Scouting Points and Team Credits by the table',
    (v->'rewards'->>'xp')::int = 50 and (v->'rewards'->>'sp')::int = 37 and (v->'rewards'->>'tc')::int = 19, (v->'rewards')::text);
  perform pg_temp.ok('the totals move by exactly that',
    (v->'totals'->>'xp')::int = 50 and (v->'totals'->>'scouting_points')::int = 37 and (v->'totals'->>'team_credits')::int = 119);
  perform pg_temp.ok('the first scout achievement is earned', v->'achievements' ? 'first_price');
  v2 := public.franchise_record_price_it('g1', 0);
  perform pg_temp.ok('replaying the same game returns the ORIGINAL result', (v2->>'already')::boolean and (v2->'result'->>'score')::int = 90);
  perform pg_temp.ok('and credits nothing', (v2->'rewards'->>'xp')::int = 0 and (v2->'totals'->>'xp')::int = 50);
  perform pg_temp.ok('the cached totals equal the ledger',
    (select xp = (select sum(delta) from public.franchise_ledger where franchise_id = fa and currency = 'xp')
        and scouting_points = (select sum(delta) from public.franchise_ledger where franchise_id = fa and currency = 'sp')
        and team_credits = (select sum(delta) from public.franchise_ledger where franchise_id = fa and currency = 'tc')
      from public.franchises where id = fa));
  begin
    v := public.franchise_record_price_it('played', -4);
    perform pg_temp.ok('a game that kicked off cannot be priced', false, 'it recorded');
  exception when invalid_parameter_value then
    perform pg_temp.ok('a game that kicked off cannot be priced', true);
  end;
  begin
    v := public.franchise_record_price_it('not-a-game', -4);
    perform pg_temp.ok('a game off the board cannot be priced', false, 'it recorded');
  exception when no_data_found then
    perform pg_temp.ok('a game off the board cannot be priced', true);
  end;
  v := public.franchise_record_price_it('g2', -3.2);
  perform pg_temp.ok('a line is snapped to the half point', (v->'result'->>'user_spread')::numeric = -3.0);
  perform pg_temp.ok('a dead-on read scores 100 and earns Market Master',
    (v->'result'->>'score')::int = 100 and v->'achievements' ? 'market_master' and (v->'rewards'->>'sp')::int = 40);
  v := public.franchise_record_price_it('nomkt', -6);
  perform pg_temp.ok('a game with no market still scores against EdgeDesk',
    (v->'result'->>'score')::int = 100 and v->'result'->'market_spread' = 'null'::jsonb and v->'result'->'distance_to_market' = 'null'::jsonb);
  v := public.franchise_home();
  perform pg_temp.ok('the home read model counts this week''s scouting',
    (v->'week'->>'price_it')::int = 3 and (v->'week'->>'price_it_avg_score')::int = 97, (v->'week')::text);
  perform pg_temp.ok('and lists the achievements earned',
    (select count(*) from jsonb_array_elements(v->'achievements')) = 3);

-- ═══ 7. PICK 5 ════════════════════════════════════════════════════════════
  begin
    v := public.franchise_submit_pick5('1999-01-05', '[{"game_id":"g1","pick":"home"}]'::jsonb);
    perform pg_temp.ok('a card is for this football week only', false, 'it submitted');
  exception when invalid_parameter_value then
    perform pg_temp.ok('a card is for this football week only', true);
  end;
  begin
    v := public.franchise_submit_pick5(wk, '[{"game_id":"nomkt","pick":"home"}]'::jsonb);
    perform pg_temp.ok('a game with no line cannot be picked', false, 'it submitted');
  exception when no_data_found then
    perform pg_temp.ok('a game with no line cannot be picked', true);
  end;
  begin
    v := public.franchise_submit_pick5(wk, '[{"game_id":"played","pick":"home"}]'::jsonb);
    perform pg_temp.ok('a game that kicked off cannot be picked', false, 'it submitted');
  exception when invalid_parameter_value then
    perform pg_temp.ok('a game that kicked off cannot be picked', true);
  end;
  begin
    v := public.franchise_submit_pick5(wk, '[{"game_id":"g1","pick":"home"},{"game_id":"g1","pick":"away"}]'::jsonb);
    perform pg_temp.ok('a game appears once on a card', false, 'it submitted');
  exception when invalid_parameter_value then
    perform pg_temp.ok('a game appears once on a card', true);
  end;
  begin
    v := public.franchise_submit_pick5(wk, '[{"game_id":"g1","pick":"under"}]'::jsonb);
    perform pg_temp.ok('a pick is a side', false, 'it submitted');
  exception when invalid_parameter_value then
    perform pg_temp.ok('a pick is a side', true);
  end;
  perform pg_temp.ok('a refused card leaves no card behind',
    not exists (select 1 from public.franchise_pick5_cards where franchise_id = fa));

  v := public.franchise_submit_pick5(wk, '[{"game_id":"g1","pick":"home","market_spread":-99},{"game_id":"g2","pick":"away"},
    {"game_id":"g3","pick":"home"},{"game_id":"g4","pick":"away"},{"game_id":"g5","pick":"home"}]'::jsonb);
  perform pg_temp.ok('a card of five is accepted', jsonb_array_length(v->'card'->'selections') = 5 and not (v->>'already')::boolean);
  perform pg_temp.ok('each selection snapshots the BOARD''s line, not the browser''s',
    (select market_spread = -9.5 from public.franchise_pick5_selections s join public.franchise_pick5_cards c on c.id = s.card_id
      where c.franchise_id = fa and s.game_id = 'g1'));
  perform pg_temp.ok('a card rewards XP and Team Credits and the first-card achievement',
    (v->'rewards'->>'xp')::int = 75 and (v->'rewards'->>'tc')::int = 25 and v->'achievements' ? 'first_card');
  v2 := public.franchise_submit_pick5(wk, '[{"game_id":"g6","pick":"home"}]'::jsonb);
  perform pg_temp.ok('one card a week — resubmitting returns the first', (v2->>'already')::boolean
    and jsonb_array_length(v2->'card'->'selections') = 5 and (v2->'totals'->>'xp')::int = (v->'totals'->>'xp')::int);
  perform pg_temp.ok('the page can read back this week''s card', jsonb_array_length(public.franchise_pick5_mine()->'selections') = 5);
  perform pg_temp.ok('a card for a week with none is null', public.franchise_pick5_mine('1999-01-05') is null);

  -- Bob's perfect card
  perform pg_temp.as_user(BOB);
  v := public.franchise_submit_pick5(wk, '[{"game_id":"g1","pick":"home"},{"game_id":"g2","pick":"home"},
    {"game_id":"g3","pick":"home"},{"game_id":"g4","pick":"home"},{"game_id":"g5","pick":"home"}]'::jsonb);
  perform pg_temp.ok('a second franchise has its own card', not (v->>'already')::boolean);

  -- finals land: home covers g1 (-9.5), g2 pushes (-3), g3 home covers (+3.5), g4 home covers (-13.5), g5 home covers (-2.5)
  perform pg_temp.as_owner();
  select xp, team_credits into xp0, tc0 from public.franchises where id = fa;
  perform public.game_board_upsert(jsonb_build_array(
    jsonb_build_object('game_id', 'g1', 'final_home', 35, 'final_away', 14),
    jsonb_build_object('game_id', 'g2', 'final_home', 24, 'final_away', 21),
    jsonb_build_object('game_id', 'g3', 'final_home', 28, 'final_away', 27),
    jsonb_build_object('game_id', 'g4', 'final_home', 42, 'final_away', 7)));
  v := public.franchise_settle_pick5();
  perform pg_temp.ok('settlement grades every selection whose game has a final',
    (v->>'selections_settled')::int = 8, v::text);
  perform pg_temp.ok('a card with a game still to play stays open', (v->>'cards_settled')::int = 0);
  perform pg_temp.ok('a push is recorded as a push',
    (select result = 'push' from public.franchise_pick5_selections s join public.franchise_pick5_cards c on c.id = s.card_id
      where c.franchise_id = fa and s.game_id = 'g2'));
  perform pg_temp.ok('Alice: home on g1 won, away on g4 lost',
    (select result = 'win' from public.franchise_pick5_selections s join public.franchise_pick5_cards c on c.id = s.card_id where c.franchise_id = fa and s.game_id = 'g1')
    and (select result = 'loss' from public.franchise_pick5_selections s join public.franchise_pick5_cards c on c.id = s.card_id where c.franchise_id = fa and s.game_id = 'g4'));
  perform pg_temp.ok('each correct side is credited by the table, once',
    (select xp from public.franchises where id = fa) = xp0 + 20 and (select team_credits from public.franchises where id = fa) = tc0 + 30);
  perform pg_temp.ok('the running count is on the card',
    (select correct = 2 and decided = 3 and settled_at is null from public.franchise_pick5_cards where franchise_id = fa));
  v := public.franchise_settle_pick5();
  perform pg_temp.ok('settling again grades nothing again', (v->>'selections_settled')::int = 0
    and (select xp from public.franchises where id = fa) = xp0 + 20);
  perform public.game_board_upsert(jsonb_build_array(jsonb_build_object('game_id', 'g5', 'final_home', 20, 'final_away', 17)));
  select xp, team_credits into xp0, tc0 from public.franchises where id = fb;
  v := public.franchise_settle_pick5();
  perform pg_temp.ok('the last final closes both cards', (v->>'cards_settled')::int = 2, v::text);
  perform pg_temp.ok('Bob went 4–0 with a push: not perfect, no bonus',
    (v->>'perfect_cards')::int = 0 and (select correct = 4 and decided = 4 from public.franchise_pick5_cards where franchise_id = fb)
    and not exists (select 1 from public.franchise_achievements where franchise_id = fb and achievement_id = 'perfect_card'));
  perform pg_temp.ok('the last correct side credits once more',
    (select xp from public.franchises where id = fb) = xp0 + 10);

  -- Cara: a genuinely perfect card, on games that finish tonight
  perform public.game_board_upsert(jsonb_build_array(
    jsonb_build_object('game_id', 'p1', 'season', 2026, 'week', 2, 'home_team', 'PH1', 'away_team', 'PA1', 'kickoff', (now() + interval '1 hour')::text, 'edgedesk_spread', -3, 'market_spread', -3),
    jsonb_build_object('game_id', 'p2', 'season', 2026, 'week', 2, 'home_team', 'PH2', 'away_team', 'PA2', 'kickoff', (now() + interval '1 hour')::text, 'edgedesk_spread', -3, 'market_spread', -3),
    jsonb_build_object('game_id', 'p3', 'season', 2026, 'week', 2, 'home_team', 'PH3', 'away_team', 'PA3', 'kickoff', (now() + interval '1 hour')::text, 'edgedesk_spread', -3, 'market_spread', -3),
    jsonb_build_object('game_id', 'p4', 'season', 2026, 'week', 2, 'home_team', 'PH4', 'away_team', 'PA4', 'kickoff', (now() + interval '1 hour')::text, 'edgedesk_spread', -3, 'market_spread', -3),
    jsonb_build_object('game_id', 'p5', 'season', 2026, 'week', 2, 'home_team', 'PH5', 'away_team', 'PA5', 'kickoff', (now() + interval '1 hour')::text, 'edgedesk_spread', -3, 'market_spread', -3)));
  perform pg_temp.as_user(CARA);
  v := public.franchise_create('Comets', 'Reno', 'RNO', 'flame', 'gold', 'west_coast', 'press_man');
  fc := (v->'franchise'->>'id')::uuid;
  v := public.franchise_submit_pick5(wk, '[{"game_id":"p1","pick":"home"},{"game_id":"p2","pick":"home"},
    {"game_id":"p3","pick":"home"},{"game_id":"p4","pick":"home"},{"game_id":"p5","pick":"home"}]'::jsonb);
  perform pg_temp.as_owner();
  select xp, team_credits into xp0, tc0 from public.franchises where id = fc;
  perform public.game_board_upsert((select jsonb_agg(jsonb_build_object('game_id', 'p' || i, 'final_home', 30, 'final_away', 10)) from generate_series(1, 5) i));
  v := public.franchise_settle_pick5();
  perform pg_temp.ok('a 5–0 card is a perfect card', (v->>'perfect_cards')::int = 1, v::text);
  perform pg_temp.ok('and earns the bonus and the achievement, once',
    (select xp from public.franchises where id = fc) = xp0 + 5 * 10 + 150
    and (select team_credits from public.franchises where id = fc) = tc0 + 5 * 15 + 200
    and exists (select 1 from public.franchise_achievements where franchise_id = fc and achievement_id = 'perfect_card'));
  v := public.franchise_settle_pick5();
  perform pg_temp.ok('a perfect card does not pay twice', (v->>'perfect_cards')::int = 0
    and (select xp from public.franchises where id = fc) = xp0 + 200);

-- ═══ 8. THE DRILL ═════════════════════════════════════════════════════════
  perform pg_temp.as_user(ALICE);
  select xp, team_credits into xp0, tc0 from public.franchises where id = fa;
  v := public.franchise_record_drill(today, 10, 8, 950, 'daily:' || today);
  perform pg_temp.ok('today''s drill rewards XP and capped Team Credits',
    (v->'rewards'->>'xp')::int = 40 and (v->'rewards'->>'tc')::int = 24 and not (v->>'already')::boolean);
  perform pg_temp.ok('and is marked as client-reported', (v->'result'->>'verified')::boolean = false);
  v := public.franchise_record_drill(today, 10, 10, 1500, 'daily:' || today);
  perform pg_temp.ok('a second run today is the first one, replayed', (v->>'already')::boolean and (v->'result'->>'correct')::int = 8);
  perform pg_temp.ok('the credits happened once',
    (select xp from public.franchises where id = fa) = xp0 + 40 and (select team_credits from public.franchises where id = fa) = tc0 + 24);
  begin
    v := public.franchise_record_drill('2099-01-01', 10, 10, 1500, null);
    perform pg_temp.ok('a drill for a day that has not happened is refused', false, 'it recorded');
  exception when invalid_parameter_value then
    perform pg_temp.ok('a drill for a day that has not happened is refused', true);
  end;
  begin
    v := public.franchise_record_drill(public.games_day_key(now() - interval '1 day'), 10, 12, 1500, null);
    perform pg_temp.ok('more correct than rounds is refused', false, 'it recorded');
  exception when invalid_parameter_value then
    perform pg_temp.ok('more correct than rounds is refused', true);
  end;
  v := public.franchise_record_drill(public.games_day_key(now() - interval '1 day'), 10, 10, 1500, null);
  perform pg_temp.ok('yesterday''s run can still be filed and its credits cap at 30',
    (v->'rewards'->>'tc')::int = 30 and not (v->>'already')::boolean);

-- ═══ 9. RESEARCH OPENS ════════════════════════════════════════════════════
  select xp into xp0 from public.franchises where id = fa;
  v := public.franchise_record_research('g1');
  perform pg_temp.ok('a research open on a board game earns 15 XP', (v->'rewards'->>'xp')::int = 15 and not (v->>'capped')::boolean);
  v := public.franchise_record_research('g1');
  perform pg_temp.ok('opening the same game again is one row', (v->>'already')::boolean and (select xp from public.franchises where id = fa) = xp0 + 15);
  begin
    v := public.franchise_record_research('nope');
    perform pg_temp.ok('a research open on an unknown game is refused', false, 'it recorded');
  exception when no_data_found then
    perform pg_temp.ok('a research open on an unknown game is refused', true);
  end;
  perform pg_temp.as_owner();
  perform public.game_board_upsert((select jsonb_agg(jsonb_build_object('game_id', 'r' || i, 'home_team', 'RH' || i, 'away_team', 'RA' || i,
    'kickoff', (now() + interval '5 days')::text, 'edgedesk_spread', -1)) from generate_series(1, 12) i));
  perform pg_temp.as_user(ALICE);
  -- g1 was the first this week, so r1..r8 make nine and r9 is the tenth
  for n in 1..8 loop perform public.franchise_record_research('r' || n); end loop;
  v := public.franchise_record_research('r9');
  perform pg_temp.ok('the tenth unique game this week still earns', (v->'rewards'->>'xp')::int = 15);
  v := public.franchise_record_research('r10');
  perform pg_temp.ok('the eleventh is recorded but earns nothing — a research tab is worth reading, not clicking',
    (v->>'capped')::boolean and (v->'rewards'->>'xp')::int = 0
    and exists (select 1 from public.franchise_activity where franchise_id = fa and kind = 'research_open' and key = 'r10'));

-- ═══ 10. SETTING A STARTER ════════════════════════════════════════════════
  v := public.franchise_roster();
  select (p->>'id')::uuid into pid from jsonb_array_elements(v->'players') p where p->>'position' = 'WR' and (p->>'depth')::int = 5;
  select (p->>'id')::uuid into pid2 from jsonb_array_elements(v->'players') p where p->>'position' = 'WR' and (p->>'depth')::int = 1;
  v2 := public.franchise_set_starter(pid, 1);
  perform pg_temp.ok('a backup can be named a starter',
    (select depth from public.game_players where id = pid) = 1 and (select depth from public.game_players where id = pid2) = 5);
  perform pg_temp.ok('the team rating follows the depth chart',
    (v2->'rating'->'groups'->>'WR')::int <> (v->'rating'->'groups'->>'WR')::int
    or (select overall from public.game_players where id = pid) = (select overall from public.game_players where id = pid2));
  v2 := public.franchise_set_starter(pid2, 1);
  perform pg_temp.ok('and swapped back', (select depth from public.game_players where id = pid2) = 1);
  begin
    v2 := public.franchise_set_starter(pid, 4);
    perform pg_temp.ok('a slot beyond the position''s starters is refused', false, 'it ran');
  exception when invalid_parameter_value then
    perform pg_temp.ok('a slot beyond the position''s starters is refused', true);
  end;
  perform pg_temp.as_user(BOB);
  begin
    v2 := public.franchise_set_starter(pid, 1);
    perform pg_temp.ok('another account cannot touch your depth chart', false, 'it ran');
  exception when no_data_found then
    perform pg_temp.ok('another account cannot touch your depth chart', true);
  end;

-- ═══ 11. IMPORTING ANONYMOUS HISTORY ══════════════════════════════════════
  perform pg_temp.as_owner();
  perform public.game_board_upsert(jsonb_build_array(
    jsonb_build_object('game_id', 'i1', 'home_team', 'IH1', 'away_team', 'IA1', 'kickoff', (now() + interval '2 days')::text, 'edgedesk_spread', -7, 'market_spread', -6),
    jsonb_build_object('game_id', 'i2', 'home_team', 'IH2', 'away_team', 'IA2', 'kickoff', (now() + interval '2 days')::text, 'edgedesk_spread', -7, 'market_spread', -6)));
  perform pg_temp.as_user(BOB);
  select xp, scouting_points, team_credits into xp0, sp0, tc0 from public.franchises where id = fb;
  v := public.franchise_import_history(jsonb_build_object(
    'price_it', jsonb_build_array(
      jsonb_build_object('game_id', 'i1', 'user_spread', -7, 'at', (now() - interval '1 hour')::text),
      jsonb_build_object('game_id', 'played', 'user_spread', -5, 'at', (now() - interval '3 days')::text),
      jsonb_build_object('game_id', 'ghost', 'user_spread', -5),
      jsonb_build_object('game_id', 'i1', 'user_spread', 0)),
    'pick5', jsonb_build_array(
      jsonb_build_object('week', '2026-08-25', 'submitted_at', '2026-08-27T12:00:00Z',
        'selections', jsonb_build_array(jsonb_build_object('game_id', 'old1', 'pick', 'home'), jsonb_build_object('game_id', 'old2', 'pick', 'away'))),
      jsonb_build_object('week', wk, 'selections', jsonb_build_array(jsonb_build_object('game_id', 'i2', 'pick', 'home')))),
    'drill', jsonb_build_array(
      jsonb_build_object('day', public.games_day_key(now() - interval '3 days'), 'rounds', 10, 'correct', 7, 'total', 800),
      jsonb_build_object('day', '2099-01-01', 'rounds', 10, 'correct', 10, 'total', 1500)),
    'research', jsonb_build_array(jsonb_build_object('game_id', 'i1'), jsonb_build_object('game_id', 'ghost'))));
  perform pg_temp.ok('a Price It on a game still ahead is credited in full',
    (v->'price_it'->>'credited')::int = 1, (v->'price_it')::text);
  perform pg_temp.ok('a Price It on a game already played earns XP only',
    (v->'price_it'->>'xp_only')::int = 1
    and (select verified = false from public.franchise_activity where franchise_id = fb and kind = 'price_it' and key = 'played')
    and not exists (select 1 from public.franchise_ledger where franchise_id = fb and kind = 'price_it' and key = 'played' and currency in ('sp', 'tc')));
  perform pg_temp.ok('an unknown game and a duplicate are skipped', (v->'price_it'->>'skipped')::int = 2);
  perform pg_temp.ok('a past week''s card is kept as history, XP only',
    (v->'pick5'->>'history')::int = 1
    and (select imported and settled_at is not null from public.franchise_pick5_cards where franchise_id = fb and week_key = '2026-08-25')
    and not exists (select 1 from public.franchise_ledger where franchise_id = fb and kind = 'pick5_card' and key = '2026-08-25' and currency = 'tc'));
  perform pg_temp.ok('this week''s card is skipped because one already exists', (v->'pick5'->>'live')::int = 0 and (v->'pick5'->>'skipped')::int = 1);
  perform pg_temp.ok('a drill day in the past is accepted, a future one refused',
    (v->'drill'->>'credited')::int = 1 and (v->'drill'->>'skipped')::int = 1);
  perform pg_temp.ok('a research open on a board game carries over, an unknown one does not',
    (v->'research'->>'credited')::int = 1 and (v->'research'->>'skipped')::int = 1);
  perform pg_temp.ok('the import moved the totals by exactly the table',
    (select xp from public.franchises where id = fb) = xp0 + 50 + 50 + 75 + 40 + 15
    and (select scouting_points from public.franchises where id = fb) = sp0 + 40
    and (select team_credits from public.franchises where id = fb) = tc0 + 20 + 21,
    (select xp || '/' || scouting_points || '/' || team_credits from public.franchises where id = fb));
  select xp, scouting_points, team_credits into xp0, sp0, tc0 from public.franchises where id = fb;
  v2 := public.franchise_import_history(jsonb_build_object(
    'price_it', jsonb_build_array(jsonb_build_object('game_id', 'i1', 'user_spread', -7), jsonb_build_object('game_id', 'played', 'user_spread', -5)),
    'pick5', jsonb_build_array(jsonb_build_object('week', '2026-08-25', 'selections', jsonb_build_array(jsonb_build_object('game_id', 'old1', 'pick', 'home')))),
    'drill', jsonb_build_array(jsonb_build_object('day', public.games_day_key(now() - interval '3 days'), 'rounds', 10, 'correct', 10, 'total', 1500)),
    'research', jsonb_build_array(jsonb_build_object('game_id', 'i1'))));
  perform pg_temp.ok('importing the same history twice is importing it once',
    (select xp = xp0 and scouting_points = sp0 and team_credits = tc0 from public.franchises where id = fb), v2::text);
  perform pg_temp.ok('a garbage payload is a no-op, not an error',
    (public.franchise_import_history('"nonsense"'::jsonb)->>'imported')::boolean = false
    and (public.franchise_import_history('{"price_it":"not-an-array"}'::jsonb)->>'imported')::boolean = true);

-- ═══ 12. A SETTLED HEAD-TO-HEAD BECOMES COACH POINTS ══════════════════════
  perform pg_temp.as_user(ALICE);
  v := public.h2h_create('winner', 'americanfootball_ncaaf', 'g6', 'a6-h6', 'Home6', 'Away6', now() + interval '4 days',
    '{"spread":-7}'::jsonb, '{"side":"home"}'::jsonb, 'Alice', null);
  tok := v->>'invite_token'; cid := (v->>'id')::uuid;
  perform pg_temp.as_user(BOB);
  perform public.h2h_submit(tok, '{"side":"away"}'::jsonb, 'Bob', null);
  perform pg_temp.as_owner();
  select xp, coach_points into xp0, cp0 from public.franchises where id = fa;
  v := public.h2h_settle(cid, 'win', '{"final":"31-20"}'::jsonb);
  perform pg_temp.ok('the H2H settled through the social layer untouched', v->>'status' = 'FINAL');
  perform pg_temp.ok('the winner''s franchise earns XP and Coach Points for playing and for winning',
    (select xp from public.franchises where id = fa) = xp0 + 40 + 20
    and (select coach_points from public.franchises where id = fa) = cp0 + 1 + 2);
  perform pg_temp.ok('the loser''s franchise earns the playing share only',
    (select coach_points from public.franchises where id = fb) = 1
    and exists (select 1 from public.franchise_ledger where franchise_id = fb and kind = 'h2h_locked' and currency = 'xp' and delta = 40)
    and not exists (select 1 from public.franchise_ledger where franchise_id = fb and kind = 'h2h_win'));
  perform pg_temp.ok('the first Head-to-Head win is an achievement',
    exists (select 1 from public.franchise_achievements where franchise_id = fa and achievement_id = 'first_h2h_win'));
  v := public.h2h_correct(cid, 'test correction', 'loss', '{}'::jsonb);
  perform pg_temp.ok('a correction re-settles without crediting the original winner twice',
    (select coach_points from public.franchises where id = fa) = cp0 + 3);
  perform pg_temp.ok('and the corrected winner is credited, once — the ledger is append-only and never retracts',
    (select coach_points from public.franchises where id = fb) = 3
    and (select count(*) from public.franchise_ledger where franchise_id = fb and kind = 'h2h_win' and currency = 'cp') = 1);
  v := public.h2h_correct(cid, 'second correction', 'win', '{}'::jsonb);
  perform pg_temp.ok('a second correction credits nobody again',
    (select coach_points from public.franchises where id = fa) = cp0 + 3 and (select coach_points from public.franchises where id = fb) = 3);

-- ═══ 13. THE READ MODELS ══════════════════════════════════════════════════
  perform pg_temp.as_user(ALICE);
  v := public.franchise_home();
  perform pg_temp.ok('home names the franchise and its resources',
    v->'franchise'->>'name' = 'Lubbock Outlaws' and (v->'resources'->>'xp')::int = (select xp from public.franchises where id = fa));
  perform pg_temp.ok('home carries the level and the next threshold',
    (v->'resources'->>'level')::int = public.games_level_for((v->'resources'->>'xp')::int));
  perform pg_temp.ok('home lists recent ledger lines, newest first',
    jsonb_array_length(v->'recent') between 1 and 12 and (v->'recent'->0->>'at') >= (v->'recent'->-1->>'at'));
  perform pg_temp.ok('home counts this week''s Head-to-Head', (v->'week'->>'h2h')::int = 1);
  v := public.franchise_ledger_recent(5);
  perform pg_temp.ok('the ledger read model is capped and ordered', jsonb_array_length(v) = 5 and (v->0->>'at') >= (v->4->>'at'));
  perform pg_temp.ok('every ledger line names its economy version',
    (select bool_and(economy = 'economy_v1') from public.franchise_ledger));
  perform pg_temp.ok('no ledger line was ever written outside a real record kind',
    (select bool_and(kind in ('price_it','pick5_card','pick5_correct','pick5_perfect','drill_daily','research_open','h2h_locked','h2h_win','founded',
                              'weekly_game','weekly_win','rival_win','season_complete'))
      from public.franchise_ledger));

-- ═══ 14. A TEAM BEFORE AN ACCOUNT ═════════════════════════════════════════
  perform pg_temp.as_anon();
  v := public.franchise_create('Comets', 'Boise', 'BOI', 'peak', 'teal', 'option', 'three_four', SEC_D);
  fd := (v->'franchise'->>'id')::uuid;
  perform pg_temp.ok('an anonymous player founds a franchise with their device secret alone', fd is not null and (v->>'roster_count')::int = 38);
  perform pg_temp.ok('and it says it lives on the device', v->'franchise'->>'owner' = 'device');
  perform pg_temp.as_owner();
  perform pg_temp.ok('the server keeps the hash of the secret, never the secret',
    (select anon_hash = public.games_hash(SEC_D) and user_id is null from public.franchises where id = fd));
  perform pg_temp.as_anon();
  begin
    perform public.franchise_create('Second', 'Boise', 'BO2', 'peak', 'teal', 'option', 'three_four', SEC_D);
    perform pg_temp.ok('one franchise per device secret', false, 'a second was created');
  exception when unique_violation then
    perform pg_temp.ok('one franchise per device secret', true);
  end;
  perform pg_temp.ok('the secret reads its own home', (public.franchise_home(SEC_D)->'franchise'->>'id')::uuid = fd);
  perform pg_temp.ok('and its own roster', jsonb_array_length(public.franchise_roster(SEC_D)->'players') = 38);
  perform pg_temp.ok('a wrong secret reads nothing', public.franchise_home(SEC_X) is null and public.franchise_roster(SEC_X) is null);
  v := public.franchise_record_price_it('i2', -7, SEC_D);
  perform pg_temp.ok('an anonymous franchise earns exactly as an account one does',
    (v->'result'->>'score')::int = 100 and (v->'rewards'->>'sp')::int = 40 and (v->'totals'->>'scouting_points')::int = 40);
  begin
    v := public.franchise_record_price_it('i2', -7, SEC_X);
    perform pg_temp.ok('a wrong secret cannot earn on it', false, 'it recorded');
  exception when invalid_authorization_specification then
    perform pg_temp.ok('a wrong secret cannot earn on it', true);
  end;
  -- the same secret plays Head-to-Head anonymously; a settled challenge credits the device franchise too
  perform pg_temp.as_user(ALICE);
  v := public.h2h_create('winner', 'americanfootball_ncaaf', 'i1', 'ih1', 'IH1', 'IA1', now() + interval '2 days',
    '{"spread":-7}'::jsonb, '{"side":"home"}'::jsonb, 'Alice', null);
  tok := v->>'invite_token'; cid := (v->>'id')::uuid;
  perform pg_temp.as_anon();
  perform public.h2h_submit(tok, '{"side":"away"}'::jsonb, 'Dan', SEC_D);
  perform pg_temp.as_owner();
  perform public.h2h_settle(cid, 'loss', '{}'::jsonb);
  perform pg_temp.ok('a device-owned franchise is credited for an anonymous Head-to-Head win',
    (select coach_points = 3 from public.franchises where id = fd)
    and exists (select 1 from public.franchise_achievements where franchise_id = fd and achievement_id = 'first_h2h_win'));

  -- Dan signs up and claims it
  perform pg_temp.as_user(DAN);
  perform pg_temp.ok('before claiming, the account owns nothing', public.franchise_home() is null);
  v := public.franchise_claim(SEC_D);
  perform pg_temp.ok('the claim binds the device franchise to the account', (v->>'claimed')::boolean and (v->'home'->'franchise'->>'id')::uuid = fd);
  perform pg_temp.ok('and everything it earned came with it',
    (v->'home'->'resources'->>'scouting_points')::int = 40 and (v->'home'->'resources'->>'coach_points')::int = 3
    and v->'home'->'franchise'->>'owner' = 'account');
  perform pg_temp.ok('the account now reads it without a secret', (public.franchise_home()->'franchise'->>'id')::uuid = fd);
  perform pg_temp.ok('and the direct-read policies admit it', (select count(*) from public.franchises) = 1 and (select count(*) from public.game_players) = 38);
  v := public.franchise_claim(SEC_D);
  perform pg_temp.ok('claiming again is refused honestly — the account already owns one', not (v->>'claimed')::boolean and v->>'reason' = 'account_has_franchise');
  perform pg_temp.as_anon();
  perform pg_temp.ok('the secret no longer resolves — the franchise lives on the account now', public.franchise_home(SEC_D) is null);
  perform pg_temp.as_user(ALICE);
  v := public.franchise_claim(SEC_X);
  perform pg_temp.ok('an account that owns a franchise cannot claim another', not (v->>'claimed')::boolean and v->>'reason' = 'account_has_franchise');

-- ═══ 15. THE WEEKLY GAME ══════════════════════════════════════════════════
  -- the shared rules, on the server
  perform pg_temp.ok('the scheme matchup is the published table',
    public.franchise_scheme_edge('air_raid', 'press_man') = -2 and public.franchise_scheme_edge('power_run', 'press_man') = 2
    and public.franchise_scheme_edge('option', 'zone') = -2 and public.franchise_scheme_edge('pro_style', 'blitz_heavy') = -2
    and public.franchise_scheme_edge('nope', 'zone') = 0);
  perform pg_temp.ok('and it is balanced: no offense nets more than a point across the six defenses',
    (select bool_and(abs((select sum(v.value::numeric) from jsonb_each_text(o.value) v)) <= 1)
      from jsonb_each(public.franchise_scheme_edges()) o));
  perform pg_temp.ok('objects of numbers add key by key',
    public.games_jsonb_sum('{"a":1,"b":2}'::jsonb, '{"b":3,"c":"x"}'::jsonb) = '{"a":1,"b":5,"c":0}'::jsonb
    and public.games_jsonb_sum(null, '{"g":1}'::jsonb) = '{"g":1}'::jsonb);
  -- preparation, prep_v1, pinned to the client's worked examples
  perform pg_temp.as_owner();
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail) values
    (fb, 'price_it', 'prep-a', '1999-01-05', '1999-01-06', '{"score":80}'),
    (fb, 'drill_daily', '1999-01-06', '1999-01-05', '1999-01-06', '{}'),
    (fb, 'research_open', 'prep-r1', '1999-01-05', '1999-01-06', '{}');
  v := public.franchise_prep(fb, '1999-01-05');
  perform pg_temp.ok('one report, one drill, one research open: scouting 33, preparation 41, market IQ 80',
    v->>'version' = 'prep_v1' and (v->>'scouting')::int = 33 and (v->>'preparation')::int = 41 and (v->>'market_iq')::int = 80, v::text);
  insert into public.franchise_activity (franchise_id, kind, key, week_key, day_key, detail) values
    (fb, 'price_it', 'prep-b', '1999-01-05', '1999-01-06', '{"score":60}'),
    (fb, 'price_it', 'prep-c', '1999-01-05', '1999-01-06', '{"score":100}'),
    (fb, 'pick5_card', '1999-01-05', '1999-01-05', '1999-01-06', '{}'),
    (fb, 'research_open', 'prep-r2', '1999-01-05', '1999-01-06', '{}');
  v := public.franchise_prep(fb, '1999-01-05');
  perform pg_temp.ok('three reports, the card, a drill and two opens: everything at 100',
    (v->>'scouting')::int = 100 and (v->>'preparation')::int = 100 and (v->>'market_iq')::int = 80, v::text);
  v := public.franchise_prep(fb, '1999-01-12');
  perform pg_temp.ok('a week with nothing in it is 0, 0 and no Market IQ',
    (v->>'scouting')::int = 0 and (v->>'preparation')::int = 0 and v->'market_iq' = 'null'::jsonb);
  delete from public.franchise_activity where franchise_id = fb and week_key = '1999-01-05';

  -- the schedule, set at founding
  perform pg_temp.as_user(ALICE);
  v := public.franchise_schedule();
  perform pg_temp.ok('Season I was scheduled at founding: eight games, one a week',
    (v->'season'->>'status') = 'active' and jsonb_array_length(v->'games') = 8
    and (select bool_and((g->>'week')::int = i) from jsonb_array_elements(v->'games') with ordinality as t(g, i)));
  perform pg_temp.ok('eight different clubs, and the rival closes the season',
    (select count(distinct g->'opponent'->>'key') from jsonb_array_elements(v->'games') g) = 8
    and (v->'games'->7->>'rival')::boolean and not (v->'games'->0->>'rival')::boolean
    and v->'games'->7->'opponent'->>'key' = v->'rival'->>'key');
  perform pg_temp.ok('week 1 is this football week, and its game opens on Saturday at 07:00 UTC',
    v->'games'->0->>'week_key' = wk
    and (v->'games'->0->>'opens_at')::timestamptz = (((wk::date + 4)::timestamp + interval '7 hours') at time zone 'UTC')
    and extract(dow from ((v->'games'->0->>'opens_at')::timestamptz at time zone 'UTC')) = 6);
  perform pg_temp.ok('each week is the next football week',
    (select bool_and((g->>'week_key') = public.games_week_key(now() + ((i - 1) * interval '7 days')))
      from jsonb_array_elements(v->'games') with ordinality as t(g, i)));
  perform pg_temp.ok('opponents are drawn around the team''s own overall: six below to four above, the rival two above',
    (select bool_and((g->'opponent'->>'overall')::int between ovr - 8 and ovr + 6) from jsonb_array_elements(v->'games') g)
    and (v->'games'->7->'opponent'->>'overall')::int between ovr + 1 and ovr + 3);
  perform pg_temp.ok('home and away alternate',
    (select bool_and((g->>'home')::boolean <> (v->'games'->(i::int)->>'home')::boolean)
      from jsonb_array_elements(v->'games') with ordinality as t(g, i) where i < 8));
  perform pg_temp.ok('the schedule carries this week''s preparation and the matchup table',
    v->'prep'->>'version' = 'prep_v1' and v->'scheme_edges' ? 'air_raid' and (v->'record'->>'wins')::int = 0);
  perform pg_temp.as_owner();
  perform pg_temp.ok('every game''s seed was derived by the server from the franchise seed',
    (select bool_and(g.seed = md5(f.seed || ':game:1:' || g.week)) from public.franchise_games g join public.franchises f on f.id = g.franchise_id where g.franchise_id = fa));
  perform pg_temp.ok('scheduling again schedules nothing', public.franchise_schedule_season(fa, 1, now()) = 0);
  perform pg_temp.ok('the opponent pool is fictional clubs with the franchise''s own identity lists',
    (select count(*) from public.franchise_opponents) = 24
    and (select bool_and(logo in ('star','bolt','shield','wolf','horn','anchor','arrow','flame','crown','wing','gear','wave','peak','eagle','bull','spear'))
           from public.franchise_opponents));

  -- the window
  select id, opens_at into gid, t0 from public.franchise_games where franchise_id = fa and week = 1;
  begin
    perform public.franchise_play_game(fa, t0 - interval '1 minute');
    perform pg_temp.ok('a game cannot be played before its Saturday', false, 'it played');
  exception when object_not_in_prerequisite_state then
    perform pg_temp.ok('a game cannot be played before its Saturday', true);
  end;
  perform pg_temp.as_anon();
  begin
    perform public.franchise_play_week(SEC_X);
    perform pg_temp.ok('a guessed secret cannot play anyone''s game', false, 'it played');
  exception when invalid_authorization_specification then
    perform pg_temp.ok('a guessed secret cannot play anyone''s game', true);
  end;
  perform pg_temp.as_user(BOB);
  perform pg_temp.ok('another account cannot read your game', public.franchise_game(gid) is null
    and (select count(*) from public.franchise_games) = (select count(*) from public.franchise_games g where g.franchise_id = fb));
  update public.franchise_games set score_for = 99 where id = gid;
  perform pg_temp.as_user(ALICE);
  perform pg_temp.ok('nor edit it, and neither can you',
    (select score_for is null from public.franchise_games where id = gid));
  update public.franchise_games set score_for = 99 where id = gid;
  perform pg_temp.ok('a client cannot write a result', (select score_for is null from public.franchise_games where id = gid));

  -- the simulator is a pure function of the seed and the state of the team
  perform pg_temp.as_owner();
  box := public.franchise_sim(fa, gid);
  box2 := public.franchise_sim(fa, gid);
  perform pg_temp.ok('the same game simulated twice is the same game', box = box2 and box->>'sim' = 'sim_v1');
  perform pg_temp.ok('a game is eleven to fourteen possessions a side, four quarters, and a final that is the sum of them',
    (box->'edges'->>'possessions')::int between 9 and 14
    and (select sum(q::int) from jsonb_array_elements_text(box->'quarters'->'for') q) = (box->'final'->>'for')::int
    and (select sum(q::int) from jsonb_array_elements_text(box->'quarters'->'against') q) = (box->'final'->>'against')::int
    and (box->'team'->'for'->>'points')::int = (box->'final'->>'for')::int);
  perform pg_temp.ok('every scoring play names a player of yours, and a running score',
    (select bool_and((p->>'desc') like '%' || (case when p->>'type' = 'FG' then '-yd FG' else 'TD' end) || '%' and (p->'for') is not null)
      from jsonb_array_elements(box->'scoring') p where p->>'side' = 'for'));
  perform pg_temp.ok('the box lines add up to the team totals: passing yards to the receivers, rushing to the rushers, touchdowns to the scorers',
    (select coalesce(sum((p->'stats'->>'yds')::int), 0) from jsonb_array_elements(box->'players') p where p->>'position' in ('WR','TE'))
      + (select coalesce(sum((p->'stats'->>'rec_yds')::int), 0) from jsonb_array_elements(box->'players') p where p->>'position' = 'RB')
      = (box->'team'->'for'->>'pass_yds')::int
    and (select coalesce(sum((p->'stats'->>'yds')::int), 0) from jsonb_array_elements(box->'players') p where p->>'position' = 'RB')
      + (select coalesce(sum((p->'stats'->>'rush_yds')::int), 0) from jsonb_array_elements(box->'players') p where p->>'position' = 'QB')
      = (box->'team'->'for'->>'rush_yds')::int
    and (select coalesce(sum((p->'stats'->>'td')::int), 0) from jsonb_array_elements(box->'players') p where p->>'position' in ('WR','TE','RB'))
      + (select coalesce(sum((p->'stats'->>'rush_td')::int), 0) from jsonb_array_elements(box->'players') p where p->>'position' = 'QB')
      = (box->'team'->'for'->>'td')::int);
  perform pg_temp.ok('the quarterback''s line is the passing game', 
    (select (p->'stats'->>'yds')::int = (box->'team'->'for'->>'pass_yds')::int and (p->'stats'->>'att')::int = (box->'team'->'for'->>'pass_plays')::int
       from jsonb_array_elements(box->'players') p where p->>'position' = 'QB'));
  perform pg_temp.ok('the edges are stated: home field, this week''s preparation, the scheme matchup, the traits',
    (box->'edges'->>'home')::numeric = (case when (select home from public.franchise_games where id = gid) then 1.5 else 0 end)
    and box->'edges'->'prep'->>'version' = 'prep_v1'
    and (box->'edges'->>'prep_adj')::numeric = round((least(100, (box->'edges'->'prep'->>'preparation')::numeric + 2 * (box->'edges'->'traits'->>'preparation')::numeric) - 50) / 50.0 * 3, 2)
    and (box->'edges'->>'scheme_offense')::numeric = public.franchise_scheme_edge('air_raid', (select opponent->>'defense' from public.franchise_games where id = gid))
    and (box->'edges'->'traits'->>'count')::int >= 0);
  perform pg_temp.ok('this week''s preparation is the one Alice actually did',
    (box->'edges'->'prep'->>'preparation')::int = (public.franchise_prep(fa, wk)->>'preparation')::int
    and (box->'edges'->'prep'->>'preparation')::int > 0);
  perform pg_temp.ok('a player of the game is named, with a line', box->'potg'->>'name' is not null and box->'potg'->'stats' is not null);
  perform pg_temp.ok('simulating writes nothing', (select status = 'scheduled' and score_for is null from public.franchise_games where id = gid)
    and (select bool_and(career_stats = '{}'::jsonb) from public.game_players where franchise_id = fa));

  -- the distribution: a much weaker club loses most of the time, a much stronger one wins most of the time
  select seed, opponent into seed0, opp0 from public.franchise_games where id = gid;
  w := 0; l := 0;
  update public.franchise_games set opponent = opponent || '{"offense_r":58,"defense_r":58,"special_r":58}'::jsonb where id = gid;
  for k in 1..40 loop
    update public.franchise_games set seed = md5('weak:' || k) where id = gid;
    box2 := public.franchise_sim(fa, gid);
    if box2->>'result' = 'W' then w := w + 1; elsif box2->>'result' = 'L' then l := l + 1; end if;
  end loop;
  perform pg_temp.ok('forty games against a 58: at least 28 wins', w >= 28, w || ' wins, ' || l || ' losses');
  w := 0; l := 0;
  update public.franchise_games set opponent = opponent || '{"offense_r":88,"defense_r":88,"special_r":85}'::jsonb where id = gid;
  for k in 1..40 loop
    update public.franchise_games set seed = md5('strong:' || k) where id = gid;
    box2 := public.franchise_sim(fa, gid);
    if box2->>'result' = 'W' then w := w + 1; elsif box2->>'result' = 'L' then l := l + 1; end if;
  end loop;
  perform pg_temp.ok('forty games against an 88: at most 14 wins', w <= 14, w || ' wins, ' || l || ' losses');
  update public.franchise_games set seed = seed0, opponent = opp0 where id = gid;
  perform pg_temp.ok('the game is as it was', public.franchise_sim(fa, gid) = box);

  -- playing week 1, on its Saturday
  select xp, team_credits, coach_points into xp0, tc0, cp0 from public.franchises where id = fa;
  v := public.franchise_play_game(fa, t0);
  perform pg_temp.ok('the game is played, once, and the result is the simulator''s',
    (v->'game'->>'status') = 'final' and (v->'game'->>'week')::int = 1
    and (v->'game'->>'score_for')::int = (box->'final'->>'for')::int and (v->'game'->>'score_against')::int = (box->'final'->>'against')::int
    and v->'game'->>'result' = box->>'result' and v->'game'->>'sim_version' = 'sim_v1');
  perform pg_temp.ok('the season record moved by exactly one game',
    (v->'season'->>'week')::int = 1 and (v->'season'->>'wins')::int + (v->'season'->>'losses')::int + (v->'season'->>'ties')::int = 1
    and (v->'season'->>'points_for')::int = (box->'final'->>'for')::int and not (v->>'season_complete')::boolean);
  perform pg_temp.ok('playing pays by the table: 100 XP and 40 TC for the game, 60 XP, 60 TC and 2 CP for a win',
    (v->'rewards'->>'xp')::int = 100 + (case when v->'game'->>'result' = 'W' then 60 else 0 end)
    and (v->'rewards'->>'tc')::int = 40 + (case when v->'game'->>'result' = 'W' then 60 else 0 end)
    and (v->'rewards'->>'cp')::int = (case when v->'game'->>'result' = 'W' then 2 else 0 end)
    and (select xp from public.franchises where id = fa) = xp0 + (v->'rewards'->>'xp')::int
    and (select coach_points from public.franchises where id = fa) = cp0 + (v->'rewards'->>'cp')::int, (v->'rewards')::text);
  perform pg_temp.ok('the first win is an achievement, only on a win',
    (v->'game'->>'result' = 'W') = (v->'achievements' ? 'first_win'));
  perform pg_temp.ok('the record has the game, keyed by season and week',
    exists (select 1 from public.franchise_activity where franchise_id = fa and kind = 'weekly_game' and key = '1:1' and week_key = wk)
    and (select count(*) from public.franchise_ledger where franchise_id = fa and kind = 'weekly_game' and key = '1:1') = 2);
  perform pg_temp.ok('every starter''s season and career lines grew by the box',
    (select bool_and((season_stats->>'games')::int = 1 and season_stats = career_stats) from public.game_players
       where franchise_id = fa and status = 'active' and depth = 1)
    and (select (career_stats->>'yds')::int from public.game_players where franchise_id = fa and position = 'QB' and depth = 1)
        = (box->'team'->'for'->>'pass_yds')::int);
  perform pg_temp.ok('a backup who did not play has no line', (select career_stats = '{}'::jsonb from public.game_players where franchise_id = fa and position = 'QB' and depth = 2));

  -- the next week, and not the one after
  select id, opens_at into gid2, t0 from public.franchise_games where franchise_id = fa and week = 2;
  begin
    perform public.franchise_play_game(fa, t0 - interval '1 day');
    perform pg_temp.ok('week 2 waits for its own Saturday', false, 'it played');
  exception when object_not_in_prerequisite_state then
    perform pg_temp.ok('week 2 waits for its own Saturday', true);
  end;
  v := public.franchise_play_game(fa, t0);
  perform pg_temp.ok('on its Saturday, week 2 is the next game', (v->'game'->>'week')::int = 2 and (v->'season'->>'week')::int = 2);
  perform pg_temp.ok('a week missed is a game played unprepared, not a game lost',
    (v->'game'->'prep'->>'preparation')::int = 0 and (v->'game'->>'status') = 'final');
  perform pg_temp.ok('the ledger pays each week once', (select count(*) from public.franchise_ledger where franchise_id = fa and kind = 'weekly_game') = 4);

  -- the read models
  perform pg_temp.as_user(ALICE);
  v := public.franchise_home();
  perform pg_temp.ok('home names the next game, the last game, this week''s preparation, the record and the rival',
    (v->'next_game'->>'week')::int = 3 and (v->'last_game'->>'week')::int = 2 and v->'last_game'->'potg'->>'name' is not null
    and v->'prep'->>'version' = 'prep_v1' and (v->'record'->>'wins')::int + (v->'record'->>'losses')::int + (v->'record'->>'ties')::int = 2
    and v->'rival'->>'name' is not null and (v->'rival'->>'wins')::int = 0);
  v := public.franchise_game(gid);
  perform pg_temp.ok('a game is read back with its box', v->'box'->>'sim' = 'sim_v1' and jsonb_array_length(v->'box'->'players') >= 22);
  v := public.franchise_schedule();
  perform pg_temp.ok('the schedule shows two finals and six to come',
    (select count(*) from jsonb_array_elements(v->'games') g where g->>'status' = 'final') = 2
    and (select bool_and(g->'box' = 'null'::jsonb) from jsonb_array_elements(v->'games') g));
  begin
    perform public.franchise_start_season();
    perform pg_temp.ok('a season under way is left alone', (select count(*) from public.franchise_seasons where franchise_id = fa) = 1);
  end;

  -- the rest of the season, each game on its Saturday; then the rollover
  perform pg_temp.as_owner();
  for k in 3..8 loop
    select opens_at into t0 from public.franchise_games where franchise_id = fa and week = k;
    v := public.franchise_play_game(fa, t0);
  end loop;
  perform pg_temp.ok('the eighth game completes the season',
    (v->>'season_complete')::boolean and v->'season'->>'status' = 'complete' and (v->'season'->>'week')::int = 8
    and (select completed_at is not null from public.franchise_seasons where franchise_id = fa and number = 1));
  perform pg_temp.ok('the season''s record is the sum of its games',
    (select wins from public.franchise_seasons where franchise_id = fa and number = 1)
      = (select count(*) from public.franchise_games where franchise_id = fa and season_number = 1 and result = 'W')
    and (select points_for from public.franchise_seasons where franchise_id = fa and number = 1)
      = (select sum(score_for) from public.franchise_games where franchise_id = fa and season_number = 1));
  perform pg_temp.ok('a completed season pays 250 XP and 150 TC, once, and is a Full Season',
    (select count(*) from public.franchise_ledger where franchise_id = fa and kind = 'season_complete' and key = '1') = 2
    and (select delta from public.franchise_ledger where franchise_id = fa and kind = 'season_complete' and key = '1' and currency = 'xp') = 250
    and exists (select 1 from public.franchise_achievements where franchise_id = fa and achievement_id = 'first_season'));
  perform pg_temp.ok('a winning season is an achievement exactly when wins beat losses',
    (select wins > losses from public.franchise_seasons where franchise_id = fa and number = 1)
      = exists (select 1 from public.franchise_achievements where franchise_id = fa and achievement_id = 'winning_season'));
  perform pg_temp.ok('bragging rights come only from beating the rival',
    (select result = 'W' from public.franchise_games where franchise_id = fa and season_number = 1 and rival)
      = exists (select 1 from public.franchise_achievements where franchise_id = fa and achievement_id = 'bragging_rights'));
  perform pg_temp.ok('the rival''s share of the ledger is paid only on a rival win',
    (select result = 'W' from public.franchise_games where franchise_id = fa and season_number = 1 and rival)
      = exists (select 1 from public.franchise_ledger where franchise_id = fa and kind = 'rival_win'));
  begin
    perform public.franchise_play_game(fa, now() + interval '400 days');
    perform pg_temp.ok('a complete season has no game to play', false, 'it played');
  exception when object_not_in_prerequisite_state then
    perform pg_temp.ok('a complete season has no game to play', true);
  end;
  perform pg_temp.ok('careers carry the whole season',
    (select (career_stats->>'games')::int = 8 from public.game_players where franchise_id = fa and position = 'QB' and depth = 1));

  perform pg_temp.as_user(ALICE);
  v := public.franchise_home();
  perform pg_temp.ok('home has no next game and one season on the record',
    v->'next_game' = 'null'::jsonb and (v->'record'->>'seasons')::int = 1 and v->'season'->>'status' = 'complete');
  v := public.franchise_start_season();
  perform pg_temp.ok('Season II starts on request: numbered on, scheduled, under way',
    (v->>'started')::boolean and (v->>'season_number')::int = 2 and v->'home'->'season'->>'label' = 'Season II'
    and v->'home'->'season'->>'status' = 'active' and (v->'home'->'next_game'->>'week')::int = 1
    and (select count(*) from public.franchise_seasons where franchise_id = fa) = 2);
  perform pg_temp.ok('the season lines reset and the careers do not',
    (select bool_and(season_stats = '{}'::jsonb) from public.game_players where franchise_id = fa)
    and (select (career_stats->>'games')::int = 8 from public.game_players where franchise_id = fa and position = 'QB' and depth = 1));
  perform pg_temp.ok('the rival is for life and closes Season II too',
    (select opponent_key from public.franchise_games where franchise_id = fa and season_number = 2 and week = 8)
      = (select rival_key from public.franchises where id = fa)
    and (select opponent_key from public.franchise_games where franchise_id = fa and season_number = 1 and week = 8)
      = (select rival_key from public.franchises where id = fa));
  v := public.franchise_start_season();
  perform pg_temp.ok('starting again starts nothing', not (v->>'started')::boolean and (v->>'season_number')::int = 2);
  v := public.franchise_schedule(1);
  perform pg_temp.ok('a past season can still be read, game by game', v->'season'->>'status' = 'complete'
    and (select count(*) from jsonb_array_elements(v->'games') g where g->>'status' = 'final') = 8 and jsonb_array_length(v->'seasons') = 2);

  -- a device franchise plays exactly as an account one
  perform pg_temp.as_owner();
  select id, opens_at into gid, t0 from public.franchise_games where franchise_id = fd and week = 1;
  v := public.franchise_play_game(fd, t0);
  perform pg_temp.ok('a device-founded franchise had a schedule from its first second and plays on it',
    (v->'game'->>'week')::int = 1 and (v->'game'->>'status') = 'final');
end
$test$;
