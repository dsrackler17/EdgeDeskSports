#!/usr/bin/env node
/* ===========================================================================
   supabase/player_props.sql + player_props_watchlist.sql, AGAINST A REAL
   POSTGRESQL, AS REAL READERS.

   The prop ledger is write-once, readable by signed-in readers only, written
   by the service role only; a quote's identity (sport, game, player, market,
   line, side, book, capture time) is unique; an impossible price or line is
   refused; a decision recorded at or after kickoff is refused; units only on a
   BET. The watchlist is private to its owner. Each claim is proved by acting
   as reader A, reader B, anon and the service role.

   Run: node tools/props/player_props_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('player props SQL');
const chk = T.chk;
const FILE = path.join(PG.ROOT, 'supabase', 'player_props.sql');
const WATCH = path.join(PG.ROOT, 'supabase', 'player_props_watchlist.sql');
const SQL = fs.readFileSync(FILE, 'utf8'), WSQL = fs.readFileSync(WATCH, 'utf8');

/* ── STATIC: the folder's conventions ──────────────────────────────────── */
[['player_props.sql', SQL], ['player_props_watchlist.sql', WSQL]].forEach(([n, s]) => {
  chk(n + ': no psql meta-commands', !/^\\/m.test(s));
  chk(n + ': idempotent create statements', /create table if not exists/.test(s) && /create or replace function/.test(s));
  chk(n + ': additive — nothing is dropped', !/\bdrop table\b/i.test(s) && !/\bdrop column\b/i.test(s));
  chk(n + ': it ends in a report', /CHECK THIS/.test(s) && /order by 1;\s*$/.test(s));
  chk(n + ': PostgREST is told to reload', /notify pgrst, 'reload schema'/.test(s));
  chk(n + ': under the SQL editor paste limit (18 KB)', Buffer.byteLength(s) <= 18000, Buffer.byteLength(s));
});
chk('the watchlist names its dependency', /apply supabase\/player_props\.sql first/.test(WSQL));
chk('the watchlist is keyed to auth.uid()', (WSQL.match(/user_id = auth\.uid\(\)/g) || []).length >= 3);

