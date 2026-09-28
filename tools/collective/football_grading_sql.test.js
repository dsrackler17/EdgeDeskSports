#!/usr/bin/env node
/* ===========================================================================
   football-v2 IN THE DATABASE, run for real, and held to the JS grader.

   supabase/migrations/20260928120000_football_grading_v2.sql is the grader
   the Collective's records are settled by; lib/football_grading.js is the one
   the page, the settle job and the offline tools run. Two implementations of
   one rule is exactly how the 2026 records came apart, so this suite does not
   trust either: it starts a throwaway PostgreSQL, builds a production-shaped
   Collective (tools/collective/sql/football_v2_fixture.sql), loads a scenario
   with every close class A-L (football_v2_scenario.sql), grades it once with
   the LEGACY grader, applies the migration twice, and then:

     - runs the shared vectors (fixtures/football_v2_vectors.js) through the
       SQL functions and through the JS functions, and fails on any difference
     - rebuilds NFL and CFB 2026 and checks every game's close and class
     - recomputes EVERY settlement row and EVERY official close in JS from the
       same inputs the database used, field by field
     - proves the dry run writes nothing and a second commit changes nothing
     - checks the audit trail, the legacy sync, the grade_game delegation,
       the privileges and the unique keys

   Without a postgres binary the LIVE layer says so and only the static layer
   runs (CI installs postgres).

   Run: node tools/collective/football_grading_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const G = require(path.join(ROOT, 'lib', 'football_grading.js'));
const V = require('./fixtures/football_v2_vectors.js');
const GEN = require('./football_identity_sql.js');
const MIG = path.join(ROOT, 'supabase', 'migrations', '20260928120000_football_grading_v2.sql');
const FIXTURE = path.join(__dirname, 'sql', 'football_v2_fixture.sql');
const SCENARIO = path.join(__dirname, 'sql', 'football_v2_scenario.sql');
const SQL = fs.readFileSync(MIG, 'utf8');

let pass = 0, fail = 0;
const fails = [];
function chk(name, cond, detail) {
  if (cond) pass++;
  else { fail++; fails.push({ name, detail }); }
}
function done(note) {
  if (note) console.log(note);
  if (fail) {
    fails.forEach(f => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 900) : '')));
    console.log(`FAILED ${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  console.log(`ALL GREEN ${pass} passed, 0 failed`);
  process.exit(0);
}
const near = (a, b) => (a === null || a === undefined) ? (b === null || b === undefined) : (b !== null && b !== undefined && Math.abs(Number(a) - Number(b)) < 1e-6);

/* ═══ STATIC ═══════════════════════════════════════════════════════════════ */
chk('static: the alias rows in the migration are exactly what lib/football_identity.js generates',
  GEN.embedded(SQL) === GEN.block());
chk('static: the migration never deletes or truncates a Collective table',
  !/\b(delete\s+from|truncate)\s+collective\.(?!fg2_)/i.test(SQL));
chk('static: the migration never writes to the odds feed or EdgeDesk capture',
  !/\b(insert\s+into|update|delete\s+from)\s+(odds|public)\.(?!fx_)/i.test(SQL));
chk('static: projections are never updated except the grade columns through the maintenance switch',
  !/update\s+collective\.projections/i.test(SQL));
chk('static: captured snapshots are insert-only (conflict do nothing), the legacy mirror aside',
  (SQL.match(/insert into collective\.fg2_market_snapshots[\s\S]*?on conflict \(source, source_snapshot_id\) do (nothing|update)/g) || [])
    .filter(x => /do update/.test(x)).length === 1);
chk('static: every settlement carries a grading version in its key',
  /primary key \(model_id, canonical_game_id, grading_version\)/.test(SQL));
chk('static: one official close per game and market', /primary key \(canonical_game_id, market_type\)/.test(SQL));
chk('static: the dry run is rolled back', /fg2_rebuild_preview[\s\S]*rolled back/.test(SQL));

/* ═══ LIVE ════════════════════════════════════════════════════════════════ */
function findPgBin() {
  const cands = ['pg_ctl'].concat((() => {
    try { return fs.readdirSync('/usr/lib/postgresql').sort().reverse().map(v => '/usr/lib/postgresql/' + v + '/bin/pg_ctl'); }
    catch (_) { return []; }
  })());
  for (const c of cands) {
    try {
      cp.execSync(`${c} --version`, { stdio: 'ignore' });
      return c === 'pg_ctl' ? path.dirname(cp.execSync('command -v pg_ctl').toString().trim()) : path.dirname(c);
    } catch (_) { /* next */ }
  }
  return null;
}
const BIN = findPgBin();
if (!BIN) done('NOTE | no postgres binary: the LIVE layer did not run; the static layer did. CI installs postgres.');

