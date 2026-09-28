-- ===========================================================================
-- football-v2 scenario: every close class the audit asked for, on data shaped
-- like the 2026 record. Loaded AFTER football_v2_fixture.sql and BEFORE the
-- migration, graded once by the LEGACY grade_game so the repair has a real
-- "old state" to audit against.
--
--   NFL (codes are whole names, as the Collective stores NFL teams)
--   N1  NE @ SEA    A  close already on results (-3)
--   N2  DET @ BUF   B  odds event LINKED, snapshots pregame, results close empty
--   N3  CAR @ CLE   C  odds event NOT linked (the old linker missed it)
--   N4  NYJ @ DET   C  only EdgeDesk's own capture has it (signal ticks)
--   N5  KC @ MIA    I  snapshots exist, every one after kickoff
--   N6  LV @ NO     J  no market anywhere
--   N7  LAR @ DEN   K  every submission late
--   N8  TEN @ NYG   D  held twice; the odds event was linked to the duplicate
--   N9  SEA @ WAS   L  only a stale snapshot (8h before kickoff)
--   N10 MIN @ TB    C  odds lists the game home/away SWAPPED (neutral-site shape)
--   N11 ARI @ SF    F  odds event four days away from kickoff
--   N12 BAL @ DAL   E  odds event names a team nothing resolves ("Big D Cowpokes")
--   N13 ATL @ GB    G  odds event carries only a totals market
--   N14 CIN @ PIT   A  results close -2.5 AND a feed row stating +2.5 for home
--                      (orientation conflict: the feed row is refused)
--   N15 HOU @ IND   H  spread rows whose side names neither team
--   CFB (legacy ten-character codes, as the 2026 record holds them)
--   C1  COASTALCAR @ WESTVIRGIN   C  both names truncated
--   C2  JACKSONVIL @ OHIO         C  one truncated, one whole
--   C3  Auburn @ Alabama          C  names unusable, provider (ESPN) id links it
--   C4  MISSISSIPP @ OLEMISS      C  a rival school on the slate clips to the
--                                    same code; one side exact carries it
-- ===========================================================================
\set ON_ERROR_STOP on

insert into collective.teams (id, sport_code, code, name)
select ('aaaaaaaa-0000-0000-0000-' || lpad(to_hex(row_number() over ()), 12, '0'))::uuid, 'NFL', c, c
  from unnest(array['SEA','NE','BUF','DET','CLE','CAR','NYJ','MIA','KC','NO','LV','DEN','LAR','NYG','TEN','WAS',
                    'TB','MIN','SF','ARI','DAL','BAL','GB','ATL','CIN','PIT','HOU','IND']) c;
insert into collective.teams (id, sport_code, code, name) values
  ('aaaaaaaa-0000-0000-0001-000000000001', 'CFB', 'WESTVIRGIN', 'WESTVIRGIN'),
  ('aaaaaaaa-0000-0000-0001-000000000002', 'CFB', 'COASTALCAR', 'COASTALCAR'),
  ('aaaaaaaa-0000-0000-0001-000000000003', 'CFB', 'OHIO', 'OHIO'),
  ('aaaaaaaa-0000-0000-0001-000000000004', 'CFB', 'JACKSONVIL', 'JACKSONVIL'),
  ('aaaaaaaa-0000-0000-0001-000000000005', 'CFB', 'ALABAMA', 'Alabama'),
  ('aaaaaaaa-0000-0000-0001-000000000006', 'CFB', 'AUBURN', 'Auburn'),
  ('aaaaaaaa-0000-0000-0001-000000000007', 'CFB', 'MISSISSIPP', 'MISSISSIPP'),
  ('aaaaaaaa-0000-0000-0001-000000000008', 'CFB', 'OLEMISS', 'OLEMISS');
insert into collective.teams (sport_code, code, name) values ('MLB', 'NYY', 'NYY'), ('MLB', 'BOS', 'BOS');
insert into collective.team_aliases (sport_code, alias, team_id)
select 'CFB', 'Alabama Crimson Tide', id from collective.teams where code = 'ALABAMA';

create or replace function pg_temp.tid(p_sport text, p_code text) returns uuid language sql as $$
  select id from collective.teams where sport_code = p_sport and code = p_code $$;