const db = PG.start('props');
if (db.skip) {
  if (process.env.PLAYER_PROPS_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done());
}

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const DAY = 86400000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const KICK = iso(2 * DAY);
try {
  const noDep = db.mustFail(() => db.applyFileAtomic(WATCH));
  chk('the watchlist without player_props.sql stops and names the file', /player_props\.sql/.test(noDep || ''), noDep && noDep.slice(0, 200));
  let out = db.applyFileAtomic(FILE);
  chk('player_props.sql applies; every report row says ok', !/CHECK THIS/.test(out), out.slice(-500));
  out = db.applyFileAtomic(FILE);
  chk('and applies a second time, still all ok', !/CHECK THIS/.test(out));
  out = db.applyFileAtomic(WATCH);
  chk('the watchlist applies; every report row says ok', !/CHECK THIS/.test(out), out.slice(-400));
  chk('and applies a second time', !/CHECK THIS/.test(db.applyFileAtomic(WATCH)));
  db.sql(`insert into auth.users (id, email) values ('${A}','a@example.com'), ('${B}','b@example.com');`);

  /* ── quotes ───────────────────────────────────────────────────────────── */
  const T0 = iso(-DAY);
  const q = (id, over) => `insert into public.player_prop_quotes (quote_id, sport, game_id, player_id, player_key, player_name, market, line, side, book, american, quoted_at, captured_at, kickoff)
    values ('${id}', 'nfl', '2026_04_ATL_NO', '00-0038542', '00-0038542', 'Bijan Robinson', 'rush_yds', 84.5, 'over', 'draftkings', ${over}, '${T0}', '${T0}', '${KICK}');`;
  db.service(q('q1', -105));
  chk('the service role writes a quote', db.sql('select count(*) from public.player_prop_quotes;') === '1');
  chk('the same identity (same capture time) twice is refused', db.mustFail(() => db.service(q('q2', -110))) !== null);
  chk('a price between -100 and +100 is refused', db.mustFail(() => db.service(`insert into public.player_prop_quotes (quote_id, sport, game_id, player_key, player_name, market, line, side, book, american, captured_at) values ('q3','nfl','g','name:x','X','rush_yds',70.5,'over','fanduel',50,now());`)) !== null);
  chk('a line that is not a half point is refused', db.mustFail(() => db.service(`insert into public.player_prop_quotes (quote_id, sport, game_id, player_key, player_name, market, line, side, book, american, captured_at) values ('q4','nfl','g','name:x','X','rush_yds',70.3,'over','fanduel',-110,now());`)) !== null);
  chk('a side other than over/under is refused', db.mustFail(() => db.service(`insert into public.player_prop_quotes (quote_id, sport, game_id, player_key, player_name, market, line, side, book, american, captured_at) values ('q5','nfl','g','name:x','X','rush_yds',70.5,'home','fanduel',-110,now());`)) !== null);
  chk('player_key must equal player_id when one is known', db.mustFail(() => db.service(`insert into public.player_prop_quotes (quote_id, sport, game_id, player_id, player_key, player_name, market, line, side, book, american, captured_at) values ('q6','nfl','g','00-1','00-2','X','rush_yds',70.5,'over','fanduel',-110,now());`)) !== null);
  db.service(`insert into public.player_prop_quotes (quote_id, sport, game_id, player_key, player_name, market, line, side, book, american, captured_at) values ('q7','nfl','2026_04_ATL_NO','name:totally unknown','Totally Unknown','anytime_td',0.5,'over','fanduel',400,now());`);
  chk('an unmapped name is kept under its name key', db.sql("select player_key from public.player_prop_quotes where quote_id = 'q7';") === 'name:totally unknown');
  chk('a quote is write-once (update refused)', db.mustFail(() => db.service("update public.player_prop_quotes set american = -120 where quote_id = 'q1';")) !== null);
  chk('and never deleted', db.mustFail(() => db.service("delete from public.player_prop_quotes where quote_id = 'q1';")) !== null);
  chk('a signed-in reader reads quotes', db.as(A, 'select count(*) from public.player_prop_quotes;') === '2');
  chk('anon reads nothing', db.mustFail(() => db.anon('select count(*) from public.player_prop_quotes;')) !== null || db.anon('select count(*) from public.player_prop_quotes;') === '0');
  chk('a reader cannot write a quote', db.mustFail(() => db.as(A, q('q8', -110).replace("'q8'", "'q8'"))) !== null);
  db.service(`insert into public.player_prop_quotes (quote_id, sport, game_id, player_id, player_key, player_name, market, line, side, book, american, captured_at, kickoff) values ('q9','nfl','2026_04_ATL_NO','00-0038542','00-0038542','Bijan Robinson','rush_yds',86.5,'over','draftkings',-110,'${iso(-DAY / 2)}','${KICK}');`);
  chk('latest view: one row per identity, the newest capture', db.as(A, "select line || '|' || american from public.player_prop_quotes_latest where book = 'draftkings' and line = 86.5;") === '86.5|-110');
  chk('movement view: open 84.5 → current 86.5', db.as(A, "select open_line || '>' || current_line || '|' || changes from public.player_prop_line_movement where book = 'draftkings';") === '84.5>86.5|2');

  /* ── evaluations and results ─────────────────────────────────────────── */
  const ev = (id, dec, units, at, kick) => `insert into public.player_prop_evaluations (evaluation_id, kind, selection_key, prop_id, sport, game_id, kickoff, player_id, market, evaluated_at, decision, units, probability_source, side, line, american, book, p_side, ev, edge_pp)
    values ('${id}', 'qualified', 'sk_${id}', 'nfl|2026_04_ATL_NO|00-0038542|rush_yds', 'nfl', '2026_04_ATL_NO', '${kick || KICK}', '00-0038542', 'rush_yds', '${at || iso(-DAY)}', '${dec}', ${units}, 'model_estimated', 'over', 84.5, -105, 'draftkings', 0.56, 0.07, 4.6);`;
  db.service(ev('e1', 'BET', 0.25));
  chk('a BET record is written', db.as(A, 'select decision || units from public.player_prop_evaluations;') === 'BET0.25');
  chk('units on a non-BET are refused', db.mustFail(() => db.service(ev('e2', 'LEAN', 0.25))) !== null);
  chk('a decision recorded after kickoff is refused', db.mustFail(() => db.service(ev('e3', 'BET', 0.25, iso(-DAY), iso(-2 * DAY)))) !== null);
  chk('an evaluation is write-once', db.mustFail(() => db.service("update public.player_prop_evaluations set units = 1 where evaluation_id = 'e1';")) !== null);
  chk('a reader cannot write an evaluation', db.mustFail(() => db.as(A, ev('e4', 'PASS', 0))) !== null);
  db.service("insert into public.player_prop_results (evaluation_id, kind, result, stat_value, units, units_won, prob_clv_pp, beat_close, graded_at) values ('e1', 'qualified', 'WIN', 96, 0.25, 0.238, 1.8, true, now());");
  chk('a result is recorded against its evaluation', db.as(A, 'select result from public.player_prop_results;') === 'WIN');
  chk('a result for an unknown evaluation is refused', db.mustFail(() => db.service("insert into public.player_prop_results (evaluation_id, kind, result, graded_at) values ('nope', 'qualified', 'WIN', now());")) !== null);
  chk('an unknown result word is refused', db.mustFail(() => db.service("insert into public.player_prop_results (evaluation_id, kind, result, graded_at) values ('e1', 'qualified', 'CASHED', now());")) !== null);
  chk('the performance view reads the graded record', db.as(A, "select wins || '-' || losses || '|' || units_won from public.player_prop_performance;") === '1-0|0.238');

  /* ── the watchlist ───────────────────────────────────────────────────── */
  db.as(A, "insert into public.player_prop_watchlist (kind, item_key, league, label) values ('player', '00-0038542', 'nfl', 'Bijan Robinson'), ('prop', 'nfl|2026_04_ATL_NO|00-0038542|rush_yds', 'nfl', null);");
  chk('a reader stars a player and a prop', db.as(A, 'select count(*) from public.player_prop_watchlist;') === '2');
  chk('the owner is the caller, whatever the payload says', (db.as(A, `insert into public.player_prop_watchlist (user_id, kind, item_key, league) values ('${B}', 'game', '2026_04_ATL_NO', 'nfl');`), db.sql("select user_id from public.player_prop_watchlist where kind = 'game';")) === A);
  chk('reader B sees none of reader A’s stars', db.as(B, 'select count(*) from public.player_prop_watchlist;') === '0');
  chk('reader B cannot delete them', (db.as(B, "delete from public.player_prop_watchlist where item_key = '00-0038542';"), db.sql('select count(*) from public.player_prop_watchlist;')) === '3');
  chk('the same star twice is refused', db.mustFail(() => db.as(A, "insert into public.player_prop_watchlist (kind, item_key, league) values ('player', '00-0038542', 'nfl');")) !== null);
  chk('an unknown kind is refused', db.mustFail(() => db.as(A, "insert into public.player_prop_watchlist (kind, item_key, league) values ('team', 'ATL', 'nfl');")) !== null);
  chk('a star has nothing to update', db.mustFail(() => db.as(A, "update public.player_prop_watchlist set label = 'x';")) !== null);
  db.as(A, "delete from public.player_prop_watchlist where item_key = '00-0038542';");
  chk('the owner un-stars', db.as(A, 'select count(*) from public.player_prop_watchlist;') === '2');
  chk('anon reads no stars', db.mustFail(() => db.anon('select count(*) from public.player_prop_watchlist;')) !== null || db.anon('select count(*) from public.player_prop_watchlist;') === '0');
} catch (e) {
  chk('the live layer ran without an unexpected error', false, String(e && e.stack || e).slice(0, 800));
} finally { db.stop(); }
process.exit(T.done());
