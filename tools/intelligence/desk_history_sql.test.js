#!/usr/bin/env node
/* ===========================================================================
   THE DESK'S PREDICTION HISTORY, AGAINST A REAL POSTGRESQL.

   Similar Situations is only as honest as the history under it, so the
   rules live in the server and are proved by the server refusing:
     - a record cannot be edited or deleted
     - a record captured at or after kickoff is refused
     - a postgame key in the feature vector is refused
     - a final is write-once, 0-0 is never a final, and a final "settled"
       before kickoff grades nothing
   The settled view's grading is checked against tools/intelligence/
   desk_history.js outcomeOf()/clvPoints() on the same rows, and the
   matcher against the Collective's committed settlement format.

   Run: node tools/intelligence/desk_history_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'desk_prediction_history.sql'), 'utf8');
const H = require('./desk_history.js');
const D = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_desk.js'));

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
chk('idempotent', /create table if not exists/.test(SQL) && /drop trigger if exists/.test(SQL) && /create or replace view/.test(SQL));
chk('write-once, no-delete and pregame triggers', /desk_history_immutable_trg/.test(SQL) && /desk_history_no_delete_trg/.test(SQL) && /desk_history_pregame_trg/.test(SQL));
chk('the SQL postgame key list is the kernel’s', D.POSTGAME_KEYS.every((k) => SQL.indexOf("'" + k + "'") >= 0));
chk('no user id and no question text are stored', !/user_id|question/.test(SQL.split('create table if not exists public.desk_prediction_finals')[0].split('create table if not exists public.desk_prediction_history')[1]));
chk('no psql meta-commands', !/^\\/m.test(SQL));
chk('ends in a report', /CHECK THIS/.test(SQL));

/* ═══ THE MATCHER, OFFLINE ═════════════════════════════════════════════ */
{
  const settled = { season: 2026, games: {
    a: { home: 'TEN', away: 'NYJ', home_score: 10, away_score: 23, closing_spread: -1.5, closing_total: 38.5, kickoff_at: '2026-09-13T17:00:00+00:00', settled_at: '2026-09-13T21:18:32Z', score_source: 'collective' },
    b: { home: 'BOSTONCOLL', away: 'MAINE', home_score: 22, away_score: 16, closing_spread: null, closing_total: null, kickoff_at: '2026-09-19T18:00:00+00:00', settled_at: '2026-09-19T22:47:10Z' },
    c: { home: 'OHIO', away: 'JACKSONVIL', home_score: 0, away_score: 0, kickoff_at: '2026-09-12T22:00:00+00:00', settled_at: '2026-09-13T05:48:21Z' } } };
  const nfl = { sport: 'americanfootball_nfl', game_id: '2026_02_NYJ_TEN', kickoff: '2026-09-13T17:00:00Z', market: 'spread', side: 'away', line: 1.5 };
  const f = H.finalFor(nfl, settled);
  chk('an NFL record matches by the codes in its game id', f && f.home_score === 10 && f.close_home_line === -1.5, f);
  chk('NYJ +1.5 won by 13 is a WIN', H.outcomeOf(nfl, f) === 'WIN');
  chk('CLV: took +1.5, closed +1.5 -> 0', H.clvPoints(nfl, f) === 0);
  const cfb = { sport: 'americanfootball_ncaaf', game_id: '401', home_team: 'Boston College', away_team: 'Maine', kickoff: '2026-09-19T18:00:00Z', market: 'spread', side: 'home', line: -7 };
  const g = H.finalFor(cfb, settled, H.namesOf(cfb));
  chk('a CFB record matches on the ten-character keys', g && g.home_score === 22 && g.close_home_line === null, g);
  chk('Boston College -7 winning by 6 is a LOSS', H.outcomeOf(cfb, g) === 'LOSS');
  chk('a missing close gives null CLV, not zero', H.clvPoints(cfb, g) === null);
  chk('0-0 is never a final', H.finalFor({ sport: 'americanfootball_ncaaf', game_id: 'x', home_team: 'Ohio', away_team: 'Jacksonville', kickoff: '2026-09-12T22:00:00Z' }, settled, { home: 'Ohio', away: 'Jacksonville' }) === null);
  chk('a kickoff a day off does not match', H.finalFor(Object.assign({}, nfl, { kickoff: '2026-09-14T17:00:00Z' }), settled) === null);
  chk('pushes, overs and moneylines', H.outcomeOf({ market: 'spread', side: 'home', line: -6 }, { home_score: 22, away_score: 16 }) === 'PUSH'
    && H.outcomeOf({ market: 'total', side: 'over', line: 38.5 }, { home_score: 10, away_score: 23 }) === 'LOSS'
    && H.outcomeOf({ market: 'moneyline', side: 'away' }, { home_score: 10, away_score: 23 }) === 'WIN');
}

