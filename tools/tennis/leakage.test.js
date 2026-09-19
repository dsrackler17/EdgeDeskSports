#!/usr/bin/env node
/* ===========================================================================
   FEATURE LEAKAGE — the suite that decides whether any of the modelling is
   worth anything.

   A leak in a sports model is invisible: the metrics get BETTER, the model
   looks brilliant, and it is worthless the first time it sees a match nobody
   has played. So this does not inspect the code. It rebuilds the rolling
   aggregates BY HAND, in JavaScript, from matches strictly earlier than the one
   being checked, and fails on any disagreement with what the database computed.

   It also asks the structural questions:

     does a feature row contain ONLY information available before its match?
     does the rolling window exclude the current row, provably?
     is a player's FIRST match given no history rather than zero history?
     does a corrected result propagate to every LATER match those players
       played, and to none earlier?
     is the training set free of post-match columns by construction?
     does a walkover stay out of the training set?

   Run: node tools/tennis/leakage.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const M = require('../../lib/tennis_model.js');

/* MATCH IDS ARE DERIVED, NOT SPELLED OUT. A match's identity is its draw slot
   AND the unordered player pair — the pair is in the key because the real
   archive has 16 slots holding two different matches each, and without it the
   second silently overwrote the first. Hard-coding the old slot-only string
   made this suite fail on that fix even though nothing it tests was broken.
   Every fixture here is player 1 against player `l` in tournament `t`. */
const mid = (t, l) => M.matchKey('ATP', t, 1, 'archive', '1', String(l));

const ROOT = path.join(__dirname, '..', '..');
const DB = 'edgedesk_tennis_leakage_test';
const FEATURES = require('./build_features.js');

let pass = 0, fail = 0; const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  chk(name, a === b, 'got ' + a + ', want ' + b);
}

