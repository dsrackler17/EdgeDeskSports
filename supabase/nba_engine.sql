-- ===========================================================================
-- EdgeDesk NBA — the engine's warehouse, ledger and market tables (nbahist).
--
-- WHY THIS FILE EXISTS. The NBA engine (nba/, docs/engine/NBA.md) builds and
-- validates its models from committed files, the way the NHL engine does. This
-- schema is the queryable copy of what it builds, so the desk, the record and
-- any research screen can read the NBA warehouse through the same anon/RLS door
-- as every other EdgeDesk research table:
--
--   nbahist.games             one row per game (2002-03 →): scope (regular_season ·
--                             nba_cup_final · play_in · playoffs), period scores, venue,
--                             neutral/bubble flags, provenance, and ESPN's displayed
--                             spread (ref_line_home) — UNTIMESTAMPED, no book, no
--                             price: a diagnostic, never a market record
--   nbahist.team_games        two rows per game: box score, possessions, shot zones,
--                             transition proxy, rest / travel / time zone / altitude
--   nbahist.player_games      one row per player per game: minutes, box, starter,
--                             played, the DNP reason category (reason only when the
--                             player did not play — the source fills "coach's
--                             decision" on rows of players who did)
--   nbahist.lineup_seasons    five-man units per team-season: seconds, possessions,
--                             offensive / defensive / net rating and a shrunk net
--                             rating with its reliability (small samples shrink hard)
--   nbahist.player_ratings    the player-impact (RAPM) snapshots the slate used
--   nbahist.predictions       the append-only pregame ledger (nba/ledger): every
--                             published sheet, frozen before tip, with its model
--   nbahist.market_quotes     sportsbook quotes captured through the odds gateway,
--                             with the model probability at each book's own line,
--                             break-even and EV kept apart from the no-vig market
--                             probability. EMPTY until NBA prices are authorised.
--   nbahist.model_registry    every model version with its spec hash and record
--   nbahist.import_runs, meta, pipeline freshness
--   views: team_season_summary, player_season_summary, latest_predictions
--
-- TIME. known_at is blank on every historical row (first publication was never
-- recorded; nothing is backdated); assumed_available_at = start + 4 h; pit = RETRO.
--
-- WRITES. The service role only (nba/tools/sync_supabase.js over PostgREST).
-- Reads: anon and authenticated, except market_quotes (authenticated only: a
-- book's price is captured with credits and is not public research).
--
-- Idempotent, additive, ends in a report. Run it in the SQL editor; every row
-- of the report should read ok. Then add `nbahist` to Supabase > Project
-- Settings > API > Exposed schemas (supabase/expose_schemas.sql lists it).
-- Tested on a real PostgreSQL by tools/nba/nba_sql.test.js (`npm run nba:sql`).
-- ROLLBACK: supabase/nba_engine_rollback.sql drops the schema (nothing outside
-- it depends on it).
-- ===========================================================================

create schema if not exists nbahist;
grant usage on schema nbahist to anon, authenticated, service_role;

create table if not exists nbahist.meta (key text primary key, value text);
grant select, insert, update on nbahist.meta to service_role;
grant select on nbahist.meta to anon, authenticated;

create table if not exists nbahist.games (
  game_id               text primary key,
  season                smallint not null,
  game_type             text not null check (game_type in ('R','P','I')),
  scope                 text check (scope in ('regular_season','nba_cup_final','play_in','playoffs')),
  game_date             date not null,
  start_utc             timestamptz not null,
  neutral               boolean not null default false,
  bubble                boolean not null default false,
  home_id               text not null,
  away_id               text not null,
  home_score            smallint,
  away_score            smallint,
  overtimes             smallint,
  home_q                smallint[],
  away_q                smallint[],
  home_ot_points        smallint,
  away_ot_points        smallint,
  venue                 text,
  city                  text,
  state                 text,
  attendance            integer,
  ref_line_home         numeric(5,1),
  ref_line_note         text not null default 'ESPN displayed spread: no timestamp, no book, no price — diagnostic only',
  has_pbp               boolean not null default false,
  status                text not null check (status in ('FINAL','SCHEDULED')),
  source                text not null default 'S',
  known_at              timestamptz,
  assumed_available_at  timestamptz,
  pit                   text not null default 'RETRO',
  loaded_at             timestamptz not null default now()
);
create index if not exists nbahist_games_season_idx on nbahist.games (season, game_date);
create index if not exists nbahist_games_home_idx on nbahist.games (home_id, start_utc);
create index if not exists nbahist_games_away_idx on nbahist.games (away_id, start_utc);

-- added 2026-10-14 (the NBA Data Pack's scope rule); a no-op where the table was created with it
alter table nbahist.games add column if not exists scope text check (scope in ('regular_season','nba_cup_final','play_in','playoffs'));

create table if not exists nbahist.team_games (
  game_id        text not null references nbahist.games(game_id) on delete cascade,
  team_id        text not null,
  opp_id         text not null,
  season         smallint not null,
  start_utc      timestamptz not null,
  is_home        boolean not null,
  neutral        boolean not null default false,
  pts smallint, opp_pts smallint, minutes smallint,
  fgm smallint, fga smallint, fg3m smallint, fg3a smallint, ftm smallint, fta smallint,
  oreb smallint, dreb smallint, ast smallint, stl smallint, blk smallint, tov smallint, pf smallint,
  paint_pts smallint, fast_break_pts smallint, pts_off_tov smallint,
  possessions numeric(6,1),
  rim_a smallint, rim_m smallint, paint_a smallint, paint_m smallint, mid_a smallint, mid_m smallint,
  c3_a smallint, c3_m smallint, ab3_a smallint, ab3_m smallint, transition_fga smallint, transition_pts smallint, heaves smallint,
  city text, travel_km integer, tz_shift smallint, altitude_m integer, rest_days numeric(4,1), back_to_back boolean,
  games_in_7 smallint, road_streak smallint, home_streak smallint,
  assumed_available_at timestamptz,
  constraint nbahist_team_games_key primary key (game_id, team_id)
);
create index if not exists nbahist_team_games_team_idx on nbahist.team_games (team_id, start_utc);
create index if not exists nbahist_team_games_season_idx on nbahist.team_games (season, team_id);

create table if not exists nbahist.player_games (
  game_id      text not null references nbahist.games(game_id) on delete cascade,
  player_id    text not null,
  team_id      text not null,
  season       smallint not null,
  starter      boolean not null default false,
  played       boolean not null default false,
  dnp_reason   text check (dnp_reason is null or dnp_reason in ('INJURY','ILLNESS','REST','COACH','SUSPENSION','PERSONAL','ASSIGNMENT','UNKNOWN','UNLISTED')),
  minutes smallint, pts smallint, fgm smallint, fga smallint, fg3m smallint, fg3a smallint, ftm smallint, fta smallint,
  oreb smallint, dreb smallint, ast smallint, stl smallint, blk smallint, tov smallint, pf smallint, plus_minus smallint, ejected boolean,
  constraint nbahist_player_games_key primary key (game_id, player_id)
);
create index if not exists nbahist_player_games_player_idx on nbahist.player_games (player_id, season);
create index if not exists nbahist_player_games_team_idx on nbahist.player_games (team_id, season);

create table if not exists nbahist.players (
  player_id text primary key, name text, position text, last_team_id text, last_season smallint
);

create table if not exists nbahist.lineup_seasons (
  season         smallint not null,
  team_id        text not null,
  lineup_key     text not null,              -- the five player ids, sorted, space-separated
  players        text[] not null,
  seconds        integer not null,
  poss_off       numeric(7,1) not null,
  poss_def       numeric(7,1) not null,
  pts_for        integer not null,
  pts_against    integer not null,
  off_rating     numeric(6,1),
  def_rating     numeric(6,1),
  net_rating     numeric(6,1),
  net_shrunk     numeric(6,1),               -- net × poss/(poss + k): small samples shrink toward 0
  reliability    numeric(5,3),               -- poss/(poss + k)
  constraint nbahist_lineup_seasons_key primary key (season, team_id, lineup_key)
);
create index if not exists nbahist_lineup_seasons_team_idx on nbahist.lineup_seasons (team_id, season, seconds desc);

create table if not exists nbahist.player_ratings (
  player_id    text not null,
  as_of        date not null,
  model        text not null,
  off_impact   numeric(6,2),                 -- points per 100 possessions vs an average lineup
  def_impact   numeric(6,2),
  exp_minutes  numeric(5,1),
  team_id      text,
  constraint nbahist_player_ratings_key primary key (player_id, as_of, model)
);

create table if not exists nbahist.predictions (
  id                text primary key,          -- the sheet's content hash
  game_id           text not null,
  start_utc         timestamptz not null,
  recorded_at       timestamptz not null,
  model             text not null,
  p_home            numeric(7,5) not null check (p_home > 0 and p_home < 1),
  fair_spread_home  numeric(5,1),
  fair_total        numeric(6,1),
  exp_margin        numeric(6,2),
  exp_total         numeric(6,2),
  sd_margin         numeric(5,2),
  p_overtime        numeric(6,5),
  rotation_stale    boolean not null default false,
  check (recorded_at < start_utc)
);
create index if not exists nbahist_predictions_game_idx on nbahist.predictions (game_id, recorded_at desc);

create table if not exists nbahist.market_quotes (
  id               bigserial primary key,
  game_id          text not null,
  book             text not null,
  market           text not null check (market in ('moneyline','spread','total','team_total','first_half_spread','first_half_total','first_quarter_spread','first_quarter_total','player_prop')),
  side             text not null,
  line             numeric(6,1),
  american         integer not null check (abs(american) >= 100),
  decimal_odds     numeric(8,4) not null check (decimal_odds > 1),
  quote_time       timestamptz,
  captured_at      timestamptz not null,
  freshness        text check (freshness in ('FRESH','STALE')),
  break_even       numeric(7,5),
  model_p          numeric(7,5),
  model_push       numeric(7,5),
  market_novig_p   numeric(7,5),               -- the market's own probability, never mixed into the model's
  ev_vs_model      numeric(8,5),
  model_version    text,
  value_claims     text not null default 'DISABLED',
  unique (game_id, book, market, side, line, captured_at)
);
create index if not exists nbahist_market_quotes_game_idx on nbahist.market_quotes (game_id, captured_at desc);

create table if not exists nbahist.model_registry (
  model_id     text not null,
  version      text not null,
  track        text not null check (track in ('P','C')),
  spec_hash    text not null,
  record       jsonb not null,
  status       text not null,                 -- OUTCOME_VALIDATED / PROVISIONAL / SEALED_SELECTION_ONLY
  generated_at timestamptz not null,
  constraint nbahist_model_registry_key primary key (model_id, version, track)
);

create table if not exists nbahist.import_runs (
  run_id      text primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  seasons     smallint[],
  counts      jsonb,
  status      text not null default 'running' check (status in ('running','ok','failed')),
  note        text
);

-- analytical aggregates ------------------------------------------------------
-- per season AND scope: official regular-season aggregates exclude the NBA Cup
-- final, the Play-In and the playoffs (read them with scope = 'regular_season').
create or replace view nbahist.team_season_summary as
select tg.season, coalesce(g.scope, 'regular_season') as scope, tg.team_id,
       count(*)                                                            as games,
       round(100.0 * sum(tg.pts) / nullif(sum(tg.possessions), 0), 1)      as off_rating,
       round(100.0 * sum(tg.opp_pts) / nullif(sum(tg.possessions), 0), 1)  as def_rating,
       round(100.0 * (sum(tg.pts) - sum(tg.opp_pts)) / nullif(sum(tg.possessions), 0), 1) as net_rating,
       round(48.0 * sum(tg.possessions) / nullif(sum(tg.minutes), 0), 1)   as pace,
       round((sum(tg.fgm) + 0.5 * sum(tg.fg3m))::numeric / nullif(sum(tg.fga), 0), 4) as efg,
       round(sum(tg.pts)::numeric / nullif(2 * (sum(tg.fga) + 0.44 * sum(tg.fta)), 0), 4) as ts,
       round(sum(tg.tov)::numeric / nullif(sum(tg.possessions), 0), 4)     as tov_rate,
       round(sum(tg.ftm)::numeric / nullif(sum(tg.fga), 0), 4)             as ft_rate,
       round(sum(tg.fg3a)::numeric / nullif(sum(tg.fga), 0), 4)            as three_rate,
       round(sum(tg.rim_a)::numeric / nullif(sum(tg.rim_a + tg.paint_a + tg.mid_a + tg.c3_a + tg.ab3_a), 0), 4) as rim_share
from nbahist.team_games tg
join nbahist.games g on g.game_id = tg.game_id
where tg.pts is not null
group by tg.season, coalesce(g.scope, 'regular_season'), tg.team_id;

create or replace view nbahist.player_season_summary as
select pg.season, coalesce(g.scope, 'regular_season') as scope, pg.player_id, max(pg.team_id) as team_id,
       count(*) filter (where pg.played)                 as games,
       sum(pg.minutes)                                   as minutes,
       round(avg(pg.minutes) filter (where pg.played), 1) as mpg,
       round(36.0 * sum(pg.pts) / nullif(sum(pg.minutes), 0), 1)  as pts_per36,
       round(36.0 * sum(pg.oreb + pg.dreb) / nullif(sum(pg.minutes), 0), 1) as reb_per36,
       round(36.0 * sum(pg.ast) / nullif(sum(pg.minutes), 0), 1)  as ast_per36,
       round(sum(pg.pts)::numeric / nullif(2 * (sum(pg.fga) + 0.44 * sum(pg.fta)), 0), 4) as ts,
       count(*) filter (where not pg.played and pg.dnp_reason in ('INJURY','ILLNESS')) as games_missed_injury
from nbahist.player_games pg
join nbahist.games g on g.game_id = pg.game_id
group by pg.season, coalesce(g.scope, 'regular_season'), pg.player_id;

create or replace view nbahist.latest_predictions as
select distinct on (p.game_id) p.*
from nbahist.predictions p
order by p.game_id, p.recorded_at desc;

-- RLS -------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['games','team_games','player_games','players','lineup_seasons','player_ratings','predictions','model_registry','import_runs'] loop
    execute format('alter table nbahist.%I enable row level security', t);
    execute format('revoke all on nbahist.%I from anon, authenticated', t);
    execute format('grant select on nbahist.%I to anon, authenticated', t);
    execute format('grant all on nbahist.%I to service_role', t);
    execute format('drop policy if exists %I on nbahist.%I', 'nbahist_' || t || '_public_read', t);
    execute format('create policy %I on nbahist.%I for select to anon, authenticated using (true)', 'nbahist_' || t || '_public_read', t);
  end loop;
  alter table nbahist.market_quotes enable row level security;
  revoke all on nbahist.market_quotes from anon, authenticated;
  grant select on nbahist.market_quotes to authenticated;
  grant all on nbahist.market_quotes to service_role;
  drop policy if exists nbahist_market_quotes_members_read on nbahist.market_quotes;
  create policy nbahist_market_quotes_members_read on nbahist.market_quotes for select to authenticated using (true);
end $$;
grant select on nbahist.team_season_summary, nbahist.player_season_summary, nbahist.latest_predictions to anon, authenticated, service_role;
grant usage, select on all sequences in schema nbahist to service_role;

-- report --------------------------------------------------------------------
select 1 as row, 'schema nbahist exists' as check,
       case when exists (select 1 from information_schema.schemata where schema_name = 'nbahist') then 'ok' else 'CHECK THIS' end as result
union all select 2, 'every table exists',
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'nbahist' and c.relkind = 'r'
                    and c.relname in ('games','team_games','player_games','players','lineup_seasons','player_ratings','predictions','market_quotes','model_registry','import_runs','meta')) = 11
            then 'ok' else 'CHECK THIS' end
union all select 3, 'RLS is enabled on every table but meta',
       case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'nbahist' and c.relkind = 'r' and c.relrowsecurity) = 10 then 'ok' else 'CHECK THIS' end
union all select 4, 'no client write policy exists',
       case when not exists (select 1 from pg_policies where schemaname = 'nbahist' and cmd in ('INSERT','UPDATE','DELETE','ALL')) then 'ok' else 'CHECK THIS' end
union all select 5, 'market quotes are not readable by anon',
       case when not has_table_privilege('anon', 'nbahist.market_quotes', 'SELECT') then 'ok' else 'CHECK THIS' end
union all select 6, 'a prediction must be recorded before its game starts (constraint)',
       case when exists (select 1 from pg_constraint where conrelid = 'nbahist.predictions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%recorded_at < start_utc%') then 'ok' else 'CHECK THIS' end
union all select 7, 'lookup indexes installed',
       case when to_regclass('nbahist.nbahist_games_season_idx') is not null and to_regclass('nbahist.nbahist_team_games_team_idx') is not null
             and to_regclass('nbahist.nbahist_player_games_player_idx') is not null and to_regclass('nbahist.nbahist_predictions_game_idx') is not null
             and to_regclass('nbahist.nbahist_market_quotes_game_idx') is not null then 'ok' else 'CHECK THIS' end
union all select 8, 'service_role may write the nbahist.meta ledger',
       case when has_table_privilege('service_role', 'nbahist.meta', 'INSERT') and has_table_privilege('service_role', 'nbahist.meta', 'UPDATE') then 'ok' else 'CHECK THIS' end
union all select 9, 'nbahist schema is exposed to the API (project setting, not checkable here)',
       'ok (confirm Supabase > API > Exposed schemas lists nbahist)'
order by row;