const PORT = 56100 + (process.pid % 300);
const asPostgres = process.getuid && process.getuid() === 0;
const HOME = asPostgres ? fs.mkdtempSync('/var/lib/postgresql/fg2-') : fs.mkdtempSync(path.join(os.tmpdir(), 'fg2-'));
const DATA = path.join(HOME, 'data');
const run = (cmd) => cp.execSync(asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd,
  { stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
let started = false;
try {
  if (asPostgres) cp.execSync(`chown -R postgres:postgres ${HOME}`);
  run(`${BIN}/initdb -D ${DATA} -A trust -E UTF8`);
  run(`${BIN}/pg_ctl -D ${DATA} -o '-k /tmp -p ${PORT} -c listen_addresses=' -l ${HOME}/pg.log start -w`);
  started = true;
} catch (e) {
  done('NOTE | could not start a local postgres (' + String(e.message).slice(0, 160) + '); the LIVE layer did not run.');
}
process.on('exit', () => {
  try { if (started) run(`${BIN}/pg_ctl -D ${DATA} -m immediate stop`); } catch (_) {}
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
});
function stage(src) {
  const dst = path.join(HOME, path.basename(src));
  fs.copyFileSync(src, dst);
  if (asPostgres) cp.execSync(`chmod a+r ${dst}`);
  return dst;
}
function psql(args) {
  try { return { status: 0, out: run(`${BIN}/psql -h /tmp -p ${PORT} ${args} 2>&1`) }; }
  catch (e) { return { status: 1, out: String((e.stdout || '') + (e.stderr || '') + e.message) }; }
}
/* one value back, as JSON */
function q(sql) {
  const f = path.join(HOME, 'q_' + Math.random().toString(36).slice(2) + '.sql');
  fs.writeFileSync(f, 'set client_min_messages = warning;\n' + sql + '\n');
  if (asPostgres) cp.execSync(`chmod a+r ${f}`);
  const r = psql(`-d fg2 -qAt -v ON_ERROR_STOP=1 -f ${f}`);
  if (r.status) throw new Error('SQL failed: ' + r.out.slice(-600) + '\n-- ' + sql.slice(0, 300));
  const whole = r.out.trim();
  try { return JSON.parse(whole); } catch (_) { /* several statements: the last one answers */ }
  const lines = whole.split('\n').filter(Boolean);
  const last = lines[lines.length - 1];
  try { return JSON.parse(last); } catch (_) { return last; }
}
const qj = sql => q(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`);

psql(`-d postgres -q -c "create database fg2"`);
let r = psql(`-d fg2 -q -v ON_ERROR_STOP=1 -f ${stage(FIXTURE)}`);
chk('live: the production-shaped fixture builds', r.status === 0, r.out.slice(-600));
r = psql(`-d fg2 -q -v ON_ERROR_STOP=1 -f ${stage(SCENARIO)}`);
chk('live: the scenario loads and the LEGACY grader grades it', r.status === 0, r.out.slice(-600));
const migFile = stage(MIG);
r = psql(`-d fg2 -v ON_ERROR_STOP=1 -f ${migFile}`);
chk('live: the migration applies', r.status === 0 && /13 grade_game\s+\|\s+ok\s+\|/.test(r.out), r.out.slice(-1500));
chk('live: the migration reports no FAILED step', !/FAILED|WARNING/.test(r.out), r.out.slice(-1500));
r = psql(`-d fg2 -v ON_ERROR_STOP=1 -f ${migFile}`);
chk('live: the migration applies a second time (idempotent install)', r.status === 0 && /ok \(already\)/.test(r.out), r.out.slice(-800));
if (fail) done();

/* ---- the rule, vector by vector, SQL against JS -------------------------- */
const coverRows = qj(`select * from (values ${V.COVER.map((c, i) => `(${i}, ${c[1]}, ${c[2]}, ${c[3]})`).join(',')}) v(i, hs, aws, cl)
  cross join lateral (select collective.fg2_cover(hs, aws, cl) as cover, collective.fg2_ats_margin(hs, aws, cl) as m) x order by i`);
V.COVER.forEach((c, i) => {
  const s = coverRows[i], j = G.atsCover(c[1], c[2], c[3]);
  chk('parity cover: ' + c[0], s.cover === c[4] && j.cover === c[4] && near(s.m, c[5]) && near(j.ats_margin_home, c[5]), { s, j });
});
const sideRows = qj(`select i, d.* from (values ${V.SIDE.map((c, i) => `(${i}, ${c[1] === null ? 'null' : `'${c[1]}'`}::text, ${c[2] === null ? 'null' : c[2]}::numeric, ${c[3] === null ? 'null' : c[3]}::numeric)`).join(',')}) v(i, ex, fair, cl)
  cross join lateral collective.fg2_derive_side(ex, fair, cl) d order by i`);
V.SIDE.forEach((c, i) => {
  const s = sideRows[i], j = G.deriveSide(c[1], c[2], c[3]);
  chk('parity side: ' + c[0], s.side === c[4] && j.side === c[4] && s.source === c[5] && j.source === c[5] &&
    near(s.edge_home, c[6]) && near(j.edge_home, c[6]), { s, j });
});
const resRows = qj(`select i, collective.fg2_grade_side(sd, cv) as r from (values ${V.RESULT.map((c, i) => `(${i}, ${c[1] === null ? 'null' : `'${c[1]}'`}::text, '${c[2]}')`).join(',')}) v(i, sd, cv) order by i`);
V.RESULT.forEach((c, i) => chk('parity result: ' + c[0], resRows[i].r === c[3] && G.gradeSide(c[1], c[2]) === c[3], resRows[i]));
const stateRows = qj(`select collective.fg2_game_state(st, hs, aws) as s from (values ('final',24,14),('final/OT',29,23),('final',0,0),('postponed',null,null),('canceled',null,null),('in progress',null,null)) v(st,hs,aws)`);
chk('parity game state', JSON.stringify(stateRows.map(x => x.s)) === JSON.stringify([
  G.gameState({ status: 'final', home_score: 24, away_score: 14 }), G.gameState({ status: 'final/OT', home_score: 29, away_score: 23 }),
  G.gameState({ status: 'final', home_score: 0, away_score: 0 }), G.gameState({ status: 'postponed' }),
  G.gameState({ status: 'canceled' }), G.gameState({ status: 'in progress' })]), stateRows);

/* ---- identity, SQL against JS ---------------------------------------------- */
(() => {
  const I = require(path.join(ROOT, 'lib', 'football_identity.js'));
  q(`select collective.fg2_build_registry('NFL'); select collective.fg2_build_registry('CFB');`);
  const teams = qj(`select team_id as id, code, name, sport from collective.fg2_src_teams`);
  const aliases = qj(`select team_id, alias from collective.fg2_src_team_aliases`);
  teams.forEach(t => { t.aliases = aliases.filter(x => x.team_id === t.id).map(x => x.alias); });
  const regs = { NFL: I.buildRegistry('NFL', teams.filter(t => t.sport === 'NFL')), CFB: I.buildRegistry('CFB', teams.filter(t => t.sport === 'CFB')) };
  const cases = [['NFL', 'Los Angeles Rams', null], ['NFL', 'LA', null], ['NFL', 'Kansas City Chiefs', null], ['NFL', 'Big D Cowpokes', null],
    ['NFL', 'Dallas Cowboyz', null], ['NFL', 'New York', null], ['CFB', 'West Virginia Mountaineers', null], ['CFB', 'Ohio Bobcats', null],
    ['CFB', 'Jacksonville State Gamecocks', null], ['CFB', 'Mississippi State Bulldogs', ['Ole Miss Rebels', 'Mississippi State Bulldogs', 'Mississippi Valley State Delta Devils']],
    ['CFB', 'Mississippi State Bulldogs', ['Ole Miss Rebels', 'Mississippi State Bulldogs']], ['CFB', 'Ole Miss Rebels', null],
    ['CFB', 'Alabama Crimson Tide', null], ['CFB', 'Auburn Tigers', null], ['CFB', 'WESTVIRGIN', null], ['CFB', 'Tide', null]];
  const rows = qj(cases.map((c, i) => `select ${i} as i, x.* from collective.fg2_resolve_team('${c[0]}', '${c[1].replace(/'/g, "''")}', ${c[2] ? `array[${c[2].map(u => `'${u.replace(/'/g, "''")}'`).join(',')}]` : 'null'}) x`).join(' union all ') + ' order by i');
  cases.forEach((c, i) => {
    const j = I.resolveTeam(regs[c[0]], c[1], c[2] || undefined);
    const s = rows[i];
    chk(`parity identity: ${c[0]} "${c[1]}"${c[2] ? ' (slate)' : ''}`, (s.team_id || null) === (j.team_id || null) &&
      (s.method || null) === (j.method || null) && (s.reason || null) === (j.reason || null), { sql: s, js: j });
  });
})();

/* ---- the scenario: dry run first ------------------------------------------ */
const counts = () => q(`select json_build_object('s', (select count(*) from collective.fg2_settlements), 'c', (select count(*) from collective.fg2_official_closes),
  'm', (select count(*) from collective.fg2_market_snapshots), 'a', (select count(*) from collective.fg2_grade_audit),
  'r', (select count(*) from collective.results where closing_spread is not null), 'g', (select count(*) from collective.grades where pick_result is not null));`);
const before = counts();
const preview = q(`select collective.fg2_rebuild_preview('NFL', 2026);`);
chk('dry run: returns the report it would have committed', preview && preview.dry_run === true && preview.close_classes && preview.close_classes.B === 1, preview && preview.close_classes);
chk('dry run: writes nothing at all', JSON.stringify(counts()) === JSON.stringify(before), { before, after: counts() });

/* ---- commit ------------------------------------------------------------------ */
const nfl = q(`select collective.fg2_rebuild('NFL', 2026, true);`);
const cfb = q(`select collective.fg2_rebuild('CFB', 2026, true);`);
chk('commit: NFL rebuild reports its legacy sync', nfl.committed === true && nfl.legacy_sync && nfl.legacy_sync.results_closes_filled >= 5, nfl.legacy_sync);
chk('commit: CFB rebuild links the truncated-name events', cfb['3_links'] && cfb['3_links'].linked === 4 && cfb['3_links'].unresolved === 1, cfb['3_links']);

const cls = qj(`select f.tag, c.close_class, c.close_status, c.home_spread::float as home_spread, c.source, c.rejected
  from collective.fg2_close_classification c join public.fx_games f on f.game_id::text = c.canonical_game_id order by f.tag`);
const byTag = {}; cls.forEach(x => { byTag[x.tag] = x; });
const EXPECT = { N1: ['A', -3, 'legacy_results_close'], N2: ['B', -5.5, 'collective_odds'], N3: ['C', -2.5, 'collective_odds'],
  N4: ['C', -6.5, 'edgedesk_capture'], N5: ['I', null, null], N6: ['J', null, null], N7: ['K', null, null], N8: ['D', -3.5, 'collective_odds'],
  N9: ['L', null, null], N10: ['C', -3, 'collective_odds'], N11: ['F', null, null], N12: ['E', null, null], N13: ['G', null, null],
  N14: ['A', -2.5, 'legacy_results_close'], N15: ['H', null, null], C1: ['C', -13.5, 'collective_odds'], C2: ['C', -4, 'collective_odds'],
  C3: ['C', -7, 'collective_odds'], C4: ['C', -6.5, 'collective_odds'] };
Object.keys(EXPECT).forEach(t => {
  const x = byTag[t] || {}, e = EXPECT[t];
  chk(`close ${t}: class ${e[0]}, close ${e[1]} from ${e[2]}`, x.close_class === e[0] && near(x.home_spread, e[1]) && (x.source || null) === e[2], x);
});
chk('close N2: the in-game 00:30 price is rejected, the 23:55 DraftKings line is the close (not FanDuel -6)',
  byTag.N2 && byTag.N2.rejected.AFTER_KICKOFF === 1 && byTag.N2.home_spread === -5.5);
chk('close N10: an away-listed event is re-oriented (provider home MIN +3 -> canonical home TB -3)', byTag.N10 && byTag.N10.home_spread === -3);
chk('close N14: a feed row that is the negative of the published close is refused as an orientation conflict',
  byTag.N14 && byTag.N14.rejected.ORIENTATION_CONFLICT === 1 && byTag.N14.home_spread === -2.5);
chk('close N8b: the duplicate fixture is aliased to its canonical game, not graded separately',
  q(`select count(*) from collective.fg2_game_alias a join public.fx_games f on f.game_id::text = a.game_id where f.tag = 'N8b';`) === 1 &&
  q(`select count(*) from collective.fg2_settlements s join public.fx_games f on f.game_id::text = s.canonical_game_id where f.tag = 'N8b';`) === 0);
chk('links: every unresolved event is logged with its reason, none dropped',
  q(`select count(*) from collective.fg2_market_events e left join collective.fg2_event_links l using (source, source_event_id) where l.status is null;`) === 0 &&
  q(`select count(*) from collective.fg2_event_links where status = 'unresolved' and reason is null;`) === 0);

/* ---- EVERY close, recomputed in JS from the same snapshots --------------------- */
(() => {
  const srcs = q(`select value from collective.fg2_config where key = 'sources';`);
  const books = q(`select value from collective.fg2_config where key = 'book_priority';`);
  const games = qj(`select c.canonical_game_id as gid, g.kickoff_at, g.sport, c.source_snapshot_id, c.close_status, c.legacy_close::float as legacy
    from collective.fg2_official_closes c join collective.fg2_src_games g on g.game_id = c.canonical_game_id`);
  let n = 0;
  games.forEach(gm => {
    const snaps = qj(`select s2.source, s2.source_snapshot_id as snapshot_id, s2.source_event_id, s2.book, s2.market_type, s2.observed_at,
        (case when l.orientation = 'swapped' then -coalesce(s2.home_line, -s2.away_line) else coalesce(s2.home_line, -s2.away_line) end)::float as home_line
      from collective.fg2_market_snapshots s2
      left join collective.fg2_event_links l on l.source = s2.source and l.source_event_id = s2.source_event_id and l.status = 'linked'
     where s2.canonical_game_id in (select '${gm.gid}' union select game_id from collective.fg2_game_alias where canonical_game_id = '${gm.gid}')
        or l.canonical_game_id = '${gm.gid}'`);
    const j = G.selectClose(snaps, { kickoffAt: gm.kickoff_at, windowMinutes: 360, sources: srcs, bookPriority: books, legacyClose: gm.legacy });
    const ok = (j.close ? j.close.snapshot_id : null) === gm.source_snapshot_id && j.status === gm.close_status;
    if (!ok) chk('parity close for ' + gm.gid, false, { sql: gm, js: { status: j.status, snap: j.close && j.close.snapshot_id } });
    else n++;
  });
  chk(`parity: all ${games.length} official closes are exactly what lib/football_grading.js selects (${n} agree)`, n === games.length && n >= 19);
})();

/* ---- EVERY settlement, recomputed in JS from the same inputs ----------------------- */
function jsTraceFor(s) {
  const members = qj(`select '${s.canonical_game_id}' as id union select game_id from collective.fg2_game_alias where canonical_game_id = '${s.canonical_game_id}'`).map(x => x.id);
  const game = qj(`select game_id, sport, season, week, kickoff_at, status, home_score::float as home_score, away_score::float as away_score from collective.fg2_src_games where game_id = '${s.canonical_game_id}'`)[0];
  const versions = qj(`select prediction_id, received_at, data_origin, resolution_status, pick_side, projected_spread::float as projected_spread,
      proj_home_score::float as proj_home_score, proj_away_score::float as proj_away_score, home_win_prob::float as home_win_prob
    from collective.fg2_src_predictions where model_id = '${s.model_id}' and game_id in (${members.map(m => `'${m}'`).join(',')})`);
  const close = s.close_home_spread === null ? null : { home_spread: s.close_home_spread };
  return G.gradeModelGame({ game, close, versions, model_id: s.model_id });
}
const FIELDS = ['prediction_id', 'prediction_version', 'post_lock_versions', 'prediction_status', 'fair_home_spread', 'predicted_home_margin',
  'explicit_side', 'ats_side', 'ats_side_source', 'model_edge_home', 'ats_margin_home', 'cover', 'ats_result', 'ats_exclusion',
  'margin_error', 'mae_exclusion', 'home_win_prob', 'outcome', 'brier', 'brier_exclusion', 'game_state', 'actual_margin'];
const NUMERIC = ['fair_home_spread', 'predicted_home_margin', 'model_edge_home', 'ats_margin_home', 'margin_error', 'home_win_prob', 'brier', 'actual_margin'];
function compare(sqlRow, js) {
  return FIELDS.filter(f => {
    const a = sqlRow[f], b = js[f];
    if (NUMERIC.indexOf(f) >= 0) return !near(a, b);
    return String(a === undefined ? null : a) !== String(b === undefined ? null : b);
  }).map(f => `${f}: sql ${JSON.stringify(sqlRow[f])} js ${JSON.stringify(js[f])}`);
}
(() => {
  const rows = qj(`select * from collective.fg2_settlements where season = 2026`);
  let n = 0;
  rows.forEach(s => {
    const bad = compare(s, jsTraceFor(s));
    if (bad.length) chk(`parity settlement ${s.model_id.slice(-2)}/${s.canonical_game_id.slice(0, 8)}`, false, bad);
    else n++;
  });
  chk(`parity: all ${rows.length} settlement rows agree with lib/football_grading.js field by field (${n})`, n === rows.length && n >= 40);
})();

/* ---- specific settlements ------------------------------------------------------------ */
const trace = (tag, model) => qj(`select t.* from collective.fg2_grading_trace t join public.fx_games f on f.game_id::text = t.canonical_game_id
  where f.tag = '${tag}' and t.creator_slug = '${model}'`)[0] || {};
let t = trace('N2', 'moose');
chk('N2 moose: the post-lock edit (-12) is ignored; the pre-lock -3 against the -5.5 close derives AWAY; home covered -> loss',
  t.prediction_version === 1 && t.post_lock_versions === 1 && t.ats_side === 'away' && t.ats_side_source === 'derived' &&
  t.ats_result === 'loss' && t.ats_calculation === '10 + (-5.5) = 4.5 -> home', t);
t = trace('N2', 'blizzard');
chk('N2 blizzard: inside the lock -> LATE_SUBMISSION on every metric',
  t.prediction_status === 'LATE_SUBMISSION' && t.ats_exclusion === 'LATE_SUBMISSION' && t.mae_exclusion === 'LATE_SUBMISSION' && t.brier === null, t);
t = trace('N6', 'plusev');
chk('N6 +EV: backfill beside a live row -> the live row is graded; no close -> MISSING_CLOSE while MAE and Brier stand',
  t.prediction_status === 'OK' && t.ats_exclusion === 'MISSING_CLOSE' && t.margin_error === 8 && Number(t.brier) === 0.25, t);
t = trace('N1', 'moose');
chk('N1 moose: the LATEST pre-lock version (-5) is graded, not the first (-1)', t.prediction_version === 2 && Number(t.fair_home_spread) === -5 && t.ats_side === 'home', t);
t = trace('N7', 'edgedesk');
chk('N7: every submission late -> K game, LATE_SUBMISSION row', t.ats_exclusion === 'LATE_SUBMISSION' && t.close_class === 'K', t);
t = trace('C4', 'blerm');
chk('C4 blerm: fair -4 into -6.5 derives AWAY; home by 3 -> away covered -> win', t.ats_side === 'away' && t.ats_result === 'win', t);

/* ---- the record, the consensus, the diagnostics -------------------------------------- */
(() => {
  const st = qj(`select * from collective.fg2_model_standings where season = 2026`);
  let ok = 0;
  st.forEach(row => {
    const traces = qj(`select * from collective.fg2_settlements where model_id = '${row.model_id}' and season = 2026`).map(x => {
      NUMERIC.forEach(f => { if (x[f] !== null) x[f] = Number(x[f]); });
      return x;
    });
    const a = G.aggregateModel(traces);
    const same = a.wins === row.wins && a.losses === row.losses && a.pushes === row.pushes && a.ats_n === row.ats_n &&
      near(a.ats_pct, row.ats_pct) && near(a.mae, row.mae) && a.mae_n === row.mae_n && near(a.brier, row.brier) && a.brier_n === row.brier_n &&
      (a.ats_excluded.MISSING_CLOSE || 0) === row.ats_missing_close && (a.ats_excluded.NO_ATS_SIDE || 0) === row.ats_no_side &&
      (a.ats_excluded.LATE_SUBMISSION || 0) === row.ats_late;
    if (same) ok++; else chk('standings parity ' + row.model_slug, false, { sql: row, js: a });
  });
  chk(`standings: every model's W-L-P, ATS%, MAE, Brier and exclusion counts equal the JS aggregate (${ok}/${st.length})`, ok === st.length && ok >= 6);
  const cg = qj(`select * from collective.fg2_consensus_games`);
  let cok = 0;
  cg.forEach(c => {
    const traces = qj(`select * from collective.fg2_settlements where canonical_game_id = '${c.canonical_game_id}'`).map(x => {
      NUMERIC.forEach(f => { if (x[f] !== null) x[f] = Number(x[f]); }); return x; });
    const j = G.consensusGame(traces);
    if ((j.ats_result || null) === (c.ats_result || null) && (j.ats_exclusion || null) === (c.ats_exclusion || null) &&
        (j.ml_result || null) === (c.ml_result || null)) cok++;
    else chk('consensus parity ' + c.canonical_game_id, false, { sql: c, js: j });
  });
  chk(`consensus: every game's consensus ATS and outright call equals the JS consensus (${cok}/${cg.length})`, cok === cg.length);
  const d = qj(`select * from collective.fg2_slate_diagnostics where league = 'NFL' and week = 3`)[0] || {};
  chk('diagnostics: NFL week 3 market capture below 95% is a HIGH warning', (d.warnings || []).indexOf('HIGH:MARKET_CAPTURE_LOW') >= 0, d);
  chk('diagnostics: no gradable model-game is left ungraded (no ERROR)', !(d.warnings || []).some(w => /^ERROR/.test(w)) && d.gradable_but_ungraded === 0, d);
  chk('diagnostics: the duplicate fixture and the orphan events are counted', d.duplicate_event_count_season === 1 && d.orphan_event_count_season >= 1, d);
  chk('links: an event four days from the game is refused as kickoff_out_of_tolerance, not linked',
    q(`select reason from collective.fg2_event_links where source_event_id = 'E11';`) === 'kickoff_out_of_tolerance');
})();

