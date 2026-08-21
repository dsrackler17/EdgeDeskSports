-- Enough of public.model_predictions to exercise the exporter.
--
-- The column list is PredictionRow from model_predict/core/types.ts, so a
-- shape change there shows up here as a failing insert rather than as a
-- quietly wrong CSV. Nothing in this file is production data: it is fixture
-- rows with made-up numbers, kept out of every production path.

create table public.model_predictions (
  model_version        text        not null,
  sport_key            text        not null,
  event_id             text        not null,
  commence_time        timestamptz,
  home_team            text        not null,
  away_team            text        not null,
  market               text        not null,
  selection            text        not null,
  point                numeric,
  model_prob           numeric     not null,
  model_fair_american  integer,
  market_prob_at_pred  numeric,
  market_am_at_pred    integer,
  best_am_at_pred      integer,
  model_edge           numeric,
  model_ev             numeric,
  context_quality      text,
  missing_features     text[],
  data_as_of           timestamptz,
  feature_snapshot_id  text,
  model_detail         jsonb,
  primary key (model_version, event_id, market, selection)
);

-- ---------------------------------------------------------------- game A
-- Home favourite. The straightforward case.
insert into public.model_predictions
  (model_version, sport_key, event_id, commence_time, home_team, away_team,
   market, selection, point, model_prob, model_fair_american,
   market_prob_at_pred, market_am_at_pred, best_am_at_pred,
   model_edge, model_ev, context_quality, model_detail)
values
 ('nfl_game_v1','americanfootball_nfl','evA','2026-09-09 20:15-04',
  'Seattle Seahawks','New England Patriots',
  'spreads','Seattle Seahawks',-3.5,0.5600,-127,0.5200,-110,-105,
  0.0400,0.0620,'MEDIUM',
  '{"basis":"epa_efficiency","sim_mean_margin":4.80,"sim_mean_total":44.10,
    "expected_home_points":24.45,"expected_away_points":19.65}'),
 ('nfl_game_v1','americanfootball_nfl','evA','2026-09-09 20:15-04',
  'Seattle Seahawks','New England Patriots',
  'spreads','New England Patriots',3.5,0.4400,127,0.4800,-110,-105,
  -0.0400,-0.0510,'MEDIUM',
  '{"basis":"epa_efficiency","sim_mean_margin":4.80,"sim_mean_total":44.10,
    "expected_home_points":24.45,"expected_away_points":19.65}'),
 ('nfl_game_v1','americanfootball_nfl','evA','2026-09-09 20:15-04',
  'Seattle Seahawks','New England Patriots',
  'h2h','Seattle Seahawks',null,0.6300,-170,0.6100,-165,-160,
  0.0200,0.0310,'MEDIUM',
  '{"basis":"epa_efficiency","sim_mean_margin":4.80,"sim_mean_total":44.10,
    "expected_home_points":24.45,"expected_away_points":19.65}'),
 ('nfl_game_v1','americanfootball_nfl','evA','2026-09-09 20:15-04',
  'Seattle Seahawks','New England Patriots',
  'h2h','New England Patriots',null,0.3700,170,0.3900,145,150,
  -0.0200,-0.0290,'MEDIUM',
  '{"basis":"epa_efficiency","sim_mean_margin":4.80,"sim_mean_total":44.10,
    "expected_home_points":24.45,"expected_away_points":19.65}');

-- ---------------------------------------------------------------- game B
-- AWAY favourite. The sign trap: the pick is "-2.5" but the home line is
-- "+2.5", and the model's margin is negative because the away side is better.
insert into public.model_predictions
  (model_version, sport_key, event_id, commence_time, home_team, away_team,
   market, selection, point, model_prob, model_fair_american,
   market_prob_at_pred, market_am_at_pred, best_am_at_pred,
   model_edge, model_ev, context_quality, model_detail)
values
 ('nfl_game_v1','americanfootball_nfl','evB','2026-09-13 13:00-04',
  'Carolina Panthers','Chicago Bears',
  'spreads','Chicago Bears',-2.5,0.5800,-138,0.5190,-110,-102,
  0.0610,0.0880,'MEDIUM',
  '{"basis":"epa_efficiency","sim_mean_margin":-3.20,"sim_mean_total":40.50,
    "expected_home_points":18.65,"expected_away_points":21.85}'),
 ('nfl_game_v1','americanfootball_nfl','evB','2026-09-13 13:00-04',
  'Carolina Panthers','Chicago Bears',
  'spreads','Carolina Panthers',2.5,0.4200,138,0.4810,-110,-102,
  -0.0610,-0.0740,'MEDIUM',
  '{"basis":"epa_efficiency","sim_mean_margin":-3.20,"sim_mean_total":40.50,
    "expected_home_points":18.65,"expected_away_points":21.85}'),
 ('nfl_game_v1','americanfootball_nfl','evB','2026-09-13 13:00-04',
  'Carolina Panthers','Chicago Bears',
  'h2h','Carolina Panthers',null,0.4100,144,0.4300,135,140,
  -0.0200,-0.0180,'MEDIUM',
  '{"basis":"epa_efficiency","sim_mean_margin":-3.20,"sim_mean_total":40.50,
    "expected_home_points":18.65,"expected_away_points":21.85}'),
 -- The AWAY side is the favourite here on purpose. If the exporter takes
 -- whichever moneyline row sorts highest instead of the home one, this row
 -- wins and 0.59 gets filed as the home team's win probability.
 ('nfl_game_v1','americanfootball_nfl','evB','2026-09-13 13:00-04',
  'Carolina Panthers','Chicago Bears',
  'h2h','Chicago Bears',null,0.5900,-144,0.5700,-160,-155,
  0.0200,0.0250,'MEDIUM',
  '{"basis":"epa_efficiency","sim_mean_margin":-3.20,"sim_mean_total":40.50,
    "expected_home_points":18.65,"expected_away_points":21.85}');

