#!/usr/bin/env node
/* ===========================================================================
   The archive importer, driven end to end against a real PostgreSQL.

   An importer is only trustworthy if it can be re-run, interrupted, and fed a
   correction — so those are what this drives:

     RECONCILIATION   every source row is accounted for as accepted, rejected
                      or filtered, and a run that cannot account for one FAILS
     DUPLICATE        the same file imported twice produces the same row counts
     CORRECTION       a corrected result UPDATES the match it corrects
     RESUME           a run killed mid-file continues from the chunk after the
                      last committed one, and lands the same rows as an
                      uninterrupted run
     QUARANTINE       a malformed row is stored with its reason, not dropped
     LICENCE          an unregistered source is refused before a byte is read
     FILTERS          --tour and --season restrict what is imported without
                      breaking the reconciliation over the FILE
     DRY RUN          writes nothing at all

     MULTI-PART       a dataset that arrives in numbered parts is verified
                      against its manifest by CHECKSUM before anything is read,
                      and a missing or altered part refuses the whole import.
                      This is the one failure the importer cannot catch
                      afterwards: 13 of 14 parts imports cleanly, reconciles,
                      and leaves the record permanently short.

   Run: node tools/tennis/import.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const M = require(path.join(__dirname, '..', '..', 'lib', 'tennis_model.js'));

const ROOT = path.join(__dirname, '..', '..');
const DB = 'edgedesk_tennis_import_test';

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
  console.log('SKIP | tennis importer | ' + why);
  console.log('       (this suite needs PostgreSQL; CI runs it in games-sql.yml)');
  process.exit(0);
}
if (!have('psql')) skip('psql is not installed');
let conn = null;
for (const c of candidates()) { if (psql(c, ['-d', 'postgres', '-tAc', 'select 1']).status === 0) { conn = c; break; } }
if (!conn) skip('no reachable PostgreSQL server');
const PGARG = conn.join(' ');

function drop() { psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']); }
function q(sql) { return psql(conn, ['-d', DB, '-tA', '-c', sql]).stdout.trim(); }
function n(sql) { return Number(q(sql) || 0); }

function runImport(args, env) {
  return cp.spawnSync('node', [path.join(ROOT, 'tools', 'tennis', 'import_archive.js'), '--database', DB].concat(args), {
    encoding: 'utf8', cwd: ROOT, maxBuffer: 32 * 1024 * 1024,
    env: Object.assign({}, process.env, { EDGD_PG: PGARG }, env || {})
  });
}

/* ── a small, deliberately awkward source file ────────────────────────── */
const HEADER = ['tourney_id','tourney_name','surface','draw_size','tourney_level','tourney_date','match_num',
  'winner_id','winner_seed','winner_entry','winner_name','winner_hand','winner_ht','winner_ioc','winner_age',
  'loser_id','loser_seed','loser_entry','loser_name','loser_hand','loser_ht','loser_ioc','loser_age',
  'score','best_of','round','minutes','w_ace','w_df','w_svpt','w_1stIn','w_1stWon','w_2ndWon','w_SvGms',
  'w_bpSaved','w_bpFaced','l_ace','l_df','l_svpt','l_1stIn','l_1stWon','l_2ndWon','l_SvGms','l_bpSaved',
  'l_bpFaced','winner_rank','winner_rank_points','loser_rank','loser_rank_points','tour','source_year',
  'winner_elo_pre','winner_surface_elo_pre','winner_win_pct_30d_pre','winner_win_pct_90d_pre',
  'winner_win_pct_365d_pre','winner_matches_7d_pre','winner_matches_14d_pre','winner_rest_days_pre',
  'winner_career_surface_win_pct_pre','winner_career_surface_matches_pre','loser_elo_pre','loser_surface_elo_pre',
  'loser_win_pct_30d_pre','loser_win_pct_90d_pre','loser_win_pct_365d_pre','loser_matches_7d_pre',
  'loser_matches_14d_pre','loser_rest_days_pre','loser_career_surface_win_pct_pre','loser_career_surface_matches_pre',
  'winner_ace_rate','winner_double_fault_rate','winner_first_serve_in_pct','winner_first_serve_won_pct',
  'winner_second_serve_won_pct','winner_break_points_saved_pct','loser_ace_rate','loser_double_fault_rate',
  'loser_first_serve_in_pct','loser_first_serve_won_pct','loser_second_serve_won_pct','loser_break_points_saved_pct',
  'elo_prob_winner_pre','surface_elo_prob_winner_pre','weather_query','venue_name','venue_country','latitude',
  'longitude','timezone','geocode_confidence','environment','event_end_date','weather_temp_mean_f',
  'weather_temp_max_f','weather_temp_min_f','weather_humidity_mean_pct','weather_precip_week_in',
  'weather_wind_mean_mph','weather_gust_max_mph','weather_solar_week_mj_m2','weather_days_covered',
  'weather_precision','match_uid','surface_group','data_source','weather_source'];