/* ---- the reconciliation report ---------------------------------------------------------- */
(() => {
  const rep = q(`select collective.fg2_report('NFL', 2026, 20);`);
  const nflTags = Object.keys(EXPECT).filter(t => /^N/.test(t));
  const want = {};
  nflTags.forEach(t => { want[EXPECT[t][0]] = (want[EXPECT[t][0]] || 0) + 1; });
  chk('report: every NFL game with a submission is counted once (15, the duplicate folded in)',
    rep.completed_events_with_submissions === 15, rep.completed_events_with_submissions);
  chk('report: close classes equal the scenario, class by class', JSON.stringify(rep.close_classes) === JSON.stringify(
    Object.keys(want).sort().reduce((o, k) => { o[k] = want[k]; return o; }, {})), { got: rep.close_classes, want });
  chk('report: recovered closes are the B, C and D games (N2, N3, N4, N8, N10)', rep.recovered_closes === 5, rep.recovered_closes);
  chk('report: games with no market capture anywhere are the J games', rep.no_market_capture === want.J);
  chk('report: no published close was superseded in this scenario (N14’s flipped feed row was refused)',
    rep.legacy_closes_superseded === 0 && Array.isArray(rep.legacy_closes_superseded_list));
  chk('report: every ungraded ATS row carries a named reason',
    Object.keys(rep.ats_ungraded_reasons).every(k => k !== 'null') &&
    Object.values(rep.ats_ungraded_reasons).reduce((a, b) => a + b, 0) === rep.ats_ungraded, rep.ats_ungraded_reasons);
  chk('report: graded + pushes + ungraded = every model-game', rep.ats_graded + rep.ats_pushes + rep.ats_ungraded === rep.model_game_predictions);
  const moose = (rep.models || []).find(m => m.creator_slug === 'moose') || {};
  chk('report: each model carries its corrected record and the LEGACY record it replaces',
    moose.legacy && moose.legacy.wins === 0 && moose.legacy.losses === 0 && moose.ats_n >= 4 && moose.mae_n >= 4, moose);
  chk('report: the sample is graded rows with the arithmetic spelled out',
    rep.sample.length >= 10 && rep.sample.every(t => /-> (home|away|push)$/.test(t.ats_calculation) && t.ats_result), rep.sample[0]);
  chk('report: every sampled row re-derives in JS from its own printed numbers',
    rep.sample.every(t => {
      const cv = G.atsCover(t.home_score, t.away_score, t.close_home_spread);
      return cv.cover === t.ats_calculation.split('-> ')[1] && G.gradeSide(t.ats_side, cv.cover) === t.ats_result;
    }));
})();

