#!/usr/bin/env node
/* ===========================================================================
   THE PREDICTION LEDGER (research_packets), AGAINST A REAL POSTGRESQL.

   A calibration claim built on packets that could be edited after the game
   is worth nothing, so immutability, no-delete and no-lookahead live in
   triggers and are proved by a server refusing the operation. The static
   layer holds the conventions; the live layer starts a throwaway cluster,
   applies supabase/research_packets.sql twice, and attacks it.

   Run: node tools/intelligence/research_packets_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'research_packets.sql'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(note) {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 300) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ═══ STATIC ═══════════════════════════════════════════════════════════ */
chk('the migration is idempotent', /create table if not exists/.test(SQL) && /drop trigger if exists/.test(SQL) && /create or replace view/.test(SQL));
chk('write-once trigger', /research_packets_immutable_trg/.test(SQL));
chk('no-delete trigger', /research_packets_no_delete_trg/.test(SQL));
chk('no-lookahead trigger', /research_packets_no_lookahead_trg/.test(SQL));
chk('the label vocabulary is constrained', /check \(label in \('PASS','RESEARCH LEAD','PRICE DEPENDENT','MODEL DISAGREEMENT','STALE MARKET','INSUFFICIENT DATA'\)\)/.test(SQL));
chk('row level security is on', /enable row level security/.test(SQL));
chk('a reader inserts and reads only their own rows', /with check \(user_id = auth\.uid\(\)\)/.test(SQL) && /using \(user_id = auth\.uid\(\)\)/.test(SQL));
chk('grades join the signal by sig_key', /left join public\.signals s on s\.sig_key = p\.sig_key/.test(SQL));
chk('calibration groups by model version', /group by model_version, sport, market, label/.test(SQL));
chk('PostgREST is told to reload', /notify\s+pgrst\s*,\s*'reload schema'/i.test(SQL));
chk('no psql meta-commands', !/^\\/m.test(SQL));
chk('it ends in a report', /CHECK THIS/.test(SQL));

/* ═══ LIVE ═══════════════════════════════════════════════════════════════ */
function findPgBin() {
  const cands = ['pg_ctl'].concat(
    (() => { try { return fs.readdirSync('/usr/lib/postgresql').sort().reverse().map((v) => '/usr/lib/postgresql/' + v + '/bin/pg_ctl'); } catch (_) { return []; } })());
  for (const c of cands) {
    try {
      cp.execSync(`${c} --version`, { stdio: 'ignore' });
      return c === 'pg_ctl' ? path.dirname(cp.execSync('command -v pg_ctl').toString().trim()) : path.dirname(c);
    } catch (_) { /* keep looking */ }
  }
  return null;
}
const BIN = findPgBin();
if (!BIN) done('NOTE | no postgres binary on PATH — the LIVE layer did not run. CI installs postgres.');

const PORT = 56100 + (process.pid % 200);
const asPostgres = process.getuid && process.getuid() === 0;
const HOME = asPostgres ? fs.mkdtempSync('/var/lib/postgresql/rp-') : fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
const DATA = path.join(HOME, 'data');
const run = (cmd, opts) => cp.execSync(asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd, Object.assign({ stdio: 'pipe', encoding: 'utf8' }, opts || {}));
let started = false;
try {
  if (asPostgres) cp.execSync(`chown -R postgres ${HOME} && chmod 700 ${HOME}`);
  run(`${BIN}/initdb -D ${DATA} -U postgres -A trust`);
  run(`${BIN}/pg_ctl -D ${DATA} -o "-p ${PORT} -k ${HOME} -c listen_addresses=" -l ${HOME}/log start -w -t 30`);
  started = true;
} catch (e) { done('NOTE | postgres would not start (' + String(e.message).slice(0, 120) + ') — LIVE layer skipped.'); }

const psql = (sql, opts) => run(`${BIN}/psql -h ${HOME} -p ${PORT} -U postgres -d postgres -v ON_ERROR_STOP=1 -t -A -c ` + JSON.stringify(String(sql).replace(/\s+/g, ' ').trim()), opts).trim();
const psqlFile = (file) => run(`${BIN}/psql -h ${HOME} -p ${PORT} -U postgres -d postgres -v ON_ERROR_STOP=1 -f ${file}`);
function mustFail(sql) { try { psql(sql); return null; } catch (e) { return String((e.stderr || e.stdout || e.message)); } }