function row(over) {
  const o = Object.assign({
    tourney_id: '2024-1', tourney_name: 'Test Open', surface: 'Clay', draw_size: '32',
    tourney_level: 'A', tourney_date: '2024-05-06', match_num: '1',
    winner_id: '100', winner_name: 'Alpha Player', winner_hand: 'R', winner_ht: '185', winner_ioc: 'ESP', winner_age: '26.4',
    loser_id: '200', loser_name: 'Beta Player', loser_hand: 'L', loser_ht: '190', loser_ioc: 'FRA', loser_age: '24.1',
    score: '6-4 6-3', best_of: '3', round: 'R32', minutes: '95',
    w_ace: '5', w_df: '2', w_svpt: '70', w_1stIn: '45', w_1stWon: '33', w_2ndWon: '15', w_SvGms: '11',
    w_bpSaved: '2', w_bpFaced: '3', l_ace: '3', l_df: '4', l_svpt: '72', l_1stIn: '40', l_1stWon: '28',
    l_2ndWon: '16', l_SvGms: '10', l_bpSaved: '3', l_bpFaced: '6',
    winner_rank: '12', winner_rank_points: '2200', loser_rank: '30', loser_rank_points: '1400',
    tour: 'ATP', source_year: '2024',
    winner_elo_pre: '1850', winner_surface_elo_pre: '1880', winner_win_pct_90d_pre: '0.7',
    winner_win_pct_365d_pre: '0.65', winner_matches_7d_pre: '1', winner_matches_14d_pre: '3',
    winner_rest_days_pre: '4', winner_career_surface_win_pct_pre: '0.62', winner_career_surface_matches_pre: '150',
    loser_elo_pre: '1790', loser_surface_elo_pre: '1770', loser_win_pct_90d_pre: '0.55',
    loser_win_pct_365d_pre: '0.58', loser_matches_7d_pre: '0', loser_matches_14d_pre: '2',
    loser_rest_days_pre: '7', loser_career_surface_win_pct_pre: '0.51', loser_career_surface_matches_pre: '95',
    environment: 'Outdoor', venue_name: 'Test Court', venue_country: 'Spain',
    latitude: '40.4', longitude: '-3.7', timezone: 'Europe/Madrid', geocode_confidence: 'name_inferred',
    event_end_date: '2024-05-12', weather_temp_mean_f: '72', weather_days_covered: '7',
    weather_precision: 'week', surface_group: 'Clay', data_source: 'test',
    match_uid: 'ATP_2024-1_1_100_200'
  }, over || {});
  return HEADER.map((h) => (o[h] == null ? '' : String(o[h]))).join(',');
}
function writeFile(dir, name, rows) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, HEADER.join(',') + '\n' + rows.join('\n') + '\n');
  return f;
}