/* ---- the audit trail ------------------------------------------------------------------- */
(() => {
  const a = qj(`select a.reason, a.old_state, a.new_state, a.source_snapshot_id, a.grading_version from collective.fg2_grade_audit a
    join public.fx_games f on f.game_id::text = a.canonical_game_id join collective.models m on m.id::text = a.model_id
    where f.tag = 'N2' and m.slug = 'nfl' and m.creator_id = 'cccccccc-0000-0000-0000-000000000002'`);
  chk('audit: N2 moose records the repair: legacy old state (no ATS), new state (loss), reason, snapshot, version',
    a.length === 1 && /^ats_recovered:B:derived$/.test(a[0].reason) && a[0].old_state.legacy === true && a[0].old_state.ats_result === null &&
    a[0].new_state.ats_result === 'loss' && /^odds\.lines:/.test(a[0].source_snapshot_id) && a[0].grading_version === 'football-v2', a);
  chk('audit: every settlement has exactly one initial audit row',
    q(`select count(*) from collective.fg2_settlements s where not exists (select 1 from collective.fg2_grade_audit a where a.model_id = s.model_id and a.canonical_game_id = s.canonical_game_id);`) === 0);
})();

/* ---- the legacy tables now say the same thing --------------------------------------------- */
chk('legacy sync: N2 results.closing_spread was empty and now holds the official close; N1 keeps its own',
  Number(q(`select r.closing_spread from collective.results r join public.fx_games f on f.game_id = r.game_id where f.tag = 'N2';`)) === -5.5 &&
  Number(q(`select r.closing_spread from collective.results r join public.fx_games f on f.game_id = r.game_id where f.tag = 'N1';`)) === -3);