/* ═══ LIVE ═══════════════════════════════════════════════════════════════ */
function findPgBin() {
  const cands = ['pg_ctl'].concat((() => { try { return fs.readdirSync('/usr/lib/postgresql').sort().reverse().map((v) => '/usr/lib/postgresql/' + v + '/bin/pg_ctl'); } catch (_) { return []; } })());
  for (const c of cands) {
    try { cp.execSync(`${c} --version`, { stdio: 'ignore' }); return c === 'pg_ctl' ? path.dirname(cp.execSync('command -v pg_ctl').toString().trim()) : path.dirname(c); } catch (_) { /* keep looking */ }
  }
  return null;
}
const BIN = findPgBin();
if (!BIN) done('NOTE | no postgres binary on PATH — the LIVE layer did not run. CI installs postgres.');

const PORT = 56400 + (process.pid % 200);
const asPostgres = process.getuid && process.getuid() === 0;
const HOME = asPostgres ? fs.mkdtempSync('/var/lib/postgresql/dh-') : fs.mkdtempSync(path.join(os.tmpdir(), 'dh-'));
const DATA = path.join(HOME, 'data');
const run = (cmd, opts) => cp.execSync(asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd, Object.assign({ stdio: 'pipe', encoding: 'utf8' }, opts || {}));
let started = false;
try {
  if (asPostgres) cp.execSync(`chown -R postgres ${HOME} && chmod 700 ${HOME}`);
  run(`${BIN}/initdb -D ${DATA} -U postgres -A trust`);
  run(`${BIN}/pg_ctl -D ${DATA} -o "-p ${PORT} -k ${HOME} -c listen_addresses=" -l ${HOME}/log start -w -t 30`);
  started = true;
} catch (e) { done('NOTE | postgres would not start (' + String(e.message).slice(0, 120) + ') — LIVE layer skipped.'); }

const psql = (sql) => run(`${BIN}/psql -h ${HOME} -p ${PORT} -U postgres -d postgres -v ON_ERROR_STOP=1 -t -A -c ` + JSON.stringify(String(sql).replace(/\s+/g, ' ').trim())).trim();
const psqlFile = (file) => run(`${BIN}/psql -h ${HOME} -p ${PORT} -U postgres -d postgres -v ON_ERROR_STOP=1 -t -A -f ${file}`);
function mustFail(sql) { try { psql(sql); return null; } catch (e) { return String((e.stderr || e.stdout || e.message)); } }

