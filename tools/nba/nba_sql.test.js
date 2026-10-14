#!/usr/bin/env node
/* ===========================================================================
   The NBA warehouse contract (supabase/nba_engine.sql) and the NBA odds row
   (supabase/nba_odds_sport.sql) on a real PostgreSQL.

     node tools/nba/nba_sql.test.js        (NBA_SQL_REQUIRED=1 in CI)

   Applies the contract twice (idempotent; every report row ok), loads the
   loader's REAL rows for a sample of games (so the mapping in
   nba/tools/sync_supabase.js is proven against the schema's types and
   checks), then attacks it: anon and authenticated may read the warehouse but
   not write it, anon may not read market quotes, a prediction recorded after
   its tip is refused, the aggregate views agree with hand arithmetic, and the
   rollback removes the schema. The odds row is registered DISABLED, the
   gateway refuses the NBA until an operator enables it, and re-applying the
   file leaves the operator's choice alone.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const T = PG.kit('NBA warehouse and odds row');
const ROOT = PG.ROOT;
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'nba_engine.sql'), 'utf8');
const ODDS = fs.readFileSync(path.join(ROOT, 'supabase', 'nba_odds_sport.sql'), 'utf8');

T.chk('the odds file only inserts, with on conflict do nothing', /insert into public\.odds_api_sports[\s\S]*on conflict \(sport_key\) do nothing/.test(ODDS) && !/\bupdate\b|\bdelete\b|\bdrop\b/i.test(ODDS.replace(/--[^\n]*/g, '')));
T.chk('the NBA row is inserted disabled', /values \('basketball_nba', 'nba', false,/.test(ODDS));
T.chk('the odds-row migration is the same file', fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261014120000_nba_odds_sport_row.sql'), 'utf8') === ODDS);
/* the nbahist schema is applied by hand (supabase/nba_engine.sql), never by a migration: creating it is the owner's decision */
T.chk('the warehouse schema is not a migration', !fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).some((f) => /nba_engine/.test(f)));
T.chk('the contract never grants a client write', !/grant\s+(insert|update|delete|all)[^;]*to\s+(anon|authenticated)/i.test(SQL));

const db = PG.start('nbasql');
if (db.skip) {
  if (process.env.NBA_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the LIVE layer did not run'); process.exit(T.done());
}
const lit = (v) => "'" + String(v).replace(/'/g, "''") + "'";
try {
  let out = db.applyFile(path.join(ROOT, 'supabase', 'nba_engine.sql'));
  T.chk('the contract applies and its report is all ok', !/CHECK THIS/.test(out) && (out.match(/\|ok/g) || []).length >= 9, out.slice(0, 800));
  out = db.applyFile(path.join(ROOT, 'supabase', 'nba_engine.sql'));
  T.chk('applying it twice is harmless (idempotent)', !/CHECK THIS/.test(out), out.slice(0, 400));

  /* the loader's real rows for a sample of 2025-26 games */
  const SY = require(path.join(ROOT, 'nba', 'tools', 'sync_supabase.js'));
  const games = SY.gameRows([2026]).filter((g) => g.status === 'FINAL').slice(0, 40);
  const ids = new Set(games.map((g) => g.game_id));
  const tg = SY.teamGameRows([2026]).filter((r) => ids.has(r.game_id));
  const pg = SY.playerGameRows(2026).filter((r) => ids.has(r.game_id));
  T.chk('the sample has games, team games and player games', games.length === 40 && tg.length === 80 && pg.length > 400, { g: games.length, tg: tg.length, pg: pg.length });
  /* only the columns the loader sends, as PostgREST does (a column it omits keeps its default) */
  const load = (table, rows) => { const cols = Object.keys(rows[0]).join(', '); return db.service(`insert into nbahist.${table} (${cols}) select ${cols} from json_populate_recordset(null::nbahist.${table}, ${lit(JSON.stringify(rows))}::json) on conflict do nothing;`); };
  let ok = true; try { load('games', games); load('team_games', tg); load('player_games', pg); } catch (e) { ok = false; T.chk('the loader\'s rows fit the schema', false, String(e.message).slice(0, 400)); }
  if (ok) T.chk('the loader\'s rows fit the schema (types, checks, keys)', db.sql('select count(*) from nbahist.player_games') === String(pg.length));

  /* reads and writes by role */
  T.chk('anon can read games', Number(db.anon('select count(*) from nbahist.games;').split('\n').pop()) === 40);
  T.mustFail ? T.mustFail('anon cannot insert a game', () => db.anon("insert into nbahist.games (game_id, season, game_type, game_date, start_utc, home_id, away_id, status) values ('x', 2026, 'R', '2026-01-01', now(), '1', '2', 'FINAL');"))
    : T.chk('anon cannot insert a game', (() => { try { db.anon("insert into nbahist.games (game_id, season, game_type, game_date, start_utc, home_id, away_id, status) values ('x', 2026, 'R', '2026-01-01', now(), '1', '2', 'FINAL');"); return false; } catch (_) { return true; } })());
  const fails = (fn) => { try { fn(); return false; } catch (_) { return true; } };
  T.chk('an authenticated reader cannot update the record', fails(() => db.as('00000000-0000-0000-0000-000000000001', "update nbahist.games set home_score = 0;")) || db.sql("select count(*) from nbahist.games where home_score = 0") === '0');
  db.service(`insert into nbahist.market_quotes (game_id, book, market, side, line, american, decimal_odds, captured_at, model_p, break_even) values (${lit(games[0].game_id)}, 'book', 'moneyline', 'home', null, -150, 1.6667, now(), 0.58, 0.6);`);
  T.chk('anon cannot read market quotes', fails(() => db.anon('select count(*) from nbahist.market_quotes;')));
  T.chk('an authenticated member can read market quotes', /1/.test(db.as('00000000-0000-0000-0000-000000000001', 'select count(*) from nbahist.market_quotes;')));
  T.chk('a quote below |100| American is refused', fails(() => db.service(`insert into nbahist.market_quotes (game_id, book, market, side, american, decimal_odds, captured_at) values ('g', 'b', 'moneyline', 'home', 50, 1.5, now());`)));

  /* the pregame ledger: a sheet recorded at or after tip is refused */
  const g0 = games[0];
  T.chk('a prediction before tip is accepted', !fails(() => db.service(`insert into nbahist.predictions (id, game_id, start_utc, recorded_at, model, p_home) values ('a1', ${lit(g0.game_id)}, ${lit(g0.start_utc)}, (${lit(g0.start_utc)}::timestamptz - interval '1 hour'), 'm', 0.6);`)));
  T.chk('a prediction recorded after tip is refused', fails(() => db.service(`insert into nbahist.predictions (id, game_id, start_utc, recorded_at, model, p_home) values ('a2', ${lit(g0.game_id)}, ${lit(g0.start_utc)}, (${lit(g0.start_utc)}::timestamptz + interval '1 minute'), 'm', 0.6);`)));

  /* the aggregate view against hand arithmetic */
  const t0 = tg[0].team_id; const mine = tg.filter((r) => r.team_id === t0);
  const ortg = Math.round(1000 * mine.reduce((a, r) => a + r.pts, 0) / mine.reduce((a, r) => a + r.possessions, 0)) / 10;
  const got = Number(db.sql(`select off_rating from nbahist.team_season_summary where season = 2026 and team_id = ${lit(t0)}`));
  T.chk('team_season_summary off_rating matches hand arithmetic', Math.abs(got - ortg) < 0.051, { got, want: ortg });

  /* rollback */
  db.applyFile(path.join(ROOT, 'supabase', 'nba_engine_rollback.sql'));
  T.chk('the rollback removes the schema', db.sql("select count(*) from information_schema.schemata where schema_name = 'nbahist'") === '0');

  /* the odds row through the real gateway contract */
  db.sql(`create schema if not exists cron;
    create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
    create or replace function cron.alter_job(job_id bigint, schedule text default null, command text default null, database text default null, username text default null, active boolean default null) returns void language sql as $$ update cron.job set active = coalesce(alter_job.active, cron.job.active) where jobid = job_id $$;
    create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
    create or replace function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;`);
  db.applyFile(path.join(ROOT, 'supabase', 'odds_api_emergency_stop.sql'));
  db.applyFile(path.join(ROOT, 'supabase', 'odds_api_gateway.sql'));
  out = db.applyFile(path.join(ROOT, 'supabase', 'nba_odds_sport.sql'));
  T.chk('the odds row applies and its report is all ok', !/CHECK THIS/.test(out) && (out.match(/\|ok$/gm) || []).length === 2, out);
  db.sql("update public.odds_api_config set odds_api_enabled = true where id = 1");
  const acq = () => JSON.parse(db.sql("select public.odds_api_acquire('{\"caller\":\"nba_slate\",\"category\":\"featured\",\"sport_key\":\"basketball_nba\"}'::jsonb)"));
  let a = acq();
  T.chk('the gateway refuses the NBA while the row is disabled', a.decision === 'denied_sport', a);
  db.sql("select public.odds_api_set_sport('basketball_nba', true)");
  a = acq();
  T.chk('once authorised, the refusal is no longer the sport', a.decision !== 'denied_sport', a.decision);
  db.applyFile(path.join(ROOT, 'supabase', 'nba_odds_sport.sql'));
  T.chk('re-applying the odds file leaves the operator\'s choice alone', db.sql("select enabled from public.odds_api_sports where sport_key = 'basketball_nba'") === 't');
} catch (e) { T.chk('the run completed', false, String(e.message).slice(0, 600)); }
finally { db.stop(); }
process.exit(T.done());