chk('legacy sync: a close the repair wrote is recorded, so the next run never mistakes it for a legacy close',
  q(`select count(*) from collective.fg2_results_writes w join public.fx_games f on f.game_id::text = w.game_id where f.tag in ('N2','N3','N4','N8','N10');`) === 5);
chk('legacy sync: the grade row of every graded version equals its settlement',
  q(`select count(*) from collective.fg2_settlements s join collective.grades g on g.projection_id::text = s.prediction_id
      where g.pick_result is distinct from s.ats_result or g.margin_error is distinct from s.margin_error or g.brier is distinct from s.brier;`) === 0);
chk('legacy sync: the version the legacy grader graded (moose N1, first upload) no longer carries a grade',
  q(`select count(*) from collective.grades g join collective.projections p on p.id = g.projection_id join public.fx_games f on f.game_id = p.game_id
      where f.tag = 'N1' and p.projected_spread = -1 and (g.pick_result is not null or g.margin_error is not null);`) === 0);
chk('legacy sync: game_detail now serves the recovered close', Number(q(`select d.closing_spread from collective.game_detail d join public.fx_games f on f.game_id = d.game_id where f.tag = 'N3';`)) === -2.5);

/* ---- rerun: nothing moves -------------------------------------------------------------------- */
(() => {
  const snap = () => q(`select json_build_object(
    's', (select md5(string_agg(row(model_id, canonical_game_id, prediction_id, ats_result, ats_exclusion, margin_error, brier, close_home_spread, close_snapshot_id)::text, '|' order by model_id, canonical_game_id)) from collective.fg2_settlements),
    'c', (select md5(string_agg(row(canonical_game_id, home_spread, source_snapshot_id, close_class, close_status)::text, '|' order by canonical_game_id)) from collective.fg2_official_closes),
    'a', (select count(*) from collective.fg2_grade_audit), 'm', (select count(*) from collective.fg2_market_snapshots),
    'w', (select md5(string_agg(row(game_id, closing_spread)::text, '|' order by game_id)) from collective.fg2_results_writes),
    'r', (select md5(string_agg(row(game_id, closing_spread)::text, '|' order by game_id)) from collective.results),
    'g', (select md5(string_agg(row(projection_id, pick_result, margin_error, brier)::text, '|' order by projection_id)) from collective.grades));`);
  const s1 = snap();
  q(`select collective.fg2_rebuild('NFL', 2026, true); select collective.fg2_rebuild('CFB', 2026, true);`);
  const s2 = snap();
  chk('idempotent: a second commit rebuild changes no settlement, close, audit row, snapshot, results row or grade',
    JSON.stringify(s1) === JSON.stringify(s2), { s1, s2 });
  chk('idempotent: the second run audited nothing', q(`select count(*) from collective.fg2_grade_audit a where a.run_id = (select run_id from collective.fg2_rebuild_runs where sport = 'CFB' order by started_at desc, run_id limit 1);`) === 0);
})();

