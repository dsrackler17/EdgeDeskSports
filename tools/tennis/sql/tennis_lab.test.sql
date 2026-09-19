-- ===========================================================================
-- supabase/tennis_lab.sql, attacked.
--
-- Applied by tools/tennis/lab_sql.test.js to a throwaway database carrying the
-- Supabase shim, billing.sql, the live tennis contract, the record contract and
-- this lab contract. Every assertion raises NOTICE 'ok <what>' when it holds and
-- 'FAIL: ...' otherwise; the harness fails the suite on any FAIL.
--
-- SESSION-LEVEL `set role`, NOT `set local`. psql runs each statement in its own
-- implicit transaction, so `set local role anon` is scoped to that one statement
-- and the role is back to the owner by the next line — which is how an earlier
-- version of the record suite had every "anon cannot read this" assertion
-- passing as the TABLE OWNER. Each role block below sets the role for the
-- session and resets it explicitly at the end.
--
-- What is attacked, and why each one matters:
--
--   NO CLIENT WRITES     a browser that could write tennis.lab_flags could
--                        switch on a market module with no provider behind it.
--                        A browser that could write rating_history could
--                        rewrite what EdgeDesk "said" on a past date.
--   THE PRIVATE FLOOR    anon must not reach player_match_features, the raw
--                        staging table, or the ingestion diary — through a
--                        table, a view, or an RPC.
--   BRIEF IMMUTABILITY   a published brief cannot be rewritten, INCLUDING by
--                        the pipeline that wrote it.
--   NO ODDS, NO PICKS    a brief carrying market content or a selection is
--                        refused by the database, not by a code review.
--   THE MARKET GATE      the module must answer "not available" with every
--                        combination short of all three conditions being met.
--   THE LICENCE GATE     rating_history is a sourced table and obeys it.
--   BOUNDED READS        every lab function caps its own limit, whatever it is
--                        asked for.
--   POINT IN TIME        lab_matchup_inputs with a cutoff cannot see a match at
--                        or after that date. Proven by planting one.
--   THE LAB NEEDS NO ODDS every surface still answers with odds_snapshots empty.
-- ===========================================================================

\set ON_ERROR_STOP on
set client_min_messages = notice;

create or replace function pg_temp.want(p_cond boolean, p_what text) returns void language plpgsql as $$
begin
  if p_cond then raise notice 'ok %', p_what;
  else raise exception 'FAIL: %', p_what; end if;
