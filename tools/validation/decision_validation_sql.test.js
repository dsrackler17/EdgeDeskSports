#!/usr/bin/env node
/* ===========================================================================
   supabase/decision_validation.sql, AGAINST A REAL POSTGRESQL.

   Version columns come out of the frozen snapshot without UPDATEing it;
   every decision class is graded into a write-once table that refuses a
   post-kickoff decision and a "close" captured before its own evaluation;
   the validation view keeps evaluation modes apart and labels its sample.
   The rows the build writes (lib/edgedesk_decision_track.js gradeEvaluation,
   through football/cfb_terminal/decisions_sync.js evaluationRow) insert.

   Run: node tools/validation/decision_validation_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SYNC = require(path.join(PG.ROOT, 'football', 'cfb_terminal', 'decisions_sync.js'));

const T = PG.kit('decision validation SQL');
const chk = T.chk;
const FILE = path.join(PG.ROOT, 'supabase', 'decision_validation.sql');
const DEP0 = path.join(PG.ROOT, 'supabase', 'bankroll_and_stakes.sql');
const DEP = path.join(PG.ROOT, 'supabase', 'bettor_decisions.sql');
const SQL = fs.readFileSync(FILE, 'utf8');

/* ── STATIC: the folder's conventions ──────────────────────────────────── */
chk('no psql meta-commands', !/^\\/m.test(SQL));
chk('idempotent', /create table if not exists/.test(SQL) && /add column if not exists/.test(SQL) && /create or replace view/.test(SQL));
chk('additive: nothing is dropped but triggers and policies it re-creates', !/\bdrop table\b/i.test(SQL) && !/\bdrop column\b/i.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL) && /order by 1;\s*$/.test(SQL));
chk('PostgREST is told to reload', /notify pgrst, 'reload schema'/.test(SQL));
chk('under the SQL editor paste limit (18 KB)', Buffer.byteLength(SQL) <= 18000, Buffer.byteLength(SQL));
chk('it names its dependency', /apply supabase\/bettor_decisions\.sql first/.test(SQL));
chk('every column the sync sends exists in the table', SYNC.EVAL_COLS.every((c) => new RegExp('\\n\\s+' + c + '\\s').test(SQL)), SYNC.EVAL_COLS.filter((c) => !new RegExp('\\n\\s+' + c + '\\s').test(SQL)));

const db = PG.start('decval');
if (db.skip) {
  /* CI sets the flag: there, a missing Postgres is a failure, not a skip */
  if (process.env.DECISION_VALIDATION_SQL_REQUIRED === '1') chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done());
}

const DAY = 86400000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const KICK = iso(2 * DAY);
const A = '00000000-0000-0000-0000-00000000000a';