/* ---- the vectors, end to end in the database ------------------------------------------------ */
(() => {
  const pairs = qj(`select h.id::text as h, a.id::text as a from collective.teams h join collective.teams a on a.sport_code = h.sport_code and a.code > h.code
     where h.sport_code = 'NFL' order by h.code, a.code limit ${V.MODEL_GAME.length}`);
  const shift = i => 3 * 24 * 3600000 * (i + 1);
  const at = (iso, i) => new Date(Date.parse(iso) - shift(i)).toISOString();
  const sql = ['set local collective.maintenance = on;'];
  V.MODEL_GAME.forEach((c, i) => {
    const gid = `eeeeeeee-0000-0000-0000-${String(i + 1).padStart(12, '0')}`;
    const g = c.game;
    sql.push(`insert into collective.games (id, sport_code, season, week, kickoff_at, home_team_id, away_team_id, status) values ('${gid}', 'NFL', 2030, 1, '${at(V.KICK, i)}', '${pairs[i].h}', '${pairs[i].a}', '${g.status}');`);
    sql.push(`insert into collective.results (game_id, home_score, away_score, closing_spread) values ('${gid}', ${g.home_score === null ? 'null' : g.home_score}, ${g.away_score === null ? 'null' : g.away_score}, ${c.close === null ? 'null' : c.close});`);
    c.versions.forEach(vv => {
      const val = x => (x === undefined || x === null) ? 'null' : (typeof x === 'string' ? `'${x}'` : x);
      sql.push(`insert into collective.projections (model_id, game_id, received_at, data_origin, resolution_status, pick_side, projected_spread, proj_home_score, proj_away_score, home_win_prob)
        values ('dddddddd-0000-0000-0000-000000000001', '${gid}', '${at(vv.received_at, i)}', ${val(vv.data_origin)}, ${val(vv.resolution_status)}, ${val(vv.pick_side)}, ${val(vv.projected_spread)}, ${val(vv.proj_home_score)}, ${val(vv.proj_away_score)}, ${val(vv.home_win_prob)});`);
    });
  });
  q('begin;\n' + sql.join('\n') + '\ncommit;');
  q(`select collective.fg2_rebuild('NFL', 2030, true);`);
  V.MODEL_GAME.forEach((c, i) => {
    const gid = `eeeeeeee-0000-0000-0000-${String(i + 1).padStart(12, '0')}`;
    const s = qj(`select * from collective.fg2_settlements where canonical_game_id = '${gid}'`)[0] || {};
    const want = Object.assign({}, c.expect);
    delete want.prediction_id;
    const bad = Object.keys(want).filter(k => NUMERIC.indexOf(k) >= 0 ? !near(s[k], want[k]) : String(s[k] === undefined ? null : s[k]) !== String(want[k]));
    chk('SQL vector: ' + c.label, !bad.length, bad.map(k => `${k}: sql ${JSON.stringify(s[k])} want ${JSON.stringify(want[k])}`));
  });
})();