create table public.fx_games (tag text primary key, game_id uuid not null);
with g(tag, sport, wk, away, home, ko, st, hs, aws, cl, ref) as (values
  ('N1',  'NFL', 1, 'NE',  'SEA', '2026-09-10T00:20:00Z', 'final', 13, 10, -3::numeric, null),
  ('N2',  'NFL', 2, 'DET', 'BUF', '2026-09-18T00:15:00Z', 'final', 41, 31, null, null),
  ('N3',  'NFL', 3, 'CAR', 'CLE', '2026-09-27T17:00:00Z', 'final', 21, 18, null, null),
  ('N4',  'NFL', 3, 'NYJ', 'DET', '2026-09-27T17:00:00Z', 'final', 31, 24, null, null),
  ('N5',  'NFL', 3, 'KC',  'MIA', '2026-09-27T17:00:00Z', 'final', 10, 24, null, null),
  ('N6',  'NFL', 3, 'LV',  'NO',  '2026-09-27T20:25:00Z', 'final', 27, 35, null, null),
  ('N7',  'NFL', 3, 'LAR', 'DEN', '2026-09-28T00:20:00Z', 'final', 30, 26, null, null),
  ('N8',  'NFL', 3, 'TEN', 'NYG', '2026-09-27T17:00:00Z', 'final', 12, 7, null, null),
  ('N8b', 'NFL', 3, 'TEN', 'NYG', '2026-09-27T17:05:00Z', 'scheduled', null, null, null, 'espn:999'),
  ('N9',  'NFL', 3, 'SEA', 'WAS', '2026-09-27T17:00:00Z', 'final', 33, 31, null, null),
  ('N10', 'NFL', 3, 'MIN', 'TB',  '2026-09-27T20:05:00Z', 'final', 16, 23, null, null),
  ('N11', 'NFL', 3, 'ARI', 'SF',  '2026-09-27T20:05:00Z', 'final', 36, 30, null, null),
  ('N12', 'NFL', 3, 'BAL', 'DAL', '2026-09-27T20:25:00Z', 'final', 31, 34, null, null),
  ('N13', 'NFL', 3, 'ATL', 'GB',  '2026-09-25T00:15:00Z', 'final', 14, 35, null, null),
  ('N14', 'NFL', 3, 'CIN', 'PIT', '2026-09-27T17:00:00Z', 'final', 30, 27, -2.5, null),
  ('N15', 'NFL', 3, 'HOU', 'IND', '2026-09-27T17:00:00Z', 'final', 19, 17, null, null),
  ('C1',  'CFB', 1, 'COASTALCAR', 'WESTVIRGIN', '2026-09-05T23:00:00Z', 'final', 38, 20, null, null),
  ('C2',  'CFB', 2, 'JACKSONVIL', 'OHIO', '2026-09-12T22:00:00Z', 'final', 29, 27, null, null),
  ('C3',  'CFB', 4, 'AUBURN', 'ALABAMA', '2026-09-26T19:30:00Z', 'final', 24, 21, null, 'espn:401777'),
  ('C4',  'CFB', 3, 'MISSISSIPP', 'OLEMISS', '2026-09-19T16:00:00Z', 'final', 31, 28, null, null),
  ('M1',  'MLB', 1, 'BOS', 'NYY', '2026-09-20T23:00:00Z', 'final', 5, 3, null, null)
), ins as (
  insert into collective.games (sport_code, season, week, kickoff_at, home_team_id, away_team_id, status, external_ref)
  select g.sport, 2026, g.wk, g.ko::timestamptz, pg_temp.tid(g.sport, g.home), pg_temp.tid(g.sport, g.away), g.st, g.ref
    from g
  returning id, sport_code, kickoff_at, home_team_id, away_team_id, external_ref
)
insert into public.fx_games (tag, game_id)
select g.tag, i.id from g join ins i on i.sport_code = g.sport and i.kickoff_at = g.ko::timestamptz
  and i.home_team_id = pg_temp.tid(g.sport, g.home) and i.away_team_id = pg_temp.tid(g.sport, g.away);

create or replace function pg_temp.gid(p_tag text) returns uuid language sql as $$ select game_id from public.fx_games where tag = p_tag $$;