try {
  const prep = path.join(HOME, 'prep.sql');
  fs.writeFileSync(prep, "do $blk$ begin if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; end $blk$;");
  const tmp = path.join(HOME, 'dh.sql');
  fs.writeFileSync(tmp, SQL);
  if (asPostgres) cp.execSync(`chown postgres ${prep} ${tmp} && chmod 644 ${prep} ${tmp}`);
  psqlFile(prep);
  psqlFile(tmp);
  const report = psqlFile(tmp);
  chk('applies twice, every report row ok', !/CHECK THIS/.test(report), report.slice(-300));

  const KICK = '2026-09-27T17:00:00Z', CAP = '2026-09-25T12:00:00Z';
  const ins = (id, o) => `insert into public.desk_prediction_history (record_id, captured_at, sport, game_id, home_team, away_team, kickoff, market, side, selection, line, odds, value_points, verdict, tier, confidence_grade, features)
    values ('${id}', '${o.cap || CAP}', '${o.sport || 'americanfootball_nfl'}', '${o.game || '2026_04_NYG_LA'}', 'Los Angeles Rams', 'New York Giants', '${o.kick || KICK}', '${o.market || 'spread'}', '${o.side || 'home'}', 'x', ${o.line == null ? 'null' : o.line}, -110, 2.4, 'VALUE', 'LEAN', 'MEDIUM', '${o.features || '{"sport":"americanfootball_nfl","market":"spread","value_points":2.4}'}'::jsonb)`;
  psql(ins('r1', { line: -4.5 }));
  psql(ins('r2', { side: 'away', line: 4.5 }));
  psql(ins('r3', { market: 'total', side: 'over', line: 47.5 }));
  psql(ins('r4', { market: 'moneyline', side: 'away', line: null }));
  chk('records insert', psql('select count(*) from public.desk_prediction_history') === '4');
  let err = mustFail("update public.desk_prediction_history set line=-3 where record_id='r1'");
  chk('a record cannot be edited', !!err && /write-once/.test(err), err && err.slice(0, 120));
  err = mustFail("delete from public.desk_prediction_history where record_id='r1'");
  chk('a record cannot be deleted', !!err && /never deleted/.test(err));
  err = mustFail(ins('late', { cap: '2026-09-27T17:05:00Z' }));
  chk('a record captured after kickoff is refused', !!err && /not before kickoff/.test(err), err && err.slice(0, 160));
  err = mustFail(ins('leak', { features: '{"sport":"americanfootball_nfl","outcome":"WIN","clv_points":1.5}' }));
  chk('a postgame key in the features is refused', !!err && /postgame keys/.test(err), err && err.slice(0, 160));
  err = mustFail(ins('r1', { line: -3 }));
  chk('the same record cannot be written twice', !!err && /duplicate|unique/.test(err));

  chk('unsettled before a final exists', psql("select bool_and(not settled) from public.desk_prediction_history_settled") === 't');
  err = mustFail("insert into public.desk_prediction_finals values ('americanfootball_nfl','2026_04_NYG_LA',0,0,-6.5,47.5,'2026-09-27T21:00:00Z','test')");
  chk('0-0 is refused as a final', !!err);
  /* a "final" stamped before kickoff grades nothing */
  psql("insert into public.desk_prediction_finals values ('americanfootball_nfl','2026_04_NYG_LA',27,20,-6.5,46.5,'2026-09-27T16:00:00Z','test')");
  chk('a final settled before kickoff grades nothing', psql("select bool_and(not settled) and bool_and(outcome is null) from public.desk_prediction_history_settled") === 't');
  err = mustFail("update public.desk_prediction_finals set home_score=28");
  chk('a final is write-once', !!err && /write-once/.test(err));

  /* grading parity against the JS rule, on a proper final (a second game) */
  psql(ins('p1', { game: '2026_04_DAL_PHI', line: -6.5 }));
  psql(ins('p2', { game: '2026_04_DAL_PHI', side: 'away', line: 6.5 }));
  psql(ins('p3', { game: '2026_04_DAL_PHI', market: 'total', side: 'under', line: 44 }));
  psql(ins('p4', { game: '2026_04_DAL_PHI', market: 'moneyline', side: 'home', line: null }));
  psql(ins('p5', { game: '2026_04_DAL_PHI', line: -3 }));
  psql("insert into public.desk_prediction_finals values ('americanfootball_nfl','2026_04_DAL_PHI',24,21,-4.5,45.5,'2026-09-27T21:00:00Z','test')");
  const rows = psql("select record_id||'|'||market||'|'||side||'|'||coalesce(line::text,'')||'|'||outcome||'|'||coalesce(clv_points::text,'null') from public.desk_prediction_history_settled where game_id='2026_04_DAL_PHI' order by record_id").split('\n');
  const fin = { home_score: 24, away_score: 21, close_home_line: -4.5, close_total: 45.5 };
  const parity = rows.every((r) => {
    const [id, market, side, line, outcome, clv] = r.split('|');
    const rec = { market, side, line: line === '' ? null : Number(line) };
    const jsClv = H.clvPoints(rec, fin);
    return H.outcomeOf(rec, fin) === outcome && (clv === 'null' ? jsClv === null : Math.abs(Number(clv) - jsClv) < 1e-9) && id;
  });
  chk('the view grades exactly as desk_history.js does', rows.length === 5 && parity, rows);
  chk('home -6.5 winning by 3 lost, +6.5 won, -3 pushed', rows[0].split('|')[4] === 'LOSS' && rows[1].split('|')[4] === 'WIN' && rows[4].split('|')[4] === 'PUSH', rows);

  /* the gate reads the view: five settled rows are nowhere near the floor */
  const viewRows = psql("select json_agg(json_build_object('sport',sport,'market',market,'kickoff',kickoff,'captured_at',captured_at,'settled',settled,'outcome',outcome,'clv_points',clv_points,'features',features)) from public.desk_prediction_history_settled where settled");
  const target = { features: { sport: 'americanfootball_nfl', market: 'spread', tier: 'LEAN', side_is_underdog: false, value_points: 2.4 } };
  const s = D.similarSituations(target, JSON.parse(viewRows));
  chk('Similar Situations is withheld on this history', !s.available && /building history/.test(s.text), s);
  chk('and no postgame column reaches the vector', D.leaks(D.similarityVector(JSON.parse(viewRows)[0])).length === 0);
} catch (e) {
  chk('the live layer ran without an unexpected error', false, String(e.stderr || e.message).slice(0, 400));
} finally {
  if (started) { try { run(`${BIN}/pg_ctl -D ${DATA} -m immediate stop`); } catch (_) { /* going away */ } }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* ditto */ }
}
done();