/* ---- grade_game now delegates, privileges, keys ------------------------------------------------ */
(() => {
  const gg = q(`select collective.grade_game(game_id) from public.fx_games where tag = 'N3';`);
  chk('grade_game: a football game is settled by football-v2', gg && gg.grading_version === 'football-v2' && gg.graded >= 1, gg);
  const mlb = q(`select collective.grade_game(game_id) from public.fx_games where tag = 'M1';`);
  chk('grade_game: any other sport still reaches the legacy grader', mlb && mlb.grader === 'legacy', mlb);
  chk('privileges: anon and authenticated cannot run the rebuild or read the settlement',
    q(`select not has_function_privilege('anon', 'collective.fg2_rebuild(text,integer,boolean)', 'execute')
         and not has_function_privilege('authenticated', 'collective.fg2_rebuild(text,integer,boolean)', 'execute')
         and not has_table_privilege('anon', 'collective.fg2_settlements', 'select')
         and not has_function_privilege('anon', 'collective.grade_game(uuid)', 'execute');`) === 't');
  chk('privileges: the service role can', q(`select has_function_privilege('service_role', 'collective.fg2_rebuild(text,integer,boolean)', 'execute')
         and has_table_privilege('service_role', 'collective.fg2_settlements', 'select');`) === 't');
  let dupRefused = false;
  try { q(`insert into collective.fg2_settlements (model_id, canonical_game_id, grading_version) select model_id, canonical_game_id, grading_version from collective.fg2_settlements limit 1;`); }
  catch (e) { dupRefused = /duplicate key/.test(e.message); }
  chk('keys: a second settlement for one model, game and grading version is refused', dupRefused);
  let closeDup = false;
  try { q(`insert into collective.fg2_official_closes (canonical_game_id, market_type, close_status, grading_version) select canonical_game_id, market_type, 'X', 'x' from collective.fg2_official_closes limit 1;`); }
  catch (e) { closeDup = /duplicate key/.test(e.message); }
  chk('keys: a second official close for one game and market is refused', closeDup);
})();

done();