insert into collective.results (game_id, home_score, away_score, closing_spread, source)
select pg_temp.gid(t), hs, aws, cl, 'settle'
  from (values ('N1',13,10,-3::numeric),('N2',41,31,null),('N3',21,18,null),('N4',31,24,null),('N5',10,24,null),
               ('N6',27,35,null),('N7',30,26,null),('N8',12,7,null),('N9',33,31,null),('N10',16,23,null),('N11',36,30,null),
               ('N12',31,34,null),('N13',14,35,null),('N14',30,27,-2.5),('N15',19,17,null),
               ('C1',38,20,null),('C2',29,27,null),('C3',24,21,null),('C4',31,28,null),('M1',5,3,null)) v(t, hs, aws, cl);

-- ---- the models ------------------------------------------------------------------
insert into collective.creators (id, slug, display_name) values
  ('cccccccc-0000-0000-0000-000000000001', 'edgedesk', 'EdgeDesk'),
  ('cccccccc-0000-0000-0000-000000000002', 'moose', 'Moose'),
  ('cccccccc-0000-0000-0000-000000000003', 'plusev', '+EV'),
  ('cccccccc-0000-0000-0000-000000000004', 'blizzard', 'Blizzard'),
  ('cccccccc-0000-0000-0000-000000000005', 'blerm', 'Blerm');
