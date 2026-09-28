#!/usr/bin/env node
/* ===========================================================================
   supabase/bettor_decisions.sql, AGAINST A REAL POSTGRESQL, AS REAL READERS.

   The bankroll is private, a placed bet is private and write-once, the
   recommendation snapshot taken at placement can never be edited, and
   EdgeDesk's own decision snapshots are write-once, pregame-only and readable
   by every signed-in reader. This proves each claim by acting as reader A,
   reader B reaching for A's rows, anon, and the service role.

   Run: node tools/bettor/bettor_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('bettor decisions SQL');
const chk = T.chk;
const FILE = path.join(PG.ROOT, 'supabase', 'bettor_decisions.sql');
const DEP = path.join(PG.ROOT, 'supabase', 'bankroll_and_stakes.sql');
const SQL = fs.readFileSync(FILE, 'utf8');

/* ── STATIC: the folder's conventions ──────────────────────────────────── */
chk('no psql meta-commands', !/^\\/m.test(SQL));
chk('idempotent create statements', /create table if not exists/.test(SQL) && /create or replace function/.test(SQL) && /add column if not exists/.test(SQL));
chk('additive: nothing is dropped', !/\bdrop table\b/i.test(SQL) && !/\bdrop column\b/i.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL) && /order by 1;\s*$/.test(SQL));
chk('PostgREST is told to reload', /notify pgrst, 'reload schema'/.test(SQL));
chk('under the SQL editor paste limit (18 KB)', Buffer.byteLength(SQL) <= 18000, Buffer.byteLength(SQL));
chk('every private table is keyed to auth.uid()', (SQL.match(/user_id = auth\.uid\(\)/g) || []).length >= 4);
chk('it names its dependency', /apply supabase\/bankroll_and_stakes\.sql first/.test(SQL));

const db = PG.start('bettor');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const DAY = 86400000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const KICK = iso(2 * DAY);