-- ---------------------------------------------------------------- game C
-- Pick'em, and no h2h row at all. Zero is a real line; dropped, the pick
-- renders with no number. A missing moneyline must not drop the game.
insert into public.model_predictions
  (model_version, sport_key, event_id, commence_time, home_team, away_team,
   market, selection, point, model_prob, model_fair_american,
   market_prob_at_pred, market_am_at_pred, best_am_at_pred,
   model_edge, model_ev, context_quality, model_detail)
values
 ('nfl_game_v1','americanfootball_nfl','evC','2026-09-13 16:25-04',
  'Houston Texans','Buffalo Bills',
  'spreads','Buffalo Bills',0,0.5300,-113,0.5000,-110,-108,
  0.0300,0.0410,'MEDIUM',
  '{"basis":"epa_efficiency","sim_mean_margin":-0.40,"sim_mean_total":47.00,
    "expected_home_points":23.30,"expected_away_points":23.70}');

-- ---------------------------------------------------------------- game D
-- Week 2. Must not appear in a Week 1 export.
insert into public.model_predictions
  (model_version, sport_key, event_id, commence_time, home_team, away_team,
   market, selection, point, model_prob, model_edge, model_detail)
values
 ('nfl_game_v1','americanfootball_nfl','evD','2026-09-20 13:00-04',
  'Green Bay Packers','Minnesota Vikings',
  'spreads','Green Bay Packers',-1.5,0.5400,0.0300,
  '{"sim_mean_margin":2.10,"sim_mean_total":45.00}');

-- ---------------------------------------------------------------- game E
-- A different sport's model, inside the Week 1 window. Filtering on the date
-- alone would export baseball into an NFL slate.
insert into public.model_predictions
  (model_version, sport_key, event_id, commence_time, home_team, away_team,
   market, selection, point, model_prob, model_edge, model_detail)
values
 ('mlb_runs_v1.2_nbinom_dh','baseball_mlb','evE','2026-09-13 19:05-04',
  'Boston Red Sox','New York Yankees',
  'spreads','Boston Red Sox',-1.5,0.5500,0.0400,
  '{"sim_mean_margin":0.60,"sim_mean_total":8.50}');

-- ---------------------------------------------------------------- game F
-- A WHOLE number, on the away side. A decimal format string renders 7 as
-- "7." and the uploader throws the row out, because a trailing dot with no
-- digit after it is not a number. Half points never catch this.
insert into public.model_predictions
  (model_version, sport_key, event_id, commence_time, home_team, away_team,
   market, selection, point, model_prob, model_fair_american,
   market_prob_at_pred, market_am_at_pred, best_am_at_pred,
   model_edge, model_ev, context_quality, model_detail)
values
 ('nfl_game_v1','americanfootball_nfl','evF','2026-09-13 13:00-04',
  'Detroit Lions','New Orleans Saints',
  'spreads','New Orleans Saints',7,0.5450,-120,0.5100,-110,-105,
  0.0350,0.0490,'MEDIUM',
  '{"basis":"epa_efficiency","sim_mean_margin":8.30,"sim_mean_total":47.50,
    "expected_home_points":27.90,"expected_away_points":19.60}'),
 ('nfl_game_v1','americanfootball_nfl','evF','2026-09-13 13:00-04',
  'Detroit Lions','New Orleans Saints',
  'spreads','Detroit Lions',-7,0.4550,120,0.4900,-110,-105,
  -0.0350,-0.0400,'MEDIUM',
  '{"basis":"epa_efficiency","sim_mean_margin":8.30,"sim_mean_total":47.50,
    "expected_home_points":27.90,"expected_away_points":19.60}'),
 ('nfl_game_v1','americanfootball_nfl','evF','2026-09-13 13:00-04',
  'Detroit Lions','New Orleans Saints',
  'h2h','Detroit Lions',null,0.7100,-245,0.6900,-230,-225,
  0.0200,0.0260,'MEDIUM',
  '{"basis":"epa_efficiency","sim_mean_margin":8.30,"sim_mean_total":47.50,
    "expected_home_points":27.90,"expected_away_points":19.60}');

-- ---------------------------------------------------------------- game G
-- The same whole-number shape on the HOME side, where it renders "-6."
insert into public.model_predictions
  (model_version, sport_key, event_id, commence_time, home_team, away_team,
   market, selection, point, model_prob, model_fair_american,
   market_prob_at_pred, market_am_at_pred, best_am_at_pred,
   model_edge, model_ev, context_quality, model_detail)
values
 ('nfl_game_v1','americanfootball_nfl','evG','2026-09-14 20:15-04',
  'Kansas City Chiefs','Denver Broncos',
  'spreads','Kansas City Chiefs',-6,0.5700,-133,0.5250,-110,-104,
  0.0450,0.0660,'MEDIUM',
  '{"basis":"epa_efficiency","sim_mean_margin":7.10,"sim_mean_total":44.00,
    "expected_home_points":25.55,"expected_away_points":18.45}'),
 ('nfl_game_v1','americanfootball_nfl','evG','2026-09-14 20:15-04',
  'Kansas City Chiefs','Denver Broncos',
  'h2h','Kansas City Chiefs',null,0.7400,-285,0.7200,-265,-260,
  0.0200,0.0240,'MEDIUM',
  '{"basis":"epa_efficiency","sim_mean_margin":7.10,"sim_mean_total":44.00,
    "expected_home_points":25.55,"expected_away_points":18.45}');
