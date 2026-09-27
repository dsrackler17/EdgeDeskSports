#!/usr/bin/env node
/* ===========================================================================
   THE TENNIS RECORD WORKFLOW REFUSES AN EMPTY RECORD.

   WHAT THIS EXISTS TO CATCH. The preflight on .github/workflows/tennis-record.yml
   proves, exhaustively, that every relation the record jobs read exists and
   carries the columns this contract's own indexes stand on. It never asked
   whether a single match was on file — and on 2026-09-21 none was. The archive
   import is a one-off administrative act against a CC BY-NC-SA source
   (docs/runbooks/tennis-import.md) and had never been run against production.

   Against an installed-but-empty record, measured on a real PostgreSQL 16 with
   the live, record and lab contracts applied:

       build_features   exit 0    wrote nothing
       build_ratings    exit 0    "no rated players: the record is empty"
       build_history    exit 0    "no point-in-time features on file"
       build_lab        exit 0    "no rated players on file"
       build_brief      exit 0    "nothing on file to write about yet"
       build_model      exit 1    "only 0 usable matches"
       price_board      exit 1    "no ACTIVE tennis model is registered"

   Five of seven exit 0. So the nightly job reported SUCCESS over an empty
   record while board and weekly went red on two different late errors, neither
   naming the cause. That is this repository's recurring shape: the absence of
   a signal is indistinguishable from a passing one.

   The gate is shell inside a workflow, so what is checked here is the shell
   itself — extracted from the YAML and run against a real database — rather
   than a copy of it that could agree with itself while the workflow disagreed.

   Run: node tools/tennis/record_workflow.test.js
        (the database half needs PostgreSQL; CI runs it in games-sql.yml)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? ' — ' + String(detail).slice(0, 240) : '')); }
const eq = (name, got, want) => chk(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ROOT = path.join(__dirname, '..', '..');
const WF = fs.readFileSync(path.join(ROOT, '.github/workflows/tennis-record.yml'), 'utf8');

/* ---- 1. the step exists, and guards the right jobs ---------------------- */
chk('the workflow carries an empty-record gate', /- name: Refuse to run on an empty record/.test(WF));
chk('it runs in the preflight, before any build step',
  WF.indexOf('Refuse to run on an empty record') < WF.indexOf('\n  record:'),
  'the gate must be in the preflight job, not after the builds');
chk('it counts matches, not just relations',
  /select count\(\*\) from tennis\.matches/.test(WF));
chk('the monitor is exempt, because an empty record is what it reports',
  /!= "monitor"/.test(WF) || /"monitor"/.test(WF));
chk('the refusal names the runbook',
  /docs\/runbooks\/tennis-import\.md/.test(WF));
chk('and gives the import command rather than only the diagnosis',
  /tennis:record:import/.test(WF));
chk('it states that nothing was read or written',
  /Nothing was read and nothing was written/.test(WF));

/* THE COUNTS ARE PRINTED ON EVERY RUN. A gate that only speaks when it
   refuses leaves "how much is on file" as something to go and ask the
   database; the number belongs in the log of every run. */
chk('the counts are echoed unconditionally, not only on refusal',
  /echo "On file: \$\{MATCHES\}/.test(WF));

/* ---- 2. the shell itself, extracted and run ----------------------------- */
/* Lifted from the YAML so this cannot pass against a copy that has drifted. */
const stepIdx = WF.indexOf('- name: Refuse to run on an empty record');
const runIdx = WF.indexOf('run: |', stepIdx);
const body = WF.slice(runIdx + 'run: |'.length).split('\n')
  .slice(1)
  .reduce((acc, line) => {
    if (acc.done) return acc;
    if (line.trim() && !/^ {10}/.test(line)) { acc.done = true; return acc; }
    acc.lines.push(line.replace(/^ {10}/, ''));
    return acc;
  }, { lines: [], done: false }).lines.join('\n');

chk('the gate body was extracted from the YAML', body.includes('tennis.matches'), body.slice(0, 120));

/* ---- 2b. a database of its own, contracts applied ----------------------
   Same shape as record_sql.test.js: resolve a server the way every other
   tennis SQL suite does (EDGD_PG first, which is what games-sql.yml sets —
   keying off PGHOST alone would have made this suite skip in the one place it
   most needs to run), create a database, apply the contracts, and drop it. */
const cp = require('child_process');
const DBNAME = 'edgedesk_tennis_wfgate_test';
const have = (b) => cp.spawnSync('sh', ['-c', 'command -v ' + b], { encoding: 'utf8' }).status === 0;
const psql = (conn, args, o) => cp.spawnSync('psql', conn.concat(args), Object.assign({ encoding: 'utf8' }, o || {}));

function candidates() {
  const out = [];
  if (process.env.EDGD_PG) out.push(process.env.EDGD_PG.split(' '));
  if (process.env.PGHOST) out.push([]);
  out.push(['-h', '/var/tmp/edgpg/sock', '-p', '5433', '-U', 'postgres']);
  out.push(['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres']);
  out.push([]);
  return out;
}
function skip(why) {
  report('SKIP | the database half | ' + why + '\n       (needs PostgreSQL; CI runs it in games-sql.yml)');
}
if (!have('psql')) skip('psql is not installed');
let conn = null;
for (const c of candidates()) { if (psql(c, ['-d', 'postgres', '-tAc', 'select 1']).status === 0) { conn = c; break; } }
if (!conn) skip('no reachable PostgreSQL server');

/* The gate runs `psql "$SUPABASE_DB_URL"`. An empty conninfo makes psql read
   the environment, so the resolved connection is handed over as PG* rather
   than reassembled into a URL — which would have to special-case a socket
   directory and would be one more thing to get wrong. */
const envOf = (c) => {
  const e = { SUPABASE_DB_URL: '', PGDATABASE: DBNAME };
  for (let i = 0; i < c.length; i += 2) {
    if (c[i] === '-h') e.PGHOST = c[i + 1];
    else if (c[i] === '-p') e.PGPORT = c[i + 1];
    else if (c[i] === '-U') e.PGUSER = c[i + 1];
  }
  return e;
};

function drop() { psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DBNAME + ' (force)']); }
drop();
if (psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DBNAME]).status !== 0) skip('could not create the test database');
process.on('exit', drop);