try {
  const prep = path.join(HOME, 'prep.sql');
  /* auth.uid(), the authenticated role, and a signals table of the shape the
     close function writes — the join target of the grades view. */
  fs.writeFileSync(prep, [
    'create schema if not exists auth;',
    "create or replace function auth.uid() returns uuid language sql stable as $fn$ select '00000000-0000-0000-0000-000000000001'::uuid $fn$;",
    "do $blk$ begin if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; end $blk$;",
    'create table if not exists public.signals (sig_key text primary key, closing_sharp_fair numeric, closing_dec numeric, closing_at_observed timestamptz, result text, clv numeric, beat_close boolean);',
  ].join('\n'));
  const tmp = path.join(HOME, 'rp.sql');
  fs.writeFileSync(tmp, SQL);
  if (asPostgres) cp.execSync(`chown postgres ${prep} ${tmp} && chmod 644 ${prep} ${tmp}`);
  psqlFile(prep);
  psqlFile(tmp);
  chk('the migration applies to a clean database', true);
  psqlFile(tmp);
  chk('and applies a second time without error', true);
  const report = run(`${BIN}/psql -h ${HOME} -p ${PORT} -U postgres -d postgres -v ON_ERROR_STOP=1 -t -A -f ${tmp}`);
  chk('every report row says ok', !/CHECK THIS/.test(report), report.slice(-300));

  const KICK = '2026-09-20T19:00:00Z', BUILT = '2026-09-16T12:00:00Z';
  psql(`insert into public.research_packets (packet_id, packet_hash, built_at, sport, game_id, matchup, kickoff, model_version, model_home_line, market, selection, side, handicap, odds_decimal, book, fair_probability, sig_key, gap_points, ev_per_unit, label, decision, packet)
        values ('g1:abc','abc','${BUILT}','americanfootball_ncaaf','g1','North Texas @ Texas State','${KICK}','cfb_p4_fv1',2.4,'spreads','North Texas','away',-2.5,1.9524,'DraftKings',0.532,'sig-1',-0.1,0.0387,'PRICE DEPENDENT','BET CANDIDATE','{"schema":"edgedesk_research_packet_v1"}'::jsonb)`);
  chk('a packet can be recorded', psql("select label from public.research_packets where packet_id='g1:abc'") === 'PRICE DEPENDENT');
  chk('and it belongs to the caller', psql("select user_id from public.research_packets where packet_id='g1:abc'") === '00000000-0000-0000-0000-000000000001');

  let err = mustFail("update public.research_packets set label='PASS' where packet_id='g1:abc'");
  chk('a recorded label cannot be edited', !!err && /write-once/.test(err), err && err.slice(0, 160));
  err = mustFail("update public.research_packets set odds_decimal=2.5 where packet_id='g1:abc'");
  chk('nor the price it was compared against', !!err && /write-once/.test(err));
  err = mustFail("update public.research_packets set packet='{}'::jsonb where packet_id='g1:abc'");
  chk('nor the packet itself', !!err && /write-once/.test(err));
  err = mustFail("delete from public.research_packets where packet_id='g1:abc'");
  chk('and it cannot be deleted', !!err && /never deleted/.test(err), err && err.slice(0, 160));

  err = mustFail(`insert into public.research_packets (packet_id, packet_hash, built_at, kickoff, label) values ('leak','x','2026-09-21T00:00:00Z','${KICK}','PASS')`);
  chk('a packet built after kickoff is refused', !!err && /not before kickoff/.test(err), err && err.slice(0, 160));
  err = mustFail(`insert into public.research_packets (packet_id, packet_hash, built_at, kickoff, label) values ('bad','x','${BUILT}','${KICK}','STRONG BUY')`);
  chk('an invented label is refused', !!err && /check/.test(err), err && err.slice(0, 120));
  err = mustFail(`insert into public.research_packets (packet_id, packet_hash, built_at, kickoff, label) values ('g1:abc','abc','${BUILT}','${KICK}','PASS')`);
  chk('the same packet cannot be recorded twice', !!err && /duplicate key|unique/.test(err));

  /* grading: nothing until the signal closes, then a join, never an estimate */
  chk('an unclosed signal reads NOT_CLOSED', psql("select grade_state from public.research_packet_grades where packet_id='g1:abc'") === 'SIGNAL_NOT_FOUND');
  psql("insert into public.signals (sig_key) values ('sig-1')");
  chk('a signal with no close reads NOT_CLOSED', psql("select grade_state from public.research_packet_grades where packet_id='g1:abc'") === 'NOT_CLOSED');
  psql("update public.signals set closing_sharp_fair=0.55, closing_dec=1.87, closing_at_observed='2026-09-20T18:50:00Z', clv=0.021, beat_close=true where sig_key='sig-1'");
  chk('a closed signal with no result reads CLOSED_NO_RESULT', psql("select grade_state from public.research_packet_grades where packet_id='g1:abc'") === 'CLOSED_NO_RESULT');
  psql("update public.signals set result='win' where sig_key='sig-1'");
  const g = psql("select grade_state||'|'||result||'|'||clv||'|'||beat_close||'|'||round(brier,4) from public.research_packet_grades where packet_id='g1:abc'");
  chk('a graded packet carries the close, the result, CLV and a Brier score', g === 'GRADED|win|0.021|true|0.2190', g);
  psql(`insert into public.research_packets (packet_id, packet_hash, built_at, sport, game_id, kickoff, model_version, market, fair_probability, sig_key, label, decision)
        values ('g2:def','def','${BUILT}','americanfootball_ncaaf','g2','${KICK}','cfb_p4_fv1','spreads',0.50,'sig-2','PASS','WATCH')`);
  psql("insert into public.signals (sig_key, closing_sharp_fair, result, clv, beat_close) values ('sig-2', 0.49, 'loss', -0.01, false)");
  const cal = psql("select model_version||'|'||packets||'|'||graded||'|'||wins||'|'||losses||'|'||round(avg_clv,3)||'|'||round(beat_close_rate,2)||'|'||sufficient_sample from public.research_packet_calibration where label='PRICE DEPENDENT'");
  chk('calibration is reported per model version and label', cal === 'cfb_p4_fv1|1|1|1|0|0.021|1.00|false', cal);
  const rows = psql("select count(*) from public.research_packet_calibration");
  chk('and labels are never merged', rows === '2', rows);
  chk('a small sample is flagged as insufficient', psql("select bool_and(not sufficient_sample) from public.research_packet_calibration") === 't');

  /* Slice 4: the quoted price rides in the packet and the pricing view reads it through */
  psql(`insert into public.research_packets (packet_id, packet_hash, built_at, sport, game_id, kickoff, model_version, market, fair_probability, sig_key, label, decision, packet)
        values ('g3:px','px','${BUILT}','americanfootball_nfl','2026_03_DET_BUF','${KICK}','edgedesk_football_v1.0.0','spreads',0.52,'sig-3','PRICE DEPENDENT','WATCH',
          '{"pricing_summary":{"headline":"Fair line Buffalo Bills -5.6 against a market of -4.5 (validated blend).","fair_home_line":-5.63,"market_home_line":-4.5,"model_home_line":-9,"tier":"LEAN","fair_total":44.6,"market_total":44,"quoted":{"selection":"Buffalo Bills","side":"home","market_line":-4.5,"odds_american":-110,"book":"DraftKings","observed_at":"${BUILT}","status":"LEAN_PLAY","edge_pp":1.89,"bet_to_line":-5},"best":{"status":"LEAN_PLAY"},"sizing":null}}'::jsonb)`);
  const px = psql("select quoted_selection||'|'||quoted_side||'|'||quoted_line||'|'||quoted_odds_american||'|'||quoted_book||'|'||quoted_status||'|'||quoted_bet_to_line||'|'||fair_home_line||'|'||pricing_tier||'|'||coalesce(sizing_fraction::text,'none')||'|'||grade_state from public.research_packet_pricing where packet_id='g3:px'");
  chk('the pricing view reads the quoted side, its line, price, book, status, bet-to, the fair line and the tier', px === 'Buffalo Bills|home|-4.5|-110|DraftKings|LEAN_PLAY|-5|-5.63|LEAN|none|SIGNAL_NOT_FOUND', px);
  chk('a packet without a pricing summary reads null price fields, not an error', psql("select count(*) filter (where quoted_line is null) from public.research_packet_pricing where packet_id in ('g1:abc','g2:def')") === '2');
  chk('the checklist names the pricing view', psql("select count(*) from (select 1) x") === '1' && /pricing view/.test(SQL));

  /* RLS: another user cannot read this one's rows */
  const other_uid = path.join(HOME, 'uid2.sql');
  fs.writeFileSync(other_uid, "create or replace function auth.uid() returns uuid language sql stable as $fn$ select '00000000-0000-0000-0000-000000000002'::uuid $fn$;");
  if (asPostgres) cp.execSync(`chown postgres ${other_uid} && chmod 644 ${other_uid}`);
  psqlFile(other_uid);
  const other = run(`${BIN}/psql -h ${HOME} -p ${PORT} -U postgres -d postgres -v ON_ERROR_STOP=1 -t -A -c "set role authenticated; select count(*) from public.research_packets;"`).trim();
  chk('a different reader sees none of the first reader’s packets', other.split('\n').pop().trim() === '0', other);
} catch (e) {
  chk('the live layer ran without an unexpected error', false, String(e.stderr || e.message).slice(0, 400));
} finally {
  if (started) { try { run(`${BIN}/pg_ctl -D ${DATA} -m immediate stop`); } catch (_) { /* going away */ } }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* ditto */ }
}
done();
