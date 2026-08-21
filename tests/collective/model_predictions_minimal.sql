-- public.model_predictions as it exists in a project that predates
-- model_detail, model_edge and the price columns.
--
-- This is not a hypothetical shape. The live EdgeDesk table has no
-- model_detail column, and naming it directly made the exporter fail with
-- `column "model_detail" does not exist` -- no file at all, rather than a
-- file with two columns blank. The exporter reads through to_jsonb so that an
-- absent column is a NULL and not an error, and this fixture is what proves
-- it stays that way.

create table public.model_predictions (
  model_version  text    not null,
  sport_key      text    not null,
  event_id       text    not null,
  commence_time  timestamptz,
  home_team      text    not null,
  away_team      text    not null,
  market         text    not null,
  selection      text    not null,
  point          numeric,
  model_prob     numeric not null,
  primary key (model_version, event_id, market, selection)
);

insert into public.model_predictions values
 ('nfl_game_v1','americanfootball_nfl','evA','2026-09-09 20:15-04',
  'Seattle Seahawks','New England Patriots','spreads','Seattle Seahawks',-3.5,0.5600),
 ('nfl_game_v1','americanfootball_nfl','evA','2026-09-09 20:15-04',
  'Seattle Seahawks','New England Patriots','spreads','New England Patriots',3.5,0.4400),
 ('nfl_game_v1','americanfootball_nfl','evA','2026-09-09 20:15-04',
  'Seattle Seahawks','New England Patriots','h2h','Seattle Seahawks',null,0.6300),
 -- An away favourite again, so the sign is checked on the reduced shape too.
 ('nfl_game_v1','americanfootball_nfl','evB','2026-09-13 13:00-04',
  'Carolina Panthers','Chicago Bears','spreads','Chicago Bears',-2.5,0.5800),
 ('nfl_game_v1','americanfootball_nfl','evB','2026-09-13 13:00-04',
  'Carolina Panthers','Chicago Bears','spreads','Carolina Panthers',2.5,0.4200);