for (const f of ['tennis_live_center', 'tennis_player_directory', 'tennis_record', 'tennis_lab']) {
  const r = psql(conn, ['-d', DBNAME, '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(ROOT, 'supabase', f + '.sql')]);
  if (r.status !== 0) skip('could not apply supabase/' + f + '.sql: ' + String(r.stderr || '').slice(0, 160));
}

function runGate(job) {
  const script = body.replace(/\$\{\{ steps\.pick\.outputs\.job \}\}/g, job);
  try {
    const out = cp.execFileSync('bash', ['-c', script], {
      env: Object.assign({}, process.env, envOf(conn)),
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

/* A freshly applied contract holds no matches — which IS the production
   condition this gate exists for, not a contrived one. */
const empty = runGate('nightly');
eq('an empty record refuses a nightly run', empty.code, 1);
chk('and says the record is EMPTY rather than printing a raw error',
  /the tennis record is EMPTY/.test(empty.out), empty.out.slice(-300));
chk('it separates "never loaded" from "installed wrong"',
  /never been loaded/.test(empty.out), empty.out.slice(-300));
chk('it prints the counts even while refusing',
  /On file: 0 match\(es\)/.test(empty.out), empty.out.slice(0, 200));
chk('and hands over the import command',
  /tennis:record:import/.test(empty.out), empty.out.slice(-400));

const mon = runGate('monitor');
eq('the monitor is allowed to run on an empty record', mon.code, 0);
chk('and is warned that the record is empty', /record is empty/i.test(mon.out), mon.out.slice(-200));

/* ONE MATCH IS ENOUGH TO PASS. The gate is a floor, not a quality bar: it
   refuses a record nothing can be derived from and gets out of the way the
   moment there is something. */
const seed = psql(conn, ['-d', DBNAME, '-q', '-c', `
  insert into tennis.players (player_id,source_player_id,tour,full_name,name_norm)
    values ('wta:1','sp1','WTA','A B','a b'),('wta:2','sp2','WTA','C D','c d') on conflict do nothing;
  insert into tennis.tournaments (tournament_id,provider_tournament_id,tour,provider,name,start_date,surface)
    values ('wta:t1','pt1','WTA','test','T','2026-01-01','hard') on conflict do nothing;
  insert into tennis.matches (match_id,tour,match_date,season,tournament_id,source_tourney_id,match_num,
                              winner_id,loser_id,surface,round_order,source_match_uid)
    values ('wta:m1','WTA','2026-01-02',2026,'wta:t1','st1',1,'wta:1','wta:2','hard',1,'u1') on conflict do nothing;`]);
chk('a match can be seeded', seed.status === 0, String(seed.stderr || '').slice(0, 200));
const seeded = runGate('nightly');
eq('a record with a match on file is allowed through', seeded.code, 0);
chk('and the counts say so', /On file: 1 match\(es\)/.test(seeded.out), seeded.out.slice(0, 200));

report();

function report(note) {
  failures.forEach(f => console.log('  FAIL  ' + f));
  if (note) console.log(note);
  console.log((fail === 0 ? 'PASS | ' : 'FAILED | ') + 'tennis record workflow gate | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