insert into collective.models (id, creator_id, slug, name, sport_code) values
  ('dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'nfl', 'EdgeDesk NFL', 'NFL'),
  ('dddddddd-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000002', 'nfl', 'Moose NFL', 'NFL'),
  ('dddddddd-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000003', 'nfl', '+EV NFL', 'NFL'),
  ('dddddddd-0000-0000-0000-000000000004', 'cccccccc-0000-0000-0000-000000000004', 'nfl', 'Blizzard NFL', 'NFL'),
  ('dddddddd-0000-0000-0000-000000000011', 'cccccccc-0000-0000-0000-000000000001', 'cfb', 'EdgeDesk CFB', 'CFB'),
  ('dddddddd-0000-0000-0000-000000000015', 'cccccccc-0000-0000-0000-000000000005', 'cfb', 'Blerm CFB', 'CFB'),
  ('dddddddd-0000-0000-0000-000000000099', 'cccccccc-0000-0000-0000-000000000001', 'mlb', 'EdgeDesk MLB', 'MLB');

-- EdgeDesk: explicit sides. Moose: a spread and nothing else. +EV: projected
-- scores and a probability, no side. Blizzard: explicit, posts inside the lock
-- on the week-3 early games.
insert into collective.projections (model_id, game_id, received_at, pick_side, projected_spread, proj_home_score, proj_away_score, home_win_prob, is_graded_candidate)
select m, pg_temp.gid(t), ko - make_interval(hours => h), side, spr, ph, pa, prob, true
  from (values
    ('N1','home',-4.5,null::numeric,null::numeric,0.62, 'dddddddd-0000-0000-0000-000000000001'::uuid, 24),
    ('N2','home',-7,null,null,0.7, 'dddddddd-0000-0000-0000-000000000001', 24),
    ('N3','away',-1,null,null,0.52, 'dddddddd-0000-0000-0000-000000000001', 24),
    ('N4','home',-8,null,null,0.72, 'dddddddd-0000-0000-0000-000000000001', 24),
    ('N5','away',2,null,null,0.45, 'dddddddd-0000-0000-0000-000000000001', 24),
    ('N6','home',-2,null,null,0.55, 'dddddddd-0000-0000-0000-000000000001', 24),
    ('N8','home',-4,null,null,0.6, 'dddddddd-0000-0000-0000-000000000001', 24),
    ('N9','home',-1,null,null,0.51, 'dddddddd-0000-0000-0000-000000000001', 24),
    ('N10','home',-4,null,null,0.63, 'dddddddd-0000-0000-0000-000000000001', 24),
    ('N11','away',-8,null,null,0.7, 'dddddddd-0000-0000-0000-000000000001', 24),
    ('N12','home',1,null,null,0.48, 'dddddddd-0000-0000-0000-000000000001', 24),
    ('N13','away',3,null,null,0.4, 'dddddddd-0000-0000-0000-000000000001', 24),
    ('N14','away',-1,null,null,0.55, 'dddddddd-0000-0000-0000-000000000001', 24),
    ('N15','home',-3,null,null,0.6, 'dddddddd-0000-0000-0000-000000000001', 24),
    ('N2',null,-3,null,null,null, 'dddddddd-0000-0000-0000-000000000002', 3),
    ('N3',null,-4,null,null,null, 'dddddddd-0000-0000-0000-000000000002', 3),
    ('N4',null,-5,null,null,null, 'dddddddd-0000-0000-0000-000000000002', 3),
    ('N6',null,-6,null,null,null, 'dddddddd-0000-0000-0000-000000000002', 3),
    ('N8',null,-3.5,null,null,null, 'dddddddd-0000-0000-0000-000000000002', 3),
    ('N10',null,-1,null,null,null, 'dddddddd-0000-0000-0000-000000000002', 3),
    ('N14',null,-2.5,null,null,null, 'dddddddd-0000-0000-0000-000000000002', 3),
    ('N2',null,null,27,20,0.66, 'dddddddd-0000-0000-0000-000000000003', 6),
    ('N3',null,null,20,23,0.44, 'dddddddd-0000-0000-0000-000000000003', 6),
    ('N4',null,null,28,21,0.74, 'dddddddd-0000-0000-0000-000000000003', 6),
    ('N6',null,null,24,24,0.5, 'dddddddd-0000-0000-0000-000000000003', 6),
    ('N10',null,null,20,23,0.4, 'dddddddd-0000-0000-0000-000000000003', 6),
    ('N1','away',-2,null,null,0.52, 'dddddddd-0000-0000-0000-000000000004', 5),
    ('N9','away',2,null,null,0.47, 'dddddddd-0000-0000-0000-000000000004', 5)
  ) v(t, side, spr, ph, pa, prob, m, h)
  join public.fx_games f on f.tag = v.t
  join lateral (select kickoff_at as ko from collective.games where id = f.game_id) k on true;

-- Blizzard inside the lock (10 minutes before kickoff): late, never graded
insert into collective.projections (model_id, game_id, received_at, pick_side, projected_spread, home_win_prob, is_late)
select 'dddddddd-0000-0000-0000-000000000004', pg_temp.gid(t), g.kickoff_at - interval '10 minutes', 'away', 3, 0.4, true
  from unnest(array['N2','N3','N4','N5','N6']) t join collective.games g on g.id = pg_temp.gid(t);
-- N7: every model late
insert into collective.projections (model_id, game_id, received_at, pick_side, projected_spread, home_win_prob, is_late)
select m, pg_temp.gid('N7'), g.kickoff_at - interval '5 minutes', 'home', -3, 0.6, true
  from unnest(array['dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000002']::uuid[]) m
  join collective.games g on g.id = pg_temp.gid('N7');
-- Moose N1: an early version (graded by the legacy "first submission" rule) and a later pre-lock version
insert into collective.projections (model_id, game_id, received_at, projected_spread, is_graded_candidate)
select 'dddddddd-0000-0000-0000-000000000002', pg_temp.gid('N1'), g.kickoff_at - interval '3 days', -1, true
  from collective.games g where g.id = pg_temp.gid('N1');
insert into collective.projections (model_id, game_id, received_at, projected_spread, is_graded_candidate)
select 'dddddddd-0000-0000-0000-000000000002', pg_temp.gid('N1'), g.kickoff_at - interval '2 hours', -5, false
  from collective.games g where g.id = pg_temp.gid('N1');
-- Moose N2: an edit AFTER the lock that would have flipped the side
insert into collective.projections (model_id, game_id, received_at, projected_spread, is_late)
select 'dddddddd-0000-0000-0000-000000000002', pg_temp.gid('N2'), g.kickoff_at + interval '2 hours', -12, true
  from collective.games g where g.id = pg_temp.gid('N2');
-- +EV N6: a backfilled row beside the live one
insert into collective.projections (model_id, game_id, received_at, proj_home_score, proj_away_score, home_win_prob, data_origin)
select 'dddddddd-0000-0000-0000-000000000003', pg_temp.gid('N6'), g.kickoff_at - interval '1 hour', 30, 10, 0.9, 'backfill'
  from collective.games g where g.id = pg_temp.gid('N6');
-- CFB
insert into collective.projections (model_id, game_id, received_at, pick_side, projected_spread, home_win_prob, is_graded_candidate)
select m, pg_temp.gid(t), g.kickoff_at - interval '1 day', side, spr, prob, true
  from (values
    ('C1','home',-17,0.85,'dddddddd-0000-0000-0000-000000000011'::uuid),
    ('C2','away',-1,0.45,'dddddddd-0000-0000-0000-000000000011'),
    ('C3','home',-3,0.6,'dddddddd-0000-0000-0000-000000000011'),
    ('C4','home',-10,0.75,'dddddddd-0000-0000-0000-000000000011'),
    ('C1',null,-10,null,'dddddddd-0000-0000-0000-000000000015'),
    ('C2',null,-6,null,'dddddddd-0000-0000-0000-000000000015'),
    ('C3',null,-9,null,'dddddddd-0000-0000-0000-000000000015'),
    ('C4',null,-4,null,'dddddddd-0000-0000-0000-000000000015')) v(t, side, spr, prob, m)
  join collective.games g on g.id = pg_temp.gid(v.t);
insert into collective.projections (model_id, game_id, received_at, projected_spread, is_graded_candidate)
select 'dddddddd-0000-0000-0000-000000000099', pg_temp.gid('M1'), g.kickoff_at - interval '1 day', -1.5, true
  from collective.games g where g.id = pg_temp.gid('M1');

-- ---- the Collective's odds feed ---------------------------------------------------
insert into odds.events (event_id, league, commence_time, home_team, away_team, espn_id, collective_game_id) values
  ('E2',  'nfl', '2026-09-18T00:15:00Z', 'Buffalo Bills', 'Detroit Lions', null, pg_temp.gid('N2')),
  ('E3',  'nfl', '2026-09-27T17:00:00Z', 'Cleveland Browns', 'Carolina Panthers', null, null),
  ('E5',  'nfl', '2026-09-27T17:00:00Z', 'Miami Dolphins', 'Kansas City Chiefs', null, pg_temp.gid('N5')),
  ('E8',  'nfl', '2026-09-27T17:00:00Z', 'New York Giants', 'Tennessee Titans', null, pg_temp.gid('N8b')),
  ('E9',  'nfl', '2026-09-27T17:00:00Z', 'Washington Commanders', 'Seattle Seahawks', null, pg_temp.gid('N9')),
  ('E10', 'nfl', '2026-09-27T20:05:00Z', 'Minnesota Vikings', 'Tampa Bay Buccaneers', null, null),
  ('E11', 'nfl', '2026-10-01T20:05:00Z', 'San Francisco 49ers', 'Arizona Cardinals', null, null),
  ('E12', 'nfl', '2026-09-27T20:25:00Z', 'Big D Cowpokes', 'Baltimore Ravens', null, null),
  ('E13', 'nfl', '2026-09-25T00:15:00Z', 'Green Bay Packers', 'Atlanta Falcons', null, pg_temp.gid('N13')),
  ('E14', 'nfl', '2026-09-27T17:00:00Z', 'Pittsburgh Steelers', 'Cincinnati Bengals', null, pg_temp.gid('N14')),
  ('E15', 'nfl', '2026-09-27T17:00:00Z', 'Indianapolis Colts', 'Houston Texans', null, pg_temp.gid('N15')),
  ('E21', 'ncaaf', '2026-09-05T23:00:00Z', 'West Virginia Mountaineers', 'Coastal Carolina Chanticleers', null, null),
  ('E23', 'ncaaf', '2026-09-12T22:00:00Z', 'Ohio Bobcats', 'Jacksonville State Gamecocks', null, null),
  ('E24', 'ncaaf', '2026-09-26T19:30:00Z', 'Tide', 'Tigers', '401777', null),
  ('E25', 'ncaaf', '2026-09-19T16:00:00Z', 'Ole Miss Rebels', 'Mississippi State Bulldogs', null, null),
  ('E26', 'ncaaf', '2026-09-19T19:00:00Z', 'Alabama Crimson Tide', 'Mississippi Valley State Delta Devils', null, null);

insert into odds.lines (event_id, book, market, outcome, point, price, captured_at) values
  ('E2', 'draftkings', 'spreads', 'Buffalo Bills', -5, -110, '2026-09-17T23:40:00Z'),
  ('E2', 'draftkings', 'spreads', 'Buffalo Bills', -5.5, -110, '2026-09-17T23:55:00Z'),
  ('E2', 'fanduel', 'spreads', 'Buffalo Bills', -6, -110, '2026-09-17T23:55:00Z'),
  ('E2', 'draftkings', 'spreads', 'Detroit Lions', 5.5, -110, '2026-09-17T23:55:00Z'),
  ('E2', 'draftkings', 'spreads', 'Buffalo Bills', -10, -110, '2026-09-18T00:30:00Z'),
  ('E3', 'draftkings', 'spreads', 'Cleveland Browns', -2.5, -110, '2026-09-27T16:50:00Z'),
  ('E5', 'draftkings', 'spreads', 'Miami Dolphins', 6.5, -110, '2026-09-27T17:30:00Z'),
  ('E8', 'draftkings', 'spreads', 'New York Giants', -3.5, -110, '2026-09-27T16:55:00Z'),
  ('E9', 'draftkings', 'spreads', 'Washington Commanders', -1, -110, '2026-09-27T09:00:00Z'),
  ('E10', 'draftkings', 'spreads', 'Tampa Bay Buccaneers', -3, -110, '2026-09-27T19:55:00Z'),
  ('E11', 'draftkings', 'spreads', 'San Francisco 49ers', -7, -110, '2026-09-27T19:55:00Z'),
  ('E12', 'draftkings', 'spreads', 'Baltimore Ravens', -1.5, -110, '2026-09-27T20:15:00Z'),
  ('E13', 'draftkings', 'totals', 'Over', 44.5, -110, '2026-09-24T23:55:00Z'),
  ('E14', 'draftkings', 'spreads', 'Pittsburgh Steelers', 2.5, -110, '2026-09-27T16:50:00Z'),
  ('E15', 'draftkings', 'spreads', 'Over', -3, -110, '2026-09-27T16:50:00Z'),
  ('E21', 'draftkings', 'spreads', 'West Virginia Mountaineers', -13.5, -110, '2026-09-05T22:50:00Z'),
  ('E23', 'draftkings', 'spreads', 'Ohio Bobcats', -4, -110, '2026-09-12T21:45:00Z'),
  ('E24', 'draftkings', 'spreads', 'Tide', -7, -110, '2026-09-26T19:20:00Z'),
  ('E25', 'draftkings', 'spreads', 'Ole Miss Rebels', -6.5, -110, '2026-09-19T15:50:00Z');

-- ---- EdgeDesk's own capture ---------------------------------------------------------
-- One capture pass stamps every point it saw with the pass's instant: at the
-- final pregame pass (16:40) six books quote DET -6.5 and one quotes -7, so
-- -6.5 is the close. The 09-25 tick is two days out: never a close, never copied.
insert into public.signals (sig_key, event_id, sport_key, market, selection, point, commence_time, home_team, away_team, last_seen_at, n_books) values
  ('oa-n4|spreads|Detroit Lions|-6.5', 'oa-n4', 'americanfootball_nfl', 'spreads', 'Detroit Lions', -6.5, '2026-09-27T17:00:00Z', 'Detroit Lions', 'New York Jets', '2026-09-27T16:40:00Z', 6),
  ('oa-n4|spreads|New York Jets|6.5', 'oa-n4', 'americanfootball_nfl', 'spreads', 'New York Jets', 6.5, '2026-09-27T17:00:00Z', 'Detroit Lions', 'New York Jets', '2026-09-27T16:40:00Z', 6),
  ('oa-n4|spreads|Detroit Lions|-7', 'oa-n4', 'americanfootball_nfl', 'spreads', 'Detroit Lions', -7, '2026-09-27T17:00:00Z', 'Detroit Lions', 'New York Jets', '2026-09-27T16:40:00Z', 1);
-- (insertion order fixes the tick ids; with these, ordering the 16:40 rows by
-- snapshot id alone would put the one-book -7 first: the test proves breadth
-- is what picks -6.5)
insert into public.signal_ticks (sig_key, created_at, point, n_books) values
  ('oa-n4|spreads|Detroit Lions|-6.5', '2026-09-25T12:00:00Z', -5, 5),
  ('oa-n4|spreads|Detroit Lions|-6.5', '2026-09-27T16:10:00Z', -6, 5),
  ('oa-n4|spreads|Detroit Lions|-6.5', '2026-09-27T17:10:00Z', -9, 6),
  ('oa-n4|spreads|Detroit Lions|-6.5', '2026-09-27T16:40:00Z', -6.5, 6),
  ('oa-n4|spreads|New York Jets|6.5', '2026-09-27T16:40:00Z', 6.5, 6),
  ('oa-n4|spreads|Detroit Lions|-7', '2026-09-27T16:40:00Z', -7, 1);

-- ---- the legacy grade, as production has it ------------------------------------------
select collective.grade_game(game_id) from public.fx_games where tag in ('N1', 'N2', 'N14', 'C1');