try {
  const noDep = db.mustFail(() => db.applyFileAtomic(FILE));
  chk('without bettor_decisions.sql it stops and names the file', /bettor_decisions\.sql/.test(noDep || ''), noDep && noDep.slice(0, 300));
  db.sql('create table if not exists public.signals (sig_key text primary key, closing_sharp_fair numeric, closing_dec numeric, closing_at_observed timestamptz, result text, clv numeric, beat_close boolean);');
  db.applyFileAtomic(DEP0);
  db.applyFileAtomic(DEP);
  db.sql(`insert into auth.users (id, email) values ('${A}','a@example.com');`);

  /* a snapshot written BEFORE this file existed (the old shape) */
  function snap(id, decision, units, evalAt, body) {
    return `insert into public.bettor_decision_snapshots (snapshot_id, sport, game_id, market_key, kickoff, evaluated_at, decision, reason_code, side, line, odds, book, units, decision_engine_version, config_version, validation_state, snapshot)
      values ('${id}', 'CFB', 'g-${id}', 'CFB:spread', '${KICK}', '${evalAt}', '${decision}', 'X', 'away', 6.5, -110, 'FanDuel', ${units}, 'edgedesk_football_decision_v2', 'football_decision_config_v2', 'CONSERVATIVE_DEFAULT_UNVALIDATED', ${PG.lit(JSON.stringify(body || {}))}::jsonb);`;
  }
  db.service(snap('old1', 'PASS', 0, iso(-3 * 3600e3), {}));

  let out = db.applyFileAtomic(FILE);
  chk('the migration applies over bettor_decisions.sql with rows on file', !/CHECK THIS/.test(out), out.slice(-500));
  out = db.applyFileAtomic(FILE);
  chk('and applies a second time, still all ok', !/CHECK THIS/.test(out));
  chk('the old row reads LIVE with no version key (nothing was rewritten)', db.sql("select evaluation_mode || '|' || coalesce(version_key, 'null') from public.bettor_decision_snapshots where snapshot_id = 'old1';") === 'LIVE|null');

  /* ── 1. versions come from the snapshot itself ───────────────────────── */
  db.service(snap('n1', 'BET', 0.5, iso(-2 * 3600e3), { evaluation_mode: 'LIVE', data_snapshot_at: iso(-2.1 * 3600e3), pricing_model_version: 'edgedesk_quote_ev_v1', versions: { version_key: 'dv_abc12345' } }));
  chk('version columns are read out of the frozen snapshot', db.sql("select version_key || '|' || pricing_model_version || '|' || evaluation_mode from public.bettor_decision_snapshots where snapshot_id = 'n1';") === 'dv_abc12345|edgedesk_quote_ev_v1|LIVE');
  chk('the snapshot is still write-once', db.mustFail(() => db.service("update public.bettor_decision_snapshots set units = 1 where snapshot_id = 'n1';")) !== null);
  chk('a reader cannot write a generated column either', db.mustFail(() => db.service("update public.bettor_decision_snapshots set snapshot = '{}'::jsonb where snapshot_id = 'n1';")) !== null);

  /* ── 2. every decision class, graded ─────────────────────────────────── */
  function ev(o) {
    const e = Object.assign({ snapshot_id: 'n1', game_id: 'g-n1', sport: 'CFB', market_type: 'spread', evaluation_mode: 'LIVE', decision: 'BET', reason_code: 'QUALIFIES', units: 0.5, side: 'away',
      evaluated_line: 6.5, evaluated_odds: -110, evaluated_book: 'FanDuel', bet_line: 6.5, bet_odds: -110, open_line: 7, close_line: 4.5, close_sharp_line: null, close_captured_at: iso(DAY),
      clv_points: 2, clv_sharp_points: null, clv_price_pp: 5.1, clv_ev: 0.05, result: 'win', units_won: 0.4545, flat_units_won_hypothetical: 0.9091, predicted: 0.56, break_even: 0.5238,
      edge_pp: 4.2, calibrated_ev: 0.06, decision_ev: 0.06, decision_confidence: 72, probability_source: 'partially_calibrated', reliability: 84, market_quality: 'VERIFIED',
      model_version: 'm', calibration_version: 'c', pricing_version: 'p', rules_version: 'r', engine_version: 'e', version_key: 'dv_abc12345', evaluated_at: iso(-2 * 3600e3), kickoff: KICK,
      unit_of_analysis: 'first_per_class', graded_at: iso(3 * DAY) }, o || {});
    const row = SYNC.evaluationRow(e);
    const cols = Object.keys(row);
    const vals = cols.map((c) => (row[c] == null ? 'null' : (c === 'evaluation' ? PG.lit(JSON.stringify(row[c])) + '::jsonb' : (typeof row[c] === 'number' ? String(row[c]) : PG.lit(String(row[c]))))));
    return 'insert into public.bettor_decision_evaluations (' + cols.join(', ') + ') values (' + vals.join(', ') + ');';
  }
  db.service(ev());
  chk('the build’s own evaluation row inserts through the sync mapping', db.sql('select count(*) from public.bettor_decision_evaluations;') === '1');
  db.service(snap('n2', 'LEAN', 0, iso(-3600e3)));
  db.service(ev({ snapshot_id: 'n2', game_id: 'g-n2', decision: 'LEAN', units: 0, bet_line: null, bet_odds: null, units_won: null, result: 'loss', flat_units_won_hypothetical: -1, clv_points: -0.5, evaluated_at: iso(-3600e3) }));
  chk('a LEAN is graded as a hypothetical, with no units', db.sql("select units || '|' || coalesce(units_won::text, 'null') || '|' || flat_units_won_hypothetical from public.bettor_decision_evaluations where snapshot_id = 'n2';") === '0|null|-1');
  chk('a LEAN with units is refused', db.mustFail(() => db.service(ev({ snapshot_id: 'n2', decision: 'LEAN', units: 0.25 }))) !== null);
  chk('a BET without a bet line is refused', db.mustFail(() => { db.service(snap('n3', 'BET', 0.25, iso(-3600e3))); db.service(ev({ snapshot_id: 'n3', bet_line: null })); }) !== null);
  chk('NO_DECISION is not gradeable', db.mustFail(() => { db.service(snap('n4', 'NO_DECISION', 0, iso(-3600e3))); db.service(ev({ snapshot_id: 'n4', decision: 'NO_DECISION', units: 0, bet_line: null })); }) !== null);
  chk('an evaluation of an unknown snapshot is refused', db.mustFail(() => db.service(ev({ snapshot_id: 'nope' }))) !== null);
  db.service(snap('n5', 'PASS', 0, iso(-3600e3)));
  chk('a "close" captured before its own evaluation is refused', db.mustFail(() => db.service(ev({ snapshot_id: 'n5', decision: 'PASS', units: 0, bet_line: null, bet_odds: null, close_captured_at: iso(-5 * 3600e3), evaluated_at: iso(-3600e3) }))) !== null);
  db.service(snap('n6', 'PASS', 0, iso(-3600e3)));
  chk('a decision after kickoff is refused', db.mustFail(() => db.service(ev({ snapshot_id: 'n6', decision: 'PASS', units: 0, bet_line: null, bet_odds: null, evaluated_at: iso(3 * DAY) }))) !== null);
  chk('an unknown evaluation mode is refused', db.mustFail(() => db.service(ev({ snapshot_id: 'n6', decision: 'PASS', units: 0, bet_line: null, bet_odds: null, evaluation_mode: 'VIBES' }))) !== null);
  chk('an evaluation is never rewritten', db.mustFail(() => db.service("update public.bettor_decision_evaluations set result = 'loss' where snapshot_id = 'n1';")) !== null);
  chk('… or deleted', db.mustFail(() => db.service("delete from public.bettor_decision_evaluations where snapshot_id = 'n1';")) !== null);
  chk('a signed-in reader reads evaluations', db.as(A, 'select count(*) from public.bettor_decision_evaluations;') === '2');
  chk('a reader cannot write one', db.mustFail(() => db.as(A, ev({ snapshot_id: 'n6', decision: 'PASS', units: 0, bet_line: null, bet_odds: null }))) !== null);
  chk('anon reads none', db.mustFail(() => db.anon('select count(*) from public.bettor_decision_evaluations;')) !== null || db.anon('select count(*) from public.bettor_decision_evaluations;') === '0');

  /* ── 3. the validation view keeps modes apart and labels its sample ───── */
  db.service(snap('b1', 'BET', 0.5, iso(-3600e3)));
  db.service(ev({ snapshot_id: 'b1', game_id: 'g-b1', evaluation_mode: 'BACKTEST', evaluated_at: iso(-3600e3) }));
  const v = db.as(A, "select evaluation_mode || ':' || decision || ':' || n || ':' || sample_state from public.bettor_decision_validation order by 1;").split('\n');
  chk('one row per mode × class: BACKTEST and LIVE never summed', v.length === 3 && v.some((x) => /^BACKTEST:BET:1:/.test(x)) && v.some((x) => /^LIVE:BET:1:/.test(x)) && v.some((x) => /^LIVE:LEAN:1:/.test(x)), v);
  chk('every row carries its sample state', v.every((x) => /DESCRIPTIVE_ONLY$/.test(x)), v);
  const clv = db.as(A, "select clv_n || '|' || clv_mean || '|' || clv_beat || '|' || clv_lose from public.bettor_decision_validation where evaluation_mode = 'LIVE' and decision = 'BET';");
  chk('CLV mean and beat / lose counts', clv === '1|2.000|1|0', clv);
} catch (e) {
  chk('unexpected failure', false, String(e.message || e).slice(0, 600));
} finally {
  db.stop();
}
process.exit(T.done());