const have = (b) => cp.spawnSync('sh', ['-c', 'command -v ' + b], { encoding: 'utf8' }).status === 0;
const psql = (conn, args) => cp.spawnSync('psql', conn.concat(args), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
function candidates() {
  const out = [];
  if (process.env.EDGD_PG) out.push(process.env.EDGD_PG.split(' '));
  if (process.env.PGHOST) out.push([]);
  out.push(['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres']);
  out.push([]);
  return out;
}
function skip(why) {
  console.log('SKIP | tennis feature leakage | ' + why);
  console.log('       (this suite needs PostgreSQL; CI runs it in games-sql.yml)');
  process.exit(0);
}
if (!have('psql')) skip('psql is not installed');
let conn = null;
for (const c of candidates()) { if (psql(c, ['-d', 'postgres', '-tAc', 'select 1']).status === 0) { conn = c; break; } }
if (!conn) skip('no reachable PostgreSQL server');
const PGARG = conn.join(' ');
function drop() { psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']); }
function rows(sql) {
  const out = psql(conn, ['-d', DB, '-tA', '-c',
    "select coalesce(json_agg(t),'[]'::json)::text from (" + sql.replace(/;\s*$/, '') + ') t']).stdout.trim();
  try { return JSON.parse(out || '[]'); } catch (e) { throw new Error('bad result: ' + out.slice(0, 300)); }
}
function run(script, args) {
  return cp.spawnSync('node', [path.join(ROOT, 'tools', 'tennis', script), '--database', DB].concat(args || []), {
    encoding: 'utf8', cwd: ROOT, maxBuffer: 32 * 1024 * 1024,
    env: Object.assign({}, process.env, { EDGD_PG: PGARG }) });
}

/* ── a small synthetic history with KNOWN serve numbers ───────────────── */
const HEADER = require('./import_archive.js').STG_COLUMNS;
function csvRow(o) { return HEADER.map((h) => (o[h] == null ? '' : String(o[h]))).join(','); }

drop();
if (psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]).status !== 0) skip('could not create the test database');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edgd-leak-'));
let code = 0;
try {
  psql(conn, ['-d', DB, '-q', '-c', 'create extension if not exists pgcrypto']);
  for (const f of ['tools/games/sql/supabase_shim.sql', 'supabase/tennis_live_center.sql', 'supabase/tennis_record.sql']) {
    const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', path.join(ROOT, f)]);
    if (r.status !== 0) { console.error((r.stderr || '').split('\n').slice(0, 8).join('\n')); throw new Error('setup'); }
  }

  /* Player 1 plays six matches on six distinct dates, with deliberately
     distinctive serve numbers so a leak would be arithmetically obvious. */
  const src = [];
  const SERVE = [
    { svpt: 100, first_won: 40, second_won: 20 },   // 60/100
    { svpt: 100, first_won: 50, second_won: 20 },   // 70/100
    { svpt: 100, first_won: 30, second_won: 20 },   // 50/100
    { svpt: 100, first_won: 60, second_won: 20 },   // 80/100
    { svpt: 100, first_won: 45, second_won: 20 },   // 65/100
    { svpt: 100, first_won: 55, second_won: 20 }    // 75/100
  ];
  SERVE.forEach((s, i) => {
    const day = String(i + 1).padStart(2, '0');
    src.push(csvRow({
      tourney_id: 'T' + i, tourney_name: 'Event ' + i, surface: 'Hard', tourney_date: '2024-01-' + day,
      match_num: '1', tourney_level: 'A', best_of: '3', round: 'R32', tour: 'ATP', source_year: '2024',
      winner_id: '1', winner_name: 'One Player', loser_id: String(10 + i), loser_name: 'Opp ' + i,
      score: '6-4 6-4', minutes: '90',
      w_svpt: String(s.svpt), w_1stIn: '60', w_1stWon: String(s.first_won), w_2ndWon: String(s.second_won),
      w_SvGms: '12', w_ace: '5', w_df: '2', w_bpSaved: '1', w_bpFaced: '2',
      l_svpt: '100', l_1stIn: '55', l_1stWon: '35', l_2ndWon: '15', l_SvGms: '12',
      l_ace: '3', l_df: '3', l_bpSaved: '1', l_bpFaced: '4',
      winner_elo_pre: String(1800 + i * 10), winner_surface_elo_pre: String(1810 + i * 10),
      loser_elo_pre: String(1700 + i * 5), loser_surface_elo_pre: String(1705 + i * 5),
      winner_rank: '10', loser_rank: '50', winner_age: '25', loser_age: '26',
      match_uid: 'ATP_T' + i + '_1_1_' + (10 + i), environment: 'Outdoor'
    }));
  });
  /* one WALKOVER, which must never enter training */
  src.push(csvRow({
    tourney_id: 'TW', tourney_name: 'Walkover Event', surface: 'Hard', tourney_date: '2024-02-01',
    match_num: '1', tourney_level: 'A', best_of: '3', round: 'R32', tour: 'ATP', source_year: '2024',
    winner_id: '1', winner_name: 'One Player', loser_id: '99', loser_name: 'Absent Player',
    score: 'W/O', winner_elo_pre: '1900', loser_elo_pre: '1700', match_uid: 'ATP_TW_1_1_99'
  }));
  const file = path.join(tmp, 'leak.csv');
  fs.writeFileSync(file, HEADER.join(',') + '\n' + src.join('\n') + '\n');

  let r = run('import_archive.js', ['--file', file, '--chunk', '100']);
  chk('the synthetic history imports', r.status === 0, (r.stderr || '').slice(0, 300));
  r = run('build_features.js', ['--commit']);
  chk('the feature builder runs', r.status === 0, (r.stderr || '').slice(0, 300));

  /* ── 1. THE ROLLING WINDOW EXCLUDES THE CURRENT MATCH ──────────────── */
  const feats = rows(`
    select f.match_id, f.match_date, f.serve_strength_pre, f.serve_sample_pre, f.sos_elo_pre, f.sos_sample_pre
      from tennis.player_match_features f
      join tennis.matches m on m.match_id = f.match_id
     where f.player_id = 'archive:ATP:1' and m.walkover = false
     order by m.match_date`);
  eq('one feature row per played match for this player', feats.length, 6);

  /* recomputed BY HAND from matches strictly earlier */
  let wonSoFar = 0, ptsSoFar = 0;
  feats.forEach((f, i) => {
    const expected = ptsSoFar >= FEATURES.MIN_SERVE_POINTS ? Math.round((wonSoFar / ptsSoFar) * 1e4) / 1e4 : null;
    const got = f.serve_strength_pre == null ? null : Math.round(Number(f.serve_strength_pre) * 1e4) / 1e4;
    eq('match ' + (i + 1) + ': serve strength is computed from EARLIER matches only', got, expected);
    eq('match ' + (i + 1) + ': the sample counts only earlier matches', Number(f.serve_sample_pre || 0), i);
    /* now fold THIS match in, for the next iteration */
    wonSoFar += SERVE[i].first_won + SERVE[i].second_won;
    ptsSoFar += SERVE[i].svpt;
  });

  eq('a player\'s FIRST match has no serve history at all', feats[0].serve_strength_pre, null);
  eq('and no sample, rather than a sample of zero', Number(feats[0].serve_sample_pre || 0), 0);
  chk('a null here is a gap, never a zero rate',
      feats[0].serve_strength_pre !== 0 && feats[0].serve_strength_pre !== '0');

  /* strength of schedule, the same way */
  let oppSum = 0, oppN = 0;
  feats.forEach((f, i) => {
    const expected = oppN >= FEATURES.MIN_SOS_SAMPLE ? Math.round((oppSum / oppN) * 1e3) / 1e3 : null;
    const got = f.sos_elo_pre == null ? null : Math.round(Number(f.sos_elo_pre) * 1e3) / 1e3;
    eq('match ' + (i + 1) + ': strength of schedule is over EARLIER opponents only', got, expected);
    oppSum += 1700 + i * 5; oppN += 1;
  });

  /* ── 2. THE DECISIVE TEST: a later match cannot change an earlier row ── */
  const beforeAll = rows(`select match_id, serve_strength_pre from tennis.player_match_features
                           where player_id = 'archive:ATP:1' order by match_date`);
  /* add a SEVENTH match, far in the future, with an absurd serve number */
  const extra = csvRow({
    tourney_id: 'TX', tourney_name: 'Future Event', surface: 'Hard', tourney_date: '2025-12-01',
    match_num: '1', tourney_level: 'A', best_of: '3', round: 'F', tour: 'ATP', source_year: '2025',
    winner_id: '1', winner_name: 'One Player', loser_id: '77', loser_name: 'Later Opp',
    score: '6-0 6-0', w_svpt: '100', w_1stIn: '90', w_1stWon: '90', w_2ndWon: '10',
    w_SvGms: '12', l_svpt: '100', l_1stIn: '40', l_1stWon: '20', l_2ndWon: '5', l_SvGms: '12',
    winner_elo_pre: '2000', loser_elo_pre: '1500', match_uid: 'ATP_TX_1_1_77', environment: 'Outdoor'
  });
  const file2 = path.join(tmp, 'later.csv');
  fs.writeFileSync(file2, HEADER.join(',') + '\n' + extra + '\n');
  chk('the later match imports', run('import_archive.js', ['--file', file2]).status === 0);
  chk('features rebuild', run('build_features.js', ['--commit']).status === 0);
  const afterAll = rows(`select match_id, serve_strength_pre from tennis.player_match_features
                          where player_id = 'archive:ATP:1' order by match_date`);
  const byId = {}; afterAll.forEach(x => { byId[x.match_id] = x.serve_strength_pre; });
  beforeAll.forEach((b) => eq('a FUTURE match did not change ' + b.match_id, byId[b.match_id], b.serve_strength_pre));
  chk('and the new match itself got the history that preceded it',
      byId[mid('TX', 77)] != null);

  /* ── 3. A CORRECTION PROPAGATES FORWARD, AND ONLY FORWARD ──────────── */
  /* rewrite match 3's serve numbers upstream and re-import */
  const corrected = csvRow({
    tourney_id: 'T2', tourney_name: 'Event 2', surface: 'Hard', tourney_date: '2024-01-03',
    match_num: '1', tourney_level: 'A', best_of: '3', round: 'R32', tour: 'ATP', source_year: '2024',
    winner_id: '1', winner_name: 'One Player', loser_id: '12', loser_name: 'Opp 2',
    score: '6-4 6-4', w_svpt: '100', w_1stIn: '60', w_1stWon: '10', w_2ndWon: '10',
    w_SvGms: '12', l_svpt: '100', l_1stIn: '55', l_1stWon: '35', l_2ndWon: '15', l_SvGms: '12',
    winner_elo_pre: '1820', loser_elo_pre: '1710', match_uid: 'ATP_T2_1_1_12', environment: 'Outdoor'
  });
  const file3 = path.join(tmp, 'correction.csv');
  fs.writeFileSync(file3, HEADER.join(',') + '\n' + corrected + '\n');
  const pre = {}; afterAll.forEach(x => { pre[x.match_id] = x.serve_strength_pre; });
  chk('the correction imports', run('import_archive.js', ['--file', file3]).status === 0);
  chk('features rebuild after the correction', run('build_features.js', ['--commit']).status === 0);
  const post = {};
  rows(`select match_id, serve_strength_pre from tennis.player_match_features
         where player_id = 'archive:ATP:1'`).forEach(x => { post[x.match_id] = x.serve_strength_pre; });
  eq('a match BEFORE the correction is untouched', post[mid('T0', 10)], pre[mid('T0', 10)]);
  eq('the corrected match itself is untouched (its own numbers are not its inputs)',
     post[mid('T2', 12)], pre[mid('T2', 12)]);
  chk('but a match AFTER the correction moved',
      post[mid('T5', 15)] !== pre[mid('T5', 15)],
      'before=' + pre[mid('T5', 15)] + ' after=' + post[mid('T5', 15)]);

  /* ── 4. STRUCTURAL: the feature table carries no post-match column ──── */
  const cols = rows(`select column_name from information_schema.columns
                      where table_schema='tennis' and table_name='player_match_features'`)
                .map(c => c.column_name);
  M.POST_MATCH_COLUMNS.forEach(c => {
    const lc = String(c).toLowerCase();
    chk('the feature table has no column named ' + c, cols.indexOf(lc) < 0);
  });
  ['w_ace', 'w_svpt', 'l_svpt', 'minutes', 'score', 'sets_played'].forEach(c =>
    chk('and specifically not ' + c, cols.indexOf(c) < 0));
  chk('every model input exists on the feature table',
      M.MODEL_INPUTS.every(k => cols.indexOf(k) >= 0),
      'missing: ' + M.MODEL_INPUTS.filter(k => cols.indexOf(k) < 0).join(', '));

  /* ── 5. A WALKOVER NEVER ENTERS TRAINING ───────────────────────────── */
  const wo = rows(`select count(*)::int as n from tennis.matches where walkover`);
  eq('the walkover is stored as a match', wo[0].n, 1);
  const trainSql = require('./build_model.js').loadSql(null);
  const train = rows(trainSql);
  chk('but it is excluded from the training set',
      train.every(t => t.match_id !== mid('TW', 99)), 'walkover present in training');
  chk('while every played match is present', train.length >= 6);
  chk('and the training query reads the feature table, not the match table\'s statistics',
      /player_match_features/.test(trainSql) && !/m\.w_svpt|m\.w_ace/.test(trainSql));

  /* ── 6. A MISSING INPUT IS NAMED, NOT ZEROED ───────────────────────── */
  const miss = rows(`select missing_fields, completeness from tennis.player_match_features
                      where player_id='archive:ATP:1' order by match_date limit 1`)[0];
  chk('the first match names what it lacks', Array.isArray(miss.missing_fields) && miss.missing_fields.length > 0);
  chk('and its completeness is below one', Number(miss.completeness) < 1);
  chk('serve strength is among the named gaps',
      (miss.missing_fields || []).indexOf('serve_strength_pre') >= 0, JSON.stringify(miss.missing_fields));

  if (fail) {
    console.log('FAIL | tennis feature leakage | ' + fail + ' of ' + (pass + fail) + ' assertions failed');
    failures.forEach(f => console.log('     | ' + f));
    code = 1;
  } else {
    console.log('PASS | tennis feature leakage | ' + pass + ' assertions against a real PostgreSQL');
  }
} catch (e) {
  console.error('harness error: ' + (e && e.stack || e));
  code = 1;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  drop();
}
process.exit(code);