drop();
if (psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]).status !== 0) skip('could not create the test database');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edgd-import-test-'));
let code = 0;
try {
  psql(conn, ['-d', DB, '-q', '-c', 'create extension if not exists pgcrypto']);
  for (const f of ['tools/games/sql/supabase_shim.sql', 'supabase/tennis_live_center.sql', 'supabase/tennis_record.sql']) {
    const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', path.join(ROOT, f)]);
    if (r.status !== 0) { console.error((r.stderr || '').split('\n').slice(0, 8).join('\n')); throw new Error('setup: ' + f); }
  }

  /* ── 1. A CLEAN IMPORT, RECONCILED ──────────────────────────────────── */
  const clean = writeFile(tmp, 'clean.csv', [
    row({ match_num: '1', winner_id: '100', loser_id: '200', match_uid: 'ATP_2024-1_1_100_200' }),
    row({ match_num: '2', winner_id: '200', loser_id: '300', loser_name: 'Gamma Player', match_uid: 'ATP_2024-1_2_200_300' }),
    row({ match_num: '3', winner_id: '100', loser_id: '300', loser_name: 'Gamma Player', match_uid: 'ATP_2024-1_3_100_300' }),
    row({ tour: 'WTA', match_num: '1', winner_id: '500', winner_name: 'Delta Player',
          loser_id: '600', loser_name: 'Epsilon Player', tourney_date: '2025-06-03',
          match_uid: 'WTA_2024-1_1_500_600' })
  ]);
  let r = runImport(['--file', clean, '--chunk', '2']);
  eq('a clean import exits 0', r.status, 0);
  chk('and says it reconciled', /RECONCILED/.test(r.stdout), r.stdout.slice(-400));
  eq('four matches land', n('select count(*) from tennis.matches'), 4);
  eq('five distinct players land', n('select count(*) from tennis.players'), 5);
  eq('two feature rows per match', n('select count(*) from tennis.player_match_features'), 8);
  eq('both tours are present', n("select count(distinct tour) from tennis.matches"), 2);
  eq('the tournament is filed under the archive provider',
     n("select count(*) from tennis.tournaments where provider='archive'"), 2);
  eq('a venue is resolved', n('select count(*) from tennis.venues'), 1);
  eq('and a weather row is attached to it', n('select count(*) from tennis.weather_observations'), 2);
  eq('the run is recorded as ok and reconciled',
     q("select status||'/'||reconciled from tennis.ingestion_runs where job='archive_import' order by started_at desc limit 1"),
     'ok/true');
  eq('the source checksum is stored', n("select count(*) from tennis.ingestion_runs where source_checksum is not null"), 1);
  eq('a ranking snapshot is derived', n('select count(*) from tennis.rankings_current') > 0, true);
  chk('and it is labelled as the latest rank on file, not this week\'s list',
      /not this week/.test(r.stdout));

  /* every accepted row is in staging too, with its provenance */
  eq('staging holds every source row read', n('select count(*) from tennis.stg_archive_matches'), 4);
  eq('and none of them is marked rejected', n('select count(*) from tennis.stg_archive_matches where reject_reason is not null'), 0);

  /* ── 2. DUPLICATE IMPORT ────────────────────────────────────────────── */
  const before = q("select (select count(*) from tennis.matches)||'/'||(select count(*) from tennis.players)||'/'||(select count(*) from tennis.player_match_features)");
  r = runImport(['--file', clean, '--chunk', '3']);
  eq('a second import of the same file exits 0', r.status, 0);
  const after = q("select (select count(*) from tennis.matches)||'/'||(select count(*) from tennis.players)||'/'||(select count(*) from tennis.player_match_features)");
  eq('and creates no duplicate rows anywhere', after, before);

  /* ── 3. A CORRECTION ────────────────────────────────────────────────── */
  const fixed = writeFile(tmp, 'corrected.csv', [
    /* same draw slot, winner and loser swapped upstream, new source uid */
    row({ match_num: '1', winner_id: '200', winner_name: 'Beta Player', loser_id: '100',
          loser_name: 'Alpha Player', score: '4-6 6-3 6-2', match_uid: 'ATP_2024-1_1_200_100' })
  ]);
  r = runImport(['--file', fixed]);
  eq('a corrected file imports', r.status, 0);
  eq('and does NOT create a second match for the same draw slot', n('select count(*) from tennis.matches'), 4);

  /* The id is DERIVED, not spelled out. Pinning the literal made this suite
     fail when the identity key legitimately gained the unordered player pair —
     a change that fixed 16 real matches being silently overwritten — even
     though the property under test (a correction updates the match it corrects)
     was never broken. The property is what matters; the string is an
     implementation detail of matchKey. */
  const MID = M.matchKey('ATP', '2024-1', 1, 'archive', '100', '200');
  eq('a correction maps to the SAME id as the original — the pair is unordered',
     MID, M.matchKey('ATP', '2024-1', 1, 'archive', '200', '100'));
  eq('the correction took', q("select winner_id from tennis.matches where match_id='" + MID + "'"), 'archive:ATP:200');
  eq('the score was corrected too', q("select score from tennis.matches where match_id='" + MID + "'"), '4-6 6-3 6-2');
  eq('and the new source uid is kept as provenance',
     q("select source_match_uid from tennis.matches where match_id='" + MID + "'"), 'ATP_2024-1_1_200_100');
  eq('the feature rows followed the correction',
     q("select player_role from tennis.player_match_features where match_id='" + MID + "' and player_id='archive:ATP:200'"),
     'winner');

  /* ── 4. QUARANTINE ──────────────────────────────────────────────────── */
  const dirty = writeFile(tmp, 'dirty.csv', [
    row({ match_num: '10', winner_id: '', match_uid: 'bad1' }),                       // no winner
    row({ match_num: '11', tourney_date: 'not a date', match_uid: 'bad2' }),          // unparseable date
    row({ match_num: '12', winner_id: '700', loser_id: '700', match_uid: 'bad3' }),   // same player both sides
    row({ match_num: '13', winner_id: '800', winner_name: 'Zeta', loser_id: '900',
          loser_name: 'Eta', winner_ht: '71', match_uid: 'ok1' })                     // odd but importable
  ]);
  r = runImport(['--file', dirty]);
  eq('a file with malformed rows still exits 0', r.status, 0);
  chk('and reconciles', /RECONCILED/.test(r.stdout));
  chk('three rows are rejected', /rejected \(quarantined\)\s+3/.test(r.stdout), r.stdout.slice(-700));
  eq('the good row landed', n("select count(*) from tennis.matches where match_num=13"), 1);
  eq('the rejected rows are KEPT in staging with a reason',
     n("select count(*) from tennis.stg_archive_matches where reject_reason is not null"), 3);
  eq('nothing malformed reached the match table', n('select count(*) from tennis.matches'), 5);
  eq('the implausible height became absent rather than entering the record',
     q("select coalesce(height_cm::text,'null') from tennis.players where source_player_id='800'"), 'null');
  chk('and the data-quality table records what was wrong',
      n("select count(*) from tennis.data_quality_issues where issue_type in ('malformed_record','impossible_statistic')") > 0);

  /* ── 5. FILTERS ─────────────────────────────────────────────────────── */
  psql(conn, ['-d', DB, '-q', '-c', 'truncate tennis.stg_archive_matches cascade']);
  r = runImport(['--file', clean, '--tour', 'WTA']);
  eq('a tour filter exits 0', r.status, 0);
  chk('the filtered rows are counted as SKIPPED, not lost', /skipped by filter\s+3/.test(r.stdout), r.stdout.slice(-600));
  chk('and the run still reconciles over the whole file', /RECONCILED/.test(r.stdout));
  r = runImport(['--file', clean, '--season', '2025']);
  chk('a season filter reconciles too', /RECONCILED/.test(r.stdout));

  /* ── 6. DRY RUN WRITES NOTHING ──────────────────────────────────────── */
  const runsBefore = n('select count(*) from tennis.ingestion_runs');
  const matchesBefore = n('select count(*) from tennis.matches');
  r = runImport(['--file', clean, '--dry-run']);
  eq('a dry run exits 0', r.status, 0);
  chk('and says so plainly', /DRY RUN/.test(r.stdout));
  eq('it writes no match', n('select count(*) from tennis.matches'), matchesBefore);
  eq('and does not even open a run', n('select count(*) from tennis.ingestion_runs'), runsBefore);

  /* ── 7. RESUME ──────────────────────────────────────────────────────── */
  psql(conn, ['-d', DB, '-q', '-c',
    "delete from tennis.player_match_features; delete from tennis.matches; delete from tennis.rankings_current; " +
    "delete from tennis.weather_observations; delete from tennis.players; delete from tennis.venues; " +
    "delete from tennis.tournaments where provider='archive'; " +
    "delete from tennis.stg_archive_matches; delete from tennis.data_quality_issues; delete from tennis.ingestion_runs"]);
  const many = writeFile(tmp, 'many.csv', Array.from({ length: 20 }, (_, i) =>
    row({ match_num: String(100 + i), winner_id: String(1000 + i), winner_name: 'W' + i,
          loser_id: String(2000 + i), loser_name: 'L' + i, match_uid: 'u' + i })));
  /* an INTERRUPTED run: import the first two chunks only, then leave the run open */
  r = runImport(['--file', many, '--chunk', '5', '--limit', '10']);
  eq('a partial import exits 0', r.status, 0);
  const partial = n('select count(*) from tennis.matches');
  chk('a partial import landed some matches', partial > 0 && partial < 20, 'landed ' + partial);
  /* mark the run as still running, which is what a killed process leaves behind */
  psql(conn, ['-d', DB, '-q', '-c',
    "update tennis.ingestion_runs set status='running', finished_at=null where job='archive_import'"]);
  const lastChunk = q("select details->>'last_chunk' from tennis.ingestion_runs where job='archive_import' order by started_at desc limit 1");
  chk('the interrupted run recorded which chunk it reached', lastChunk !== '' && lastChunk != null, 'last_chunk=' + lastChunk);
  r = runImport(['--file', many, '--chunk', '5', '--resume']);
  eq('the resumed run exits 0', r.status, 0);
  chk('and says it is resuming a specific run', /resuming\s+: run /.test(r.stdout), r.stdout.slice(0, 900));
  eq('the resumed run lands every match in the file', n('select count(*) from tennis.matches'), 20);
  eq('and the same number as an uninterrupted run would',
     n('select count(*) from tennis.player_match_features'), 40);

  /* a resume over DIFFERENT bytes must not continue into the wrong run */
  r = runImport(['--file', clean, '--resume']);
  chk('resuming over a different file starts a new run instead',
      /no unfinished run over these bytes/.test(r.stdout), r.stdout.slice(0, 700));

  /* ── 8. THE LICENCE GATE, BEFORE A BYTE IS READ ─────────────────────── */
  r = runImport(['--file', clean, '--source-key', 'not_registered']);
  eq('an unregistered source fails', r.status, 1);
  chk('and says why, naming the table to fix it in',
      /not registered in tennis.source_licenses/.test(r.stderr + r.stdout));
  r = runImport(['--file', clean, '--dry-run']);
  chk('a registered non-commercial source is announced as such',
      /NON-COMMERCIAL: research only/.test(r.stdout));

  /* ── 9. A SOURCE THAT CHANGED SHAPE FAILS LOUDLY ────────────────────── */
  const short = path.join(tmp, 'short.csv');
  fs.writeFileSync(short, 'tourney_id,tourney_name\n2024-1,Test\n');
  r = runImport(['--file', short]);
  eq('a file missing required columns fails', r.status, 1);
  chk('and names the missing columns', /missing required columns/.test(r.stderr + r.stdout));

  /* ── 10. A MULTI-PART DATASET IS WHOLE OR IT IS NOTHING ─────────────── */
  /* This is the failure the manifest exists to catch, and the one the importer
     cannot catch on its own: importing 2 of 3 parts SUCCEEDS, every total
     reconciles against what was read, and the record is permanently short with
     nothing downstream ever saying so. */
  const V = require('./verify_parts.js');
  const partDir = path.join(tmp, 'parts');
  fs.mkdirSync(partDir, { recursive: true });
  const partRows = [
    [row({ tourney_id: 'P1', match_num: '1', winner_id: '9001', winner_name: 'PA', loser_id: '9002', loser_name: 'PB', match_uid: 'p1a' }),
     row({ tourney_id: 'P1', match_num: '2', winner_id: '9002', winner_name: 'PB', loser_id: '9003', loser_name: 'PC', match_uid: 'p1b' })],
    [row({ tourney_id: 'P2', match_num: '1', winner_id: '9004', winner_name: 'PD', loser_id: '9005', loser_name: 'PE', match_uid: 'p2a' })],
    [row({ tourney_id: 'P3', match_num: '1', tour: 'WTA', winner_id: '9006', winner_name: 'PF', loser_id: '9007', loser_name: 'PG', match_uid: 'p3a' })]
  ];
  const zlib = require('zlib');
  const crypto2 = require('crypto');
  const manFiles = [];
  partRows.forEach((rows, i) => {
    const name = `0${i + 1}_part.csv.gz`;
    const buf = zlib.gzipSync(Buffer.from(HEADER.join(',') + '\n' + rows.join('\n') + '\n'));
    fs.writeFileSync(path.join(partDir, name), buf);
    manFiles.push({ part: i + 1, file: name, tour: i === 2 ? 'WTA' : 'ATP', years: '2024-2024',
      rows: rows.length, columns: HEADER.length, bytes: buf.length,
      sha256: crypto2.createHash('sha256').update(buf).digest('hex') });
  });
  const manPath = path.join(tmp, 'manifest.json');
  const totalRows = manFiles.reduce((a, f) => a + f.rows, 0);
  fs.writeFileSync(manPath, JSON.stringify({ parts: 3, rows: totalRows, files: manFiles }, null, 1));

  /* the verifier, on a complete set */
  let vr = cp.spawnSync('node', [path.join(ROOT, 'tools', 'tennis', 'verify_parts.js'),
    '--manifest', manPath, '--dir', partDir, '--json'], { encoding: 'utf8', cwd: ROOT });
  eq('the verifier passes a complete set', vr.status, 0);
  let vj = JSON.parse(vr.stdout);
  eq('and marks it verified', vj.verified, true);
  eq('with every part present', vj.present, 3);
  eq('and the rows reconciling to the manifest', vj.counted_rows, totalRows);
  eq('and one column order across all parts', vj.schema_consistent, true);

  /* a duplicate upload of the same bytes is harmless and is SAID to be */
  fs.copyFileSync(path.join(partDir, '01_part.csv.gz'), path.join(partDir, 'copy-of-01_part.csv.gz'));
  vr = cp.spawnSync('node', [path.join(ROOT, 'tools', 'tennis', 'verify_parts.js'),
    '--manifest', manPath, '--dir', partDir, '--json'], { encoding: 'utf8', cwd: ROOT });
  vj = JSON.parse(vr.stdout);
  eq('a duplicate upload still verifies', vj.verified, true);
  chk('and is reported as a duplicate rather than as an extra part', vj.duplicates.length === 1);
  eq('and is not counted twice', vj.counted_rows, totalRows);
  fs.unlinkSync(path.join(partDir, 'copy-of-01_part.csv.gz'));

  /* THE IMPORT: complete set lands as ONE run */
  psql(conn, ['-d', DB, '-q', '-c',
    "delete from tennis.player_match_features; delete from tennis.matches; delete from tennis.rankings_current; " +
    "delete from tennis.weather_observations; delete from tennis.players; delete from tennis.venues; " +
    "delete from tennis.tournaments where provider='archive'; delete from tennis.stg_archive_matches; " +
    "delete from tennis.data_quality_issues; delete from tennis.ingestion_runs"]);
  r = runImport(['--manifest', manPath, '--dir', partDir]);
  eq('a complete multi-part dataset imports', r.status, 0);
  chk('and reconciles against the MANIFEST, not just against what it read',
      /matches the manifest\s+yes/.test(r.stdout), r.stdout.slice(-900));
  eq('every part\'s rows land', n('select count(*) from tennis.matches'), totalRows);
  eq('as ONE ingestion run, not three', n("select count(*) from tennis.ingestion_runs where job='archive_import'"), 1);
  eq('and that run is reconciled', q("select reconciled::text from tennis.ingestion_runs limit 1"), 'true');
  eq('both tours landed', n('select count(distinct tour) from tennis.matches'), 2);

  /* re-importing the whole dataset is still idempotent */
  const mpBefore = n('select count(*) from tennis.matches');
  r = runImport(['--manifest', manPath, '--dir', partDir]);
  eq('a second multi-part import exits 0', r.status, 0);
  eq('and creates no duplicates', n('select count(*) from tennis.matches'), mpBefore);

  /* ── AND NOW THE ONE THAT MATTERS ──────────────────────────────────── */
  const hidden = path.join(tmp, 'hidden-02.csv.gz');
  fs.renameSync(path.join(partDir, '02_part.csv.gz'), hidden);
  vr = cp.spawnSync('node', [path.join(ROOT, 'tools', 'tennis', 'verify_parts.js'),
    '--manifest', manPath, '--dir', partDir], { encoding: 'utf8', cwd: ROOT });
  eq('the verifier FAILS when a part is missing', vr.status, 1);
  chk('and names the exact file', /02_part\.csv\.gz/.test(vr.stdout), vr.stdout.slice(-400));
  chk('and its checksum, so the right file can be found',
      vr.stdout.indexOf(manFiles[1].sha256) >= 0);
  chk('and says why a partial import would be worse than a failed one',
      /permanently missing/.test(vr.stdout));

  const beforeRefusal = n('select count(*) from tennis.matches');
  const runsBeforeRefusal = n('select count(*) from tennis.ingestion_runs');
  r = runImport(['--manifest', manPath, '--dir', partDir]);
  eq('THE IMPORTER REFUSES a partial dataset', r.status, 1);
  chk('and names the missing part rather than a count', /02_part\.csv\.gz/.test(r.stdout + r.stderr));
  chk('and says nothing was imported', /Nothing was imported/.test(r.stdout + r.stderr));
  eq('not one row was written', n('select count(*) from tennis.matches'), beforeRefusal);
  eq('and no run was even opened', n('select count(*) from tennis.ingestion_runs'), runsBeforeRefusal);

  /* a part that is PRESENT but altered is a different, louder failure */
  fs.renameSync(hidden, path.join(partDir, '02_part.csv.gz'));
  const good02 = fs.readFileSync(path.join(partDir, '02_part.csv.gz'));
  fs.writeFileSync(path.join(partDir, '02_part.csv.gz'),
    zlib.gzipSync(Buffer.from(HEADER.join(',') + '\n' +
      row({ tourney_id: 'P2', match_num: '1', winner_id: '9004', winner_name: 'PD',
            loser_id: '9005', loser_name: 'PE', match_uid: 'p2a' }) + '\n' +
      row({ tourney_id: 'P2', match_num: '2', winner_id: '9004', winner_name: 'PD',
            loser_id: '9008', loser_name: 'PH', match_uid: 'p2b' }) + '\n')));
  vr = cp.spawnSync('node', [path.join(ROOT, 'tools', 'tennis', 'verify_parts.js'),
    '--manifest', manPath, '--dir', partDir], { encoding: 'utf8', cwd: ROOT });
  eq('an ALTERED part fails verification too', vr.status, 1);
  chk('and is reported as corrupt rather than missing',
      /CORRUPT|does not match the manifest/.test(vr.stdout), vr.stdout.slice(-500));
  r = runImport(['--manifest', manPath, '--dir', partDir]);
  eq('and the importer refuses it', r.status, 1);
  fs.writeFileSync(path.join(partDir, '02_part.csv.gz'), good02);

  /* a dry run over a complete set verifies and writes nothing */
  const dryBefore = n('select count(*) from tennis.ingestion_runs');
  r = runImport(['--manifest', manPath, '--dir', partDir, '--dry-run']);
  eq('a multi-part dry run exits 0', r.status, 0);
  chk('and says the manifest verifies', /all parts present and intact/.test(r.stdout));
  eq('and opens no run', n('select count(*) from tennis.ingestion_runs'), dryBefore);

  /* ── 10b. TWO DIFFERENT MATCHES IN ONE DRAW SLOT ──────────────────────
     The real archive has 16 of these: five WTA events restart match_num inside
     one tourney_id. Under the old slot-only key the second silently replaced
     the first and the matches vanished while every total still reconciled. */
  const collide = writeFile(tmp, 'collision.csv', [
    row({ match_num: '77', winner_id: '300', winner_name: 'Gamma P', loser_id: '400',
          loser_name: 'Delta P', match_uid: 'ATP_2024-1_77_300_400' }),
    row({ match_num: '77', winner_id: '500', winner_name: 'Epsilon P', loser_id: '600',
          loser_name: 'Zeta P', match_uid: 'ATP_2024-1_77_500_600' })
  ]);
  const beforeCollide = n('select count(*) from tennis.matches');
  r = runImport(['--file', collide]);
  eq('a file with two DIFFERENT matches in one draw slot imports', r.status, 0);
  eq('and BOTH are stored — neither overwrites the other',
     n('select count(*) from tennis.matches') - beforeCollide, 2);
  eq('and they share the draw slot',
     n("select count(*) from tennis.matches where source_tourney_id='2024-1' and match_num=77"), 2);

  /* ── 11. NO CONTRACT, NO IMPORT ─────────────────────────────────────── */
  const DB2 = DB + '_bare';
  psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB2 + ' (force)']);
  psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB2]);
  try {
    r = cp.spawnSync('node', [path.join(ROOT, 'tools', 'tennis', 'import_archive.js'),
      '--database', DB2, '--file', clean], {
      encoding: 'utf8', cwd: ROOT, env: Object.assign({}, process.env, { EDGD_PG: PGARG }) });
    eq('a database without the contract refuses the import', r.status, 1);
    chk('and names the migration to run', /tennis_record\.sql/.test(r.stderr + r.stdout));
  } finally {
    psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB2 + ' (force)']);
  }

  if (fail) {
    console.log('FAIL | tennis importer | ' + fail + ' of ' + (pass + fail) + ' assertions failed');
    failures.forEach(f => console.log('     | ' + f));
    code = 1;
  } else {
    console.log('PASS | tennis importer | ' + pass + ' assertions against a real PostgreSQL');
  }
} catch (e) {
  console.error('harness error: ' + (e && e.stack || e));
  code = 1;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  drop();
}
process.exit(code);