try {
  /* without its dependency the file stops, naming it */
  const noDep = db.mustFail(() => db.applyFileAtomic(FILE));
  chk('without bankroll_and_stakes.sql it stops and names the file', /bankroll_and_stakes\.sql/.test(noDep || ''), noDep && noDep.slice(0, 300));

  db.sql('create table if not exists public.signals (sig_key text primary key, closing_sharp_fair numeric, closing_dec numeric, closing_at_observed timestamptz, result text, clv numeric, beat_close boolean);');
  db.applyFileAtomic(DEP);
  db.sql(`insert into auth.users (id, email) values ('${A}','a@example.com'), ('${B}','b@example.com');`);
  /* a reader who typed a base unit before this file existed keeps it */
  db.as(B, "insert into public.bankroll_settings (bankroll_amount, base_unit_amount) values (1000, 20);");

  let out = db.applyFileAtomic(FILE);
  chk('the migration applies over bankroll_and_stakes.sql', true);
  chk('every report row says ok', !/CHECK THIS/.test(out), out.slice(-600));
  out = db.applyFileAtomic(FILE);
  chk('and applies a second time without error, still all ok', !/CHECK THIS/.test(out));

  /* ── 1. the unit convention ─────────────────────────────────────────── */
  chk('an existing reader with a base unit keeps it (fixed)', db.as(B, 'select unit_mode from public.bankroll_settings;') === 'fixed');
  db.as(A, 'insert into public.bankroll_settings (bankroll_amount) values (2500);');
  chk('a new reader defaults to 1 unit = 1% of bankroll', db.as(A, "select unit_mode || '|' || unit_percent || '|' || max_active_exposure_units || '|' || exposure_limit_enabled || '|' || beginner_mode from public.bankroll_settings;") === 'percent|0.01|5|false|false');
  chk('re-running the file does not flip a reader back', (db.as(A, "update public.bankroll_settings set unit_mode = 'percent';"), db.applyFileAtomic(FILE), db.as(B, 'select unit_mode from public.bankroll_settings;')) === 'fixed');
  chk('a unit above 10% of bankroll is refused', db.mustFail(() => db.as(A, 'update public.bankroll_settings set unit_percent = 0.5;')) !== null);
  chk('an unknown unit mode is refused', db.mustFail(() => db.as(A, "update public.bankroll_settings set unit_mode = 'kelly';")) !== null);
  chk('reader B cannot read reader A’s bankroll', db.as(B, 'select count(*) from public.bankroll_settings where user_id = \'' + A + '\';') === '0');
  chk('anon reads no bankroll', db.anon('select count(*) from public.bankroll_settings;') === '0');

  /* ── 2. placed bets ──────────────────────────────────────────────────── */
  const rec = PG.lit(JSON.stringify({ decision: 'BET', bet_price: { side: 'away', line: 6.5, odds: -102, book: 'FanDuel' }, playable: { min_line: 5.5, max_odds: -115 } }));
  db.as(A, `insert into public.user_bets (bet_key, source, sport, game_id, home_team, away_team, kickoff, side, team, line, odds, book, units, stake_dollars, unit_value, recommendation_id, recommendation, entry_vs_recommendation, clv_points, result)
    values ('k1', 'edgedesk', 'CFB', '401866434', 'Wake Forest', 'NC State', '${KICK}', 'away', 'NC State', 5, -110, 'DraftKings', 0.5, 12.5, 25, 'bd_x', ${rec}::jsonb, 'OUTSIDE_RANGE', 9, 'win');`);
  chk('a reader records a bet', db.as(A, 'select count(*) from public.user_bets;') === '1');
  chk('a grade cannot arrive with the entry', db.as(A, "select coalesce(clv_points::text,'null') || '|' || coalesce(result,'null') from public.user_bets;") === 'null|null');
  chk('the owner is the caller, whatever the payload says', (db.as(A, `insert into public.user_bets (user_id, bet_key, sport, game_id, side, odds, units) values ('${B}', 'k2', 'CFB', 'g2', 'home', -110, 1);`),
    db.sql(`select user_id from public.user_bets where bet_key = 'k2';`)) === A);
  chk('the same bet key twice is refused', db.mustFail(() => db.as(A, "insert into public.user_bets (bet_key, sport, game_id, side, odds, units) values ('k1', 'CFB', 'g', 'home', -110, 1);")) !== null);
  chk('odds between -100 and +100 are refused', db.mustFail(() => db.as(A, "insert into public.user_bets (bet_key, sport, game_id, side, odds, units) values ('k3', 'CFB', 'g', 'home', -50, 1);")) !== null);
  chk('a bet placed in the future is refused', db.mustFail(() => db.as(A, `insert into public.user_bets (bet_key, sport, game_id, side, odds, units, placed_at) values ('k4', 'CFB', 'g', 'home', -110, 1, '${iso(DAY)}');`)) !== null);
  chk('the owner may add a note', (db.as(A, "update public.user_bets set notes = 'took +5 late' where bet_key = 'k1';"), db.as(A, "select notes from public.user_bets where bet_key = 'k1';")) === 'took +5 late');
  chk('the owner may void it', (db.as(A, "update public.user_bets set status = 'void' where bet_key = 'k2';"), db.as(A, "select status from public.user_bets where bet_key = 'k2';")) === 'void');
  chk('the line cannot be edited after the fact', db.mustFail(() => db.as(A, "update public.user_bets set line = 6.5 where bet_key = 'k1';")) !== null);
  chk('the recommendation snapshot cannot be edited', db.mustFail(() => db.as(A, "update public.user_bets set recommendation = '{}'::jsonb where bet_key = 'k1';")) !== null);
  chk('a reader cannot write their own grade', db.mustFail(() => db.as(A, "update public.user_bets set clv_points = 5 where bet_key = 'k1';")) !== null);
  chk('the service role writes the grade', (db.service("update public.user_bets set close_line = 4.5, clv_points = 0.5, result = 'win', units_won = 0.45, graded_at = now() where bet_key = 'k1';"),
    db.as(A, "select clv_points from public.user_bets where bet_key = 'k1';")) === '0.5');
  chk('even the service role cannot rewrite the entry', db.mustFail(() => db.service("update public.user_bets set odds = -105 where bet_key = 'k1';")) !== null);
  chk('reader B sees none of reader A’s bets', db.as(B, 'select count(*) from public.user_bets;') === '0');
  chk('reader B cannot void reader A’s bet', (db.as(B, "update public.user_bets set status = 'void' where bet_key = 'k1';"), db.sql("select status from public.user_bets where bet_key = 'k1';")) === 'open');
  chk('anon cannot read placed bets', db.mustFail(() => db.anon('select count(*) from public.user_bets;')) !== null || db.anon('select count(*) from public.user_bets;') === '0');
  chk('the owner’s CLV view shows the graded bet', db.as(A, "select average_clv from public.user_bet_clv where source = 'edgedesk';") === '0.50');

  /* ── 3. EdgeDesk's frozen decisions ──────────────────────────────────── */
  function snap(id, decision, units, evalAt, kick, line, odds) {
    return `insert into public.bettor_decision_snapshots (snapshot_id, sport, game_id, market_key, kickoff, evaluated_at, decision, reason_code, side, line, odds, book, units, decision_engine_version, config_version, validation_state, snapshot)
      values ('${id}', 'CFB', 'g9', 'CFB:spread', '${kick}', '${evalAt}', '${decision}', '${decision === 'BET' ? 'QUALIFIES' : 'PRICE_MOVED'}', 'away', ${line}, ${odds}, 'FanDuel', ${units}, 'edgedesk_bettor_decision_v1', 'bettor_decision_config_v1', 'CONSERVATIVE_DEFAULT_UNVALIDATED', '{}'::jsonb);`;
  }
  db.service(snap('s1', 'BET', 0.5, iso(-2 * 3600e3), KICK, 6.5, -102));
  db.service(snap('s2', 'PASS', 0, iso(-3600e3), KICK, 4.5, -110));
  chk('the service role syncs decision snapshots', db.sql('select count(*) from public.bettor_decision_snapshots;') === '2');
  chk('a signed-in reader reads them', db.as(A, 'select count(*) from public.bettor_decision_snapshots;') === '2');
  chk('anon does not', db.mustFail(() => db.anon('select count(*) from public.bettor_decision_snapshots;')) !== null || db.anon('select count(*) from public.bettor_decision_snapshots;') === '0');
  chk('a snapshot is never rewritten', db.mustFail(() => db.service("update public.bettor_decision_snapshots set units = 1 where snapshot_id = 's1';")) !== null);
  chk('a snapshot is never deleted', db.mustFail(() => db.service("delete from public.bettor_decision_snapshots where snapshot_id = 's1';")) !== null);
  chk('a post-kickoff snapshot is refused', db.mustFail(() => db.service(snap('s3', 'PASS', 0, iso(3 * DAY), KICK, 4.5, -110))) !== null);
  chk('units on a non-BET snapshot are refused', db.mustFail(() => db.service(snap('s4', 'PASS', 0.5, iso(-60e3), KICK, 4.5, -110))) !== null);
  chk('a BET above 1.00U is refused', db.mustFail(() => db.service(snap('s5', 'BET', 1.5, iso(-60e3), KICK, 6.5, -102))) !== null);
  chk('a reader cannot insert a decision', db.mustFail(() => db.as(A, snap('s6', 'BET', 0.25, iso(-60e3), KICK, 6.5, -102))) !== null);
  /* the v2 engine's vocabulary: LEAN and WATCH are decisions (never with units); v1 WAIT rows still read */
  db.service(snap('s7', 'LEAN', 0, iso(-3000e3), KICK, 6.5, -110));
  db.service(snap('s8', 'WATCH', 0, iso(-2900e3), KICK, 6.5, -110));
  chk('LEAN and WATCH snapshots are accepted (v2 engine)', db.sql("select count(*) from public.bettor_decision_snapshots where decision in ('LEAN', 'WATCH');") === '2');
  chk('a LEAN never carries units', db.mustFail(() => db.service(snap('s9', 'LEAN', 0.25, iso(-2800e3), KICK, 6.5, -110))) !== null);
  chk('an unknown decision word is refused', db.mustFail(() => db.service(snap('s10', 'MAYBE', 0, iso(-2700e3), KICK, 6.5, -110))) !== null);
  chk('the decision constraint is re-runnable with v2 rows on file (the file applies again, all ok)', (() => { try { return !/CHECK THIS/.test(db.applyFileAtomic(FILE)); } catch (e) { return false; } })());
  const tr = db.as(A, "select coalesce(from_decision,'—') || '>' || to_decision || '|' || coalesce(from_line::text,'') || '>' || to_line from public.bettor_decision_transitions where snapshot_id = 's2';");
  chk('the transition view reads BET → PASS with the line move', tr === 'BET>PASS|6.5>4.5', tr);
  db.service("insert into public.bettor_decision_grades (snapshot_id, units, odds, line, close_line, clv_points, result, units_won, calibrated_cover, graded_at) values ('s1', 0.5, -102, 6.5, 4.5, 2, 'win', 0.49, 0.53, now());");
  const perf = db.as(A, "select tier || '|' || bets || '|' || units_won || '|' || average_clv || '|' || sufficient_sample from public.bettor_decision_performance;");
  chk('the per-tier performance view reads the grade, and says the sample is short', /^0\.50U\|1\|0\.49\|2\.00\|(f|false)$/.test(perf), perf);
  chk('a grade is never rewritten', db.mustFail(() => db.service("update public.bettor_decision_grades set result = 'loss' where snapshot_id = 's1';")) !== null);
} catch (e) {
  chk('unexpected failure', false, String(e.message || e).slice(0, 600));
} finally {
  db.stop();
}
process.exit(T.done());