end $$;
create or replace function pg_temp.refused(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql;
  exception when others then raise notice 'ok % (%)', p_what, left(sqlerrm, 60); return;
  end;
  raise exception 'FAIL: % — the statement was ALLOWED', p_what;
end $$;
create or replace function pg_temp.allowed(p_sql text, p_what text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise notice 'ok %', p_what;
exception when others then
  raise exception 'FAIL: % — refused with %', p_what, left(sqlerrm, 90);
end $$;

-- ── fixtures ───────────────────────────────────────────────────────────────
insert into tennis.players (player_id, tour, source_key, source_player_id, full_name, name_norm, matches_on_file)
values ('archive:ATP:L1', 'ATP', 'archive', 'L1', 'Lab One', 'lab one', 40),
       ('archive:ATP:L2', 'ATP', 'archive', 'L2', 'Lab Two', 'lab two', 35)
on conflict (player_id) do nothing;

insert into tennis.player_ratings_current
  (player_id, tour, elo, hard_elo, clay_elo, elo_sample, hard_sample, clay_sample,
   power_rating, rating_sample, uncertainty, rating_version, source_key,
   form_30d, form_90d, form_365d, form_sample_365d, matches_7d, matches_14d, rest_days,
   serve_strength, return_strength, sos_elo_recent, sos_elo_career,
   trajectory_class, workload_class, rating_delta_30d, lab_version, official_rank)
values
  ('archive:ATP:L1','ATP',1900,1950,1820,300,150,100,72.5,300,0.05,'tennis-rating-1.0.0','edgedesk',
   0.80,0.78,0.70,60,2,4,3,0.64,0.42,1850,1800,'improving','normal',2.4,'tennis-lab-1.0.0',5),
  ('archive:ATP:L2','ATP',1800,1780,1870,250,120,110,62.0,250,0.08,'tennis-rating-1.0.0','edgedesk',
   0.55,0.58,0.62,50,5,9,0,0.58,0.45,1790,1795,'declining','heavy',-1.8,'tennis-lab-1.0.0',28)
on conflict (player_id) do update set power_rating = excluded.power_rating;

-- two matches: one BEFORE a cutoff we will test, one AFTER it
insert into tennis.matches (match_id, source_key, tour, source_tourney_id, match_num,
                            match_date, season, surface, winner_id, loser_id, score, best_of, level)
values ('archive:ATP:lab1:1','archive','ATP','lab1',9001,'2015-06-01',2015,'clay',
        'archive:ATP:L1','archive:ATP:L2','6-4 6-3',3,'A'),
       ('archive:ATP:lab2:1','archive','ATP','lab2',9002,'2024-06-01',2024,'clay',
        'archive:ATP:L2','archive:ATP:L1','6-2 6-2',3,'A')
on conflict (match_id) do nothing;

insert into tennis.player_match_features
  (match_id, player_id, opponent_id, tour, match_date, surface, player_role, won,
   elo_pre, surface_elo_pre, rank_pre, feature_version, feature_source_key)
values
  ('archive:ATP:lab1:1','archive:ATP:L1','archive:ATP:L2','ATP','2015-06-01','clay','winner',true,
   1600,1610,50,'tennis-features-1.0.0','edgedesk'),
  ('archive:ATP:lab1:1','archive:ATP:L2','archive:ATP:L1','ATP','2015-06-01','clay','loser',false,
   1590,1585,60,'tennis-features-1.0.0','edgedesk'),
  -- the row that MUST NOT be visible to a 2016 cutoff
  ('archive:ATP:lab2:1','archive:ATP:L2','archive:ATP:L1','ATP','2024-06-01','clay','winner',true,
   1999,1999,1,'tennis-features-1.0.0','edgedesk'),
  ('archive:ATP:lab2:1','archive:ATP:L1','archive:ATP:L2','ATP','2024-06-01','clay','loser',false,
   1888,1888,2,'tennis-features-1.0.0','edgedesk')
on conflict (match_id, player_id, feature_version) do nothing;

insert into tennis.rating_history (player_id, as_of, tour, elo, power_rating, sample, rating_version, source_key)
values ('archive:ATP:L1','2026-08-01','ATP',1880,70.1,290,'tennis-rating-1.0.0','edgedesk'),
       ('archive:ATP:L1','2026-09-01','ATP',1900,72.5,300,'tennis-rating-1.0.0','edgedesk')
on conflict (player_id, as_of, rating_version) do nothing;

insert into tennis.research_briefs (brief_id, tour, brief_date, tier, headline, sections, brief_version)
values ('brief:test:1','ATP','2026-09-19','trends','Test brief','[]'::jsonb,'tennis-brief-1.0.0')
on conflict (brief_id) do nothing;

-- ===========================================================================
-- 1. THE LICENCE GATE reaches the new sourced table
-- ===========================================================================
select pg_temp.refused($$
  insert into tennis.rating_history (player_id, as_of, tour, elo, sample, rating_version, source_key)
  values ('archive:ATP:L1','2020-01-01','ATP',1500,10,'v','a_source_nobody_registered')
$$, 'rating_history refuses a row from an UNREGISTERED source');

select pg_temp.allowed($$
  insert into tennis.rating_history (player_id, as_of, tour, elo, sample, rating_version, source_key)
  values ('archive:ATP:L1','2020-01-01','ATP',1500,10,'v','edgedesk')
$$, 'and accepts one from a registered source');

-- ===========================================================================
-- 2. BRIEF IMMUTABILITY AND THE NO-ODDS / NO-PICKS CONSTRAINTS
-- ===========================================================================
select pg_temp.refused($$
  update tennis.research_briefs set sections = '[{"k":"rewritten"}]'::jsonb where brief_id = 'brief:test:1'
$$, 'a published brief cannot be rewritten — even by the owner');

select pg_temp.refused($$
  update tennis.research_briefs set tier = 'scheduled' where brief_id = 'brief:test:1'
$$, 'and its tier cannot be changed after the fact');

select pg_temp.refused($$
  insert into tennis.research_briefs (brief_id, tour, brief_date, tier, brief_version, contains_odds)
  values ('brief:odds','ATP','2026-09-19','trends','v',true)
$$, 'a brief carrying ODDS cannot be stored at all');

select pg_temp.refused($$
  insert into tennis.research_briefs (brief_id, tour, brief_date, tier, brief_version, contains_selections)
  values ('brief:picks','ATP','2026-09-19','trends','v',true)
$$, 'a brief carrying SELECTIONS cannot be stored at all');

select pg_temp.refused($$
  insert into tennis.research_briefs (brief_id, tour, brief_date, tier, brief_version)
  values ('brief:bad','ATP','2026-09-19','a_tier_that_does_not_exist','v')
$$, 'and an unknown brief tier is refused');

-- ===========================================================================
-- 3. THE MARKET GATE — off, and off for the right reasons
-- ===========================================================================
select pg_temp.want((select not available from tennis.lab_market_available()),
  'the market module is NOT available out of the box');
select pg_temp.want((select reason from tennis.lab_market_available()) like '%switched off%',
  'and the reason given is that the flag is off');

-- turn the flag on: still not available, because no cleared provider exists
update tennis.lab_flags set enabled = true where flag_key = 'market_comparison';
select pg_temp.want((select not available from tennis.lab_market_available()),
  'the flag alone does NOT make the market module available');
select pg_temp.want((select reason from tennis.lab_market_available()) like '%ever been received%',
  'and it names the absent snapshot');
select pg_temp.want((select not provider_ok from tennis.lab_market_available()),
  'a REGISTERED but never-delivering provider does not satisfy the provider check');

-- register a cleared provider: STILL not available, because no fresh snapshot
insert into tennis.source_licenses
  (source_key, title, licence, commercial_use, research_use, cleared_by, cleared_at)
values ('test_book','Test Book','commercial',true,true,'test-suite',now())
on conflict (source_key) do update set commercial_use = true, cleared_by = 'test-suite', cleared_at = now();
select pg_temp.want((select not available from tennis.lab_market_available()),
  'a cleared provider with NO snapshot still does not open the module');
select pg_temp.want((select reason from tennis.lab_market_available()) like '%ever been received%',
  'and it names the missing snapshot');

-- A snapshot from an UNCLEARED source must not count, however fresh it is.
insert into tennis.source_licenses (source_key, title, licence, commercial_use, research_use)
values ('uncleared_book','Uncleared Book','unknown',false,true)
on conflict (source_key) do nothing;
insert into tennis.odds_snapshots (match_scope, match_ref, market_type, selection, sportsbook, source_key, captured_at, market_state)
values ('archive','archive:ATP:lab1:1','match_winner','archive:ATP:L1','uncleared','uncleared_book', now(),'current')
on conflict do nothing;
select pg_temp.want((select not available from tennis.lab_market_available()),
  'a FRESH snapshot from an UNCLEARED source does not open the module');
select pg_temp.want((select reason from tennis.lab_market_available()) like '%commercially cleared%',
  'and the reason says the source is not cleared');
delete from tennis.odds_snapshots where source_key = 'uncleared_book';

-- a STALE snapshot must not open it either
insert into tennis.odds_snapshots (match_scope, match_ref, market_type, selection, sportsbook, source_key, captured_at, market_state)
values ('archive','archive:ATP:lab1:1','match_winner','archive:ATP:L1','test_book','test_book', now() - interval '3 days','closing')
on conflict do nothing;
select pg_temp.want((select not available from tennis.lab_market_available()),
  'a THREE-DAY-OLD odds snapshot fails the freshness check');

-- all three conditions: now, and only now, it opens
insert into tennis.odds_snapshots (match_scope, match_ref, market_type, selection, sportsbook, source_key, captured_at, market_state)
values ('archive','archive:ATP:lab2:1','match_winner','archive:ATP:L2','test_book','test_book', now() - interval '10 minutes','current')
on conflict do nothing;
select pg_temp.want((select available from tennis.lab_market_available()),
  'all three conditions together DO open the module — the gate is a gate, not a wall');

-- put it back the way it ships
update tennis.lab_flags set enabled = false where flag_key = 'market_comparison';
delete from tennis.odds_snapshots where source_key = 'test_book';
select pg_temp.want((select not available from tennis.lab_market_available()),
  'and it closes again when the flag goes back off');

-- ===========================================================================
-- 4. THE LAB NEEDS NO ODDS — every surface answers with the table empty
-- ===========================================================================
do $$
declare n bigint;
begin
  if (select count(*) from tennis.odds_snapshots) > 0 then
    raise exception 'FAIL: the odds table should be empty for this assertion';
  end if;
  select count(*) into n from tennis.lab_leaders('ATP','overall',10,0);
  perform pg_temp.want(n >= 2, 'lab_leaders answers with NO odds on file');
  select count(*) into n from tennis.lab_surface_board('ATP','clay','adjustment',10,0);
  perform pg_temp.want(n >= 1, 'lab_surface_board answers with no odds');
  select count(*) into n from tennis.lab_trajectory_board('ATP','all',10,0);
  perform pg_temp.want(n >= 1, 'lab_trajectory_board answers with no odds');
  select count(*) into n from tennis.lab_fatigue_board('ATP','all',10);
  perform pg_temp.want(n >= 1, 'lab_fatigue_board answers with no odds');
  select count(*) into n from tennis.lab_rank_gap('ATP','underrated',10,0);
  perform pg_temp.want(n >= 1, 'lab_rank_gap answers with no odds');
  select count(*) into n from tennis.lab_explore('ATP');
  perform pg_temp.want(n >= 1, 'lab_explore answers with no odds');
  select count(*) into n from tennis.lab_player_card('archive:ATP:L1');
  perform pg_temp.want(n = 1, 'lab_player_card answers with no odds');
  select count(*) into n from tennis.lab_matchup_inputs('archive:ATP:L1','archive:ATP:L2','clay');
  perform pg_temp.want(n = 2, 'lab_matchup_inputs answers with no odds');
  select count(*) into n from tennis.lab_health;
  perform pg_temp.want(n = 1, 'lab_health answers with no odds');
end $$;

-- ===========================================================================
-- 5. POINT IN TIME — a cutoff cannot see a later match
-- ===========================================================================
do $$
declare snap date; elo numeric;
begin
  select snapshot_date, lab.elo into snap, elo
    from tennis.lab_matchup_inputs('archive:ATP:L1','archive:ATP:L2','clay','2016-01-01') lab
   where side = 'a';
  perform pg_temp.want(snap = '2015-06-01',
    'a 2016 cutoff uses the 2015 feature row, not the 2024 one');
  perform pg_temp.want(elo = 1600,
    'and the Elo is the 2015 figure (1600), not the 2024 one (1888)');

  select snapshot_date into snap
    from tennis.lab_matchup_inputs('archive:ATP:L1','archive:ATP:L2','clay','2015-06-01') lab
   where side = 'a';
  perform pg_temp.want(snap is null,
    'a cutoff ON the match date excludes that match — strictly before, not on or before');

  -- and current mode sees today's rating, which is neither of those
  select lab.elo into elo from tennis.lab_matchup_inputs('archive:ATP:L1','archive:ATP:L2','clay') lab
   where side = 'a';
  perform pg_temp.want(elo = 1900, 'current mode uses the current rating');
end $$;

-- ===========================================================================
-- 6. BOUNDED READS — every function caps itself
-- ===========================================================================
do $$
declare n bigint;
begin
  select count(*) into n from tennis.lab_leaders('ATP','overall',1000000,0);
  perform pg_temp.want(n <= 100, 'lab_leaders caps at 100 however much is asked for');
  select count(*) into n from tennis.lab_explore('ATP', p_limit => 1000000);
  perform pg_temp.want(n <= 200, 'lab_explore caps at 200');
  select count(*) into n from tennis.lab_search('lab', null, 1000000);
  perform pg_temp.want(n <= 50, 'lab_search caps at 50');
  select count(*) into n from tennis.lab_player_history('archive:ATP:L1', 1000000);
  perform pg_temp.want(n <= 400, 'lab_player_history caps at 400');
  select count(*) into n from tennis.lab_movers('ATP','up',30,1000000,0);
  perform pg_temp.want(n <= 100, 'lab_movers caps at 100');
  -- and a negative or zero limit does not produce an unbounded or erroring read
  select count(*) into n from tennis.lab_leaders('ATP','overall',-5,0);
  perform pg_temp.want(n >= 0 and n <= 100, 'a negative limit is clamped, not an error');
end $$;

-- ===========================================================================
-- 7. ANON — what a signed-out browser may and may not do
-- ===========================================================================
set role anon;

select pg_temp.refused($$select * from tennis.player_match_features limit 1$$,
  'anon cannot read the point-in-time feature table');
select pg_temp.refused($$select * from tennis.stg_archive_matches limit 1$$,
  'anon cannot read the raw staging table');
select pg_temp.refused($$select * from tennis.ingestion_runs limit 1$$,
  'anon cannot read the ingestion diary');
select pg_temp.refused($$select * from tennis.data_quality_issues limit 1$$,
  'anon cannot read the data-quality diary');

select pg_temp.refused($$insert into tennis.rating_history
  (player_id, as_of, tour, elo, sample, rating_version, source_key)
  values ('archive:ATP:L1','2019-01-01','ATP',1,1,'v','edgedesk')$$,
  'anon cannot write rating history');
select pg_temp.refused($$update tennis.rating_history set elo = 9999$$,
  'anon cannot rewrite rating history');
select pg_temp.refused($$delete from tennis.rating_history$$,
  'anon cannot delete rating history');
select pg_temp.refused($$update tennis.lab_flags set enabled = true$$,
  'anon CANNOT switch on the market module');
select pg_temp.refused($$insert into tennis.lab_flags (flag_key, label) values ('x','x')$$,
  'anon cannot add a feature flag');
select pg_temp.refused($$insert into tennis.research_briefs
  (brief_id, tour, brief_date, tier, brief_version) values ('b2','ATP','2026-01-01','trends','v')$$,
  'anon cannot publish a research brief');
select pg_temp.refused($$update tennis.player_ratings_current set power_rating = 100$$,
  'anon cannot rewrite a rating');

-- what anon MAY do: the whole research product
select pg_temp.allowed($$select * from tennis.lab_leaders('ATP','overall',5,0)$$,
  'anon CAN read the rating leaders');
select pg_temp.allowed($$select * from tennis.lab_surface_board('ATP','clay','adjustment',5,0)$$,
  'anon CAN read the surface translator');
select pg_temp.allowed($$select * from tennis.lab_trajectory_board('ATP','all',5,0)$$,
  'anon CAN read the form lab');
select pg_temp.allowed($$select * from tennis.lab_fatigue_board('ATP','all',5)$$,
  'anon CAN read the fatigue lab');
select pg_temp.allowed($$select * from tennis.lab_rank_gap('ATP','underrated',5,0)$$,
  'anon CAN read the ranking disagreement board');
select pg_temp.allowed($$select * from tennis.lab_player_card('archive:ATP:L1')$$,
  'anon CAN read a player card');
select pg_temp.allowed($$select * from tennis.lab_player_history('archive:ATP:L1',10)$$,
  'anon CAN read a rating history');
select pg_temp.allowed($$select * from tennis.lab_player_splits('archive:ATP:L1')$$,
  'anon CAN read player splits');
select pg_temp.allowed($$select * from tennis.lab_player_matches('archive:ATP:L1',10,null)$$,
  'anon CAN read recent matches');
select pg_temp.allowed($$select * from tennis.lab_matchup_inputs('archive:ATP:L1','archive:ATP:L2','clay')$$,
  'anon CAN run a matchup');
select pg_temp.allowed($$select * from tennis.lab_matchup_inputs('archive:ATP:L1','archive:ATP:L2','clay','2016-01-01')$$,
  'anon CAN run a historical matchup');
select pg_temp.allowed($$select * from tennis.lab_h2h('archive:ATP:L1','archive:ATP:L2',null,5)$$,
  'anon CAN read head to head');
select pg_temp.allowed($$select * from tennis.lab_explore('ATP')$$,
  'anon CAN search the historical record');
select pg_temp.allowed($$select * from tennis.lab_explore_summary('ATP')$$,
  'anon CAN read an explorer summary');
select pg_temp.allowed($$select * from tennis.lab_comparables('ATP',150,'clay',3,null,5)$$,
  'anon CAN read historical comparables');
select pg_temp.allowed($$select * from tennis.lab_search('lab',null,5)$$,
  'anon CAN search for a player');
select pg_temp.allowed($$select * from tennis.lab_health$$,
  'anon CAN read the health line');
select pg_temp.allowed($$select * from tennis.lab_market_available()$$,
  'anon CAN ask whether the market module is available');
select pg_temp.allowed($$select * from tennis.research_briefs limit 5$$,
  'anon CAN read a published research brief');
select pg_temp.allowed($$select * from tennis.rating_history limit 5$$,
  'anon CAN read rating history');

-- the health line must not leak a private row through the view
do $$
declare r record;
begin
  select * into r from tennis.lab_health;
  perform pg_temp.want(r.matches_on_file >= 0, 'the health line reads as anon without touching a private table');
end $$;

reset role;

-- ===========================================================================
-- 8. AUTHENTICATED — a signed-in free account is no more privileged
-- ===========================================================================
set role authenticated;
select pg_temp.refused($$update tennis.lab_flags set enabled = true$$,
  'a signed-in account cannot switch on the market module either');
select pg_temp.refused($$insert into tennis.rating_history
  (player_id, as_of, tour, elo, sample, rating_version, source_key)
  values ('archive:ATP:L1','2018-01-01','ATP',1,1,'v','edgedesk')$$,
  'nor write rating history');
select pg_temp.refused($$select * from tennis.player_match_features limit 1$$,
  'nor read the feature table');
select pg_temp.allowed($$select * from tennis.lab_leaders('ATP','overall',5,0)$$,
  'but CAN read the Lab');
reset role;

-- ===========================================================================
-- 9. THE RECORD AND LIVE CONTRACTS ARE UNTOUCHED
-- ===========================================================================
do $$
begin
  perform pg_temp.want(to_regclass('tennis.prediction_record') is not null,
    'the public record table still exists');
  perform pg_temp.want(to_regprocedure('tennis.ai_player_context(text)') is not null,
    'the record contract AI functions still exist');
  perform pg_temp.want(has_table_privilege('anon','tennis.matches','SELECT'),
    'anon still reads the match record');
  perform pg_temp.want(not has_table_privilege('anon','tennis.player_match_features','SELECT'),
    'and still cannot read the feature table');
  perform pg_temp.want((select count(*) from tennis.record_health) = 1,
    'the record health line still answers');
end $$;

-- ===========================================================================
-- 10. NO SILENT ZERO — the database keeps absent absent
-- ===========================================================================
insert into tennis.player_ratings_current
  (player_id, tour, elo, rating_sample, rating_version, source_key)
values ('archive:ATP:L2','ATP',1800,250,'tennis-rating-1.0.0','edgedesk')
on conflict (player_id) do update set serve_strength = null, return_strength = null,
  grass_elo = null, grass_sample = 0;

do $$
declare r record;
begin
  select * into r from tennis.lab_player_card('archive:ATP:L2');
  perform pg_temp.want(r.serve_strength is null,
    'a player with no serve statistics has NULL, not 0');
  perform pg_temp.want(r.grass_elo is null,
    'a surface never played is NULL, not the overall rating and not 0');
  -- and the surface board must not invent a row for it
  perform pg_temp.want(
    (select count(*) from tennis.lab_surface_board('ATP','grass','adjustment',50,0)
      where player_id = 'archive:ATP:L2') = 0,
    'and that player does not appear on the grass board at all');
end $$;

-- ===========================================================================
-- 11. EVERY NEW TABLE HAS RLS, AND NO PRIVILEGED FUNCTION IS OPEN
-- ===========================================================================
do $$
declare n int;
begin
  select count(*) into n from pg_tables t join pg_class c on c.relname = t.tablename
   where t.schemaname = 'tennis' and t.tablename in ('rating_history','research_briefs','lab_flags')
     and not c.relrowsecurity;
  perform pg_temp.want(n = 0, 'every lab table has row level security enabled');

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'tennis' and p.prosecdef
     and (p.proname like 'lab\_%' or p.proname like 'ai\_lab\_%')
     and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%');
  perform pg_temp.want(n = 0, 'every privileged lab function fixes its search_path');

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'tennis' and p.prosecdef
     and (p.proname like 'lab\_%' or p.proname like 'ai\_lab\_%')
     and has_function_privilege('public', p.oid, 'EXECUTE');
  perform pg_temp.want(n = 0, 'and none of them is executable by public');
end $$;

-- ===========================================================================
-- 12. THE AI DOOR returns the sample beside the number
-- ===========================================================================
do $$
declare r record;
begin
  select * into r from tennis.ai_lab_player('archive:ATP:L1');
  perform pg_temp.want(r.sample is not null and r.uncertainty is not null,
    'the AI player context carries the sample AND the uncertainty');
  perform pg_temp.want(r.rating_version is not null,
    'and the rating version that produced it');
  perform pg_temp.want(r.rating_computed_at is not null,
    'and when it was computed');
  perform pg_temp.want((select count(*) from tennis.ai_lab_leaders('ATP','clay',5)) >= 0,
    'the AI surface leaders answer');
  perform pg_temp.want((select count(*) from tennis.ai_lab_health()) = 1,
    'the AI health answer is exactly one row');
end $$;

select 'tennis_lab.test.sql complete' as done;
