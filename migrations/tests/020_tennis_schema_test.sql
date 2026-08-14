-- ============================================================================
-- 020_tennis_schema_test.sql — proves the licensing gate and the derived views.
--
-- Run against a scratch database that already has 020_tennis_schema.sql applied:
--     createdb tennis_test
--     psql -d tennis_test -f migrations/020_tennis_schema.sql
--     psql -d tennis_test -f migrations/tests/020_tennis_schema_test.sql
--
-- EXPECTED: steps 1, 2, 3 and 6 each raise an ERROR (that is the gate working —
-- non-commercial, unregistered, and not-yet-cleared sources are all refused).
-- Steps 4 and 5 succeed and print the derived career/surface/season/H2H/rank/
-- form rows. Do NOT run this against production: it clears a licence flag.
-- ============================================================================

\set ON_ERROR_STOP 0
\echo '--- 1. Sackmann (non-commercial) match insert MUST be refused ---'
insert into tennis.matches (match_id,tour,match_date,winner_id,loser_id,source_key)
values ('m-nc','ATP','2026-08-01','p1','p2','sackmann_atp');

\echo '--- 2. unregistered source MUST be refused ---'
insert into tennis.matches (match_id,tour,match_date,winner_id,loser_id,source_key)
values ('m-x','ATP','2026-08-01','p1','p2','some_scraper');

\echo '--- 3. licensed_feed before clearing MUST be refused (fails closed) ---'
insert into tennis.matches (match_id,tour,match_date,winner_id,loser_id,source_key)
values ('m-1','ATP','2026-08-01','p1','p2','licensed_feed');

\set ON_ERROR_STOP 1
\echo '--- 4. after a human clears the licence, inserts are allowed ---'
update tennis.sources set commercial_use=true, cleared_by='owner', cleared_at=now()
 where source_key='licensed_feed';

insert into tennis.players (player_id,tour,full_name,country,source_key) values
 ('p1','ATP','A Player','ESP','licensed_feed'),
 ('p2','ATP','B Player','USA','licensed_feed'),
 ('p3','ATP','C Player','FRA','licensed_feed');
insert into tennis.rankings (tour,player_id,as_of,rank,points,source_key) values
 ('ATP','p1','2026-08-10',1,9000,'licensed_feed'),
 ('ATP','p2','2026-08-10',2,8000,'licensed_feed');
insert into tennis.matches (match_id,tour,match_date,tourney_name,surface,round,winner_id,loser_id,score,source_key) values
 ('m1','ATP','2026-08-09','Cincinnati','Hard','F','p1','p2','6-4 6-3','licensed_feed'),
 ('m2','ATP','2026-07-14','Wimbledon','Grass','SF','p2','p1','7-6 6-4','licensed_feed'),
 ('m3','ATP','2026-06-08','Roland Garros','Clay','QF','p1','p3','6-1 6-2','licensed_feed'),
 ('m4','ATP','2025-08-09','Cincinnati','Hard','R16','p1','p2','6-3 6-3','licensed_feed');

\echo '--- 5. derived views ---'
select 'career' as v, player_id, wins, losses, matches, win_pct from tennis.player_career order by player_id;
select 'surface' as v, player_id, surface, wins, losses from tennis.player_surface where player_id='p1' order by surface;
select 'season' as v, player_id, season, wins, losses from tennis.player_season where player_id='p1' order by season;
select 'h2h' as v, player_id, opponent_id, wins, losses, last_meeting from tennis.h2h where player_id='p1' order by opponent_id;
select 'current_rank' as v, player_id, rank, points, as_of from tennis.rankings_current order by rank;
select 'form' as v, player_id, match_date, won from tennis.player_form where player_id='p1' order by match_date desc;

\echo '--- 6. a cleared source cannot be silently downgraded past existing rows ---'
update tennis.sources set commercial_use=false where source_key='licensed_feed';
insert into tennis.matches (match_id,tour,match_date,winner_id,loser_id,source_key)
values ('m5','ATP','2026-08-11','p1','p3','licensed_feed');
